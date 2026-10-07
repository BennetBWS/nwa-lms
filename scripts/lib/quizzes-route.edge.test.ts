import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { installFakeAuth, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #32 確認テストの API の補強（quizzes-route.test.ts の続き）：
// - 応答 JSON に出てよい項目を「許可リスト」で検査する（正解・回答・他人の記録が混ざらない）
// - 自分の受験が他人の一覧・1 件の集計に入らない（RLS の代わりに where userId で守る）
// - 回答の検証の境界（-0・Infinity・入れ子・__proto__・length を持つオブジェクト・真偽値）
// - 失敗の応答（400 / 404 / 409 / 503）でログを出さない、503 は body を読まない
// DB・ネットワークなし。prisma は globalThis.prisma に置く小さな偽物。データはすべてダミー（example.com）。

type Row = Record<string, unknown>;
type Select = Record<string, unknown>;
type Call = { method: string; args: Row };

const STUDENT = STUDENT_SESSION!.user!.id as string;
const OTHER = "stu_other_edge";
const OTHER_SESSION: FakeSession = { user: { id: OTHER, role: "STUDENT" } };
const BASE = Date.parse("2026-10-07T12:00:00.000Z");

let session: FakeSession;
let calls: Call[];
let db: { courses: Row[]; sections: Row[]; lessons: Row[]; progress: Row[]; quizzes: Row[]; questions: Row[]; attempts: Row[] };

let LIST: () => Promise<Response>;
let GET_ONE: (req: Request, ctx: { params: Promise<{ quizId: string }> }) => Promise<Response>;
let SUBMIT: (req: Request, ctx: { params: Promise<{ quizId: string }> }) => Promise<Response>;
let HANDLE_SUBMIT: (
  userId: string,
  req: Request,
  ctx: { params: Promise<{ quizId: string }> },
  opts: { attemptsEnabled: boolean }
) => Promise<Response>;

// ───────────── 偽 prisma（where は値の一致だけ、select は入れ子のリレーションまで） ─────────────

type Relation = { model: string; many: boolean; rows: (parent: Row) => Row[] };
const RELATIONS: Record<string, Record<string, Relation>> = {
  course: { sections: { model: "section", many: true, rows: (c) => db.sections.filter((s) => s.courseId === c.id) } },
  section: { lessons: { model: "lesson", many: true, rows: (s) => db.lessons.filter((l) => l.sectionId === s.id) } },
  lesson: { section: { model: "section", many: false, rows: (l) => db.sections.filter((s) => s.id === l.sectionId) } },
  quiz: {
    lesson: { model: "lesson", many: false, rows: (q) => db.lessons.filter((l) => l.id === q.lessonId) },
    questions: { model: "question", many: true, rows: (q) => db.questions.filter((x) => x.quizId === q.id) },
  },
};

function matchWhere(row: Row, where: unknown): boolean {
  if (!where) return true;
  return Object.entries(where as Row).every(([k, v]) => {
    if (typeof v === "object" && v !== null) throw new Error(`fake prisma: unsupported where ${k}`);
    return row[k] === v;
  });
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, "asc" | "desc">>;
  return [...rows].sort((a, b) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0];
      if (a[k] === b[k]) continue;
      const cmp = (a[k] as string | number) < (b[k] as string | number) ? -1 : 1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

function project(model: string, row: Row, select: Select | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    const rel = RELATIONS[model]?.[k];
    if (rel) {
      const spec = (v === true ? {} : v) as { where?: unknown; orderBy?: unknown; select?: Select };
      const rows = sortRows(rel.rows(row).filter((r) => matchWhere(r, spec.where)), spec.orderBy);
      out[k] = rel.many ? rows.map((r) => project(rel.model, r, spec.select)) : rows[0] ? project(rel.model, rows[0], spec.select) : null;
      continue;
    }
    if (v !== true) throw new Error(`fake prisma: unsupported select ${model}.${k}`);
    out[k] = row[k];
  }
  return out;
}

function findMany(model: string, method: string, rows: () => Row[]) {
  return async (args: Row = {}) => {
    calls.push({ method, args });
    return sortRows(rows().filter((r) => matchWhere(r, args.where)), args.orderBy).map((r) => project(model, r, args.select as Select));
  };
}

const fakePrisma = {
  course: { findMany: findMany("course", "course.findMany", () => db.courses) },
  progress: { findMany: findMany("progress", "progress.findMany", () => db.progress) },
  quiz: {
    findMany: findMany("quiz", "quiz.findMany", () => db.quizzes),
    async findUnique(args: Row) {
      calls.push({ method: "quiz.findUnique", args });
      const q = db.quizzes.find((x) => x.id === (args.where as { id: string }).id);
      return q ? project("quiz", q, args.select as Select) : null;
    },
  },
  quizAttempt: {
    findMany: findMany("attempt", "quizAttempt.findMany", () => db.attempts),
    async create(args: Row) {
      calls.push({ method: "quizAttempt.create", args });
      const row: Row = { id: `att_new_${db.attempts.length}`, createdAt: new Date(BASE + db.attempts.length * 1000), ...(args.data as Row) };
      db.attempts.push(row);
      return project("attempt", row, args.select as Select);
    },
  },
};

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ GET: LIST } = await import("../../src/app/api/quizzes/route"));
  ({ GET: GET_ONE } = await import("../../src/app/api/quizzes/[quizId]/route"));
  ({ POST: SUBMIT } = await import("../../src/app/api/quizzes/[quizId]/submit/route"));
  ({ handleQuizSubmit: HANDLE_SUBMIT } = await import("../../src/lib/quiz-submit"));
});

beforeEach(() => {
  session = STUDENT_SESSION;
  calls = [];
  db = {
    courses: [
      { id: "c1", name: "STEP1 ダミー", order: 1, icon: "it", color: "#6366F1" },
      { id: "c2", name: "STEP2 ダミー", order: 2, icon: "html", color: "#EF4444" },
    ],
    sections: [
      { id: "s1", courseId: "c1", order: 1 },
      { id: "s2", courseId: "c2", order: 1 },
    ],
    lessons: [
      { id: "l1", sectionId: "s1", title: "L1", order: 1 },
      { id: "l2", sectionId: "s2", title: "L2", order: 1 },
    ],
    progress: [],
    quizzes: [
      { id: "fin1", title: "STEP1 修了", type: "FINAL", courseId: "c1", lessonId: null },
      { id: "mini1", title: "L1 ミニ", type: "MINI", courseId: null, lessonId: "l1" },
      { id: "fin2", title: "STEP2 修了（ロック中）", type: "FINAL", courseId: "c2", lessonId: null },
      { id: "badkey", title: "正解が範囲外", type: "MINI", courseId: null, lessonId: "l1" },
    ],
    questions: [
      // fin1：正解は [1, 0, 2]。選択肢の文言は応答の漏えい検査に使う目印
      { id: "q1", quizId: "fin1", question: "問1", options: ["SECRET_OPT_A", "SECRET_OPT_B"], correctIndex: 1, order: 1 },
      { id: "q2", quizId: "fin1", question: "問2", options: ["x0", "x1", "x2"], correctIndex: 0, order: 2 },
      { id: "q3", quizId: "fin1", question: "問3", options: ["y0", "y1", "y2"], correctIndex: 2, order: 3 },
      { id: "mq", quizId: "mini1", question: "ミニ問", options: ["m0", "m1"], correctIndex: 0, order: 1 },
      { id: "f2", quizId: "fin2", question: "STEP2 問", options: ["n0", "n1"], correctIndex: 1, order: 1 },
      { id: "bk", quizId: "badkey", question: "範囲外の問", options: ["k0", "k1"], correctIndex: 7, order: 1 },
    ],
    attempts: [
      { id: "att_other_secret", userId: OTHER, quizId: "fin1", score: 100, passed: true, answers: [1, 0, 2], createdAt: new Date(BASE - 60_000) },
    ],
  };
});

const ctx = (quizId: string) => ({ params: Promise.resolve({ quizId }) });
const getOne = (quizId: string) => GET_ONE(new Request(`https://nwa-lms.example.com/api/quizzes/${encodeURIComponent(quizId)}`), ctx(quizId));
const submitRequest = (quizId: string, raw: string) =>
  new Request(`https://nwa-lms.example.com/api/quizzes/${encodeURIComponent(quizId)}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
/** 受験を公開したあとの動き（attemptsEnabled: true）。userId は route と同じくセッションの値 */
const submit = (quizId: string, raw: string) =>
  HANDLE_SUBMIT(session!.user!.id as string, submitRequest(quizId, raw), ctx(quizId), { attemptsEnabled: true });
const creates = () => calls.filter((c) => c.method === "quizAttempt.create");

function captureLogs() {
  const spies = (["error", "log", "warn", "info", "debug"] as const).map((k) => mock.method(console, k, () => {}));
  return () => {
    const args = spies.flatMap((m) => m.mock.calls.flatMap((c) => c.arguments));
    for (const s of spies) s.mock.restore();
    return args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ");
  };
}

/** JSON の全階層のキー（配列の中も含む） */
function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

const LIST_KEYS = [
  "courses", "id", "name", "order", "icon", "color", "locked", "finalQuizzes", "miniQuizzes",
  "title", "type", "lessonId", "lessonTitle", "questionCount", "attemptCount", "bestScore", "passed", "lastAttemptAt",
];
const ONE_KEYS = ["id", "title", "type", "questionCount", "questions", "question", "options", "attemptCount", "bestScore", "passed"];
const SUBMIT_KEYS = ["score", "passed", "total", "correct", "results"];
const LEAK_MARKERS = ["correctIndex", "answers", "userId", OTHER, "att_other_secret", "example.com"];

// ───────────── 応答に出る項目（許可リスト） ─────────────

describe("応答の項目は許可リストの中だけ（正解・回答・他人の記録を出さない）", () => {
  it("GET /api/quizzes：許可した項目だけで、選択肢の文言・問題文・正解も出さない", async () => {
    const res = await LIST();
    assert.equal(res.status, 200);
    const text = await res.text();
    const keys = Array.from(allKeys(JSON.parse(text)));
    assert.deepEqual(keys.filter((k) => !LIST_KEYS.includes(k)), []);
    for (const s of [...LEAK_MARKERS, "SECRET_OPT_A", "問1", "options", "questions"]) assert.ok(!text.includes(s), s);
  });

  for (const id of ["fin1", "mini1", "fin2"]) {
    it(`GET /api/quizzes/${id}：許可した項目だけで、correctIndex・回答・他人の記録を出さない`, async () => {
      const res = await getOne(id);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.deepEqual(Array.from(allKeys(JSON.parse(text))).filter((k) => !ONE_KEYS.includes(k)), []);
      for (const s of LEAK_MARKERS) assert.ok(!text.includes(s), s);
    });
  }

  it("POST submit（公開後）：許可した項目だけで、正解の位置・選択肢・回答を出さない", async () => {
    const res = await submit("fin1", '{"answers":[0,0,0]}');
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), [...SUBMIT_KEYS].sort());
    assert.deepEqual(body, { score: 33, passed: false, total: 3, correct: 1, results: [false, true, false] });
    for (const s of [...LEAK_MARKERS, "SECRET_OPT", "options"]) assert.ok(!text.includes(s), s);
  });

  it("GET /api/quizzes/badkey（正解が範囲外）は 409 で正解を出さない（一覧には出ない・submit も 409）", async () => {
    const list = await (await LIST()).text();
    assert.ok(!list.includes("badkey"));
    const res = await getOne("badkey");
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "Quiz unavailable", reason: "quiz_unavailable" });
    assert.ok(!text.includes("correctIndex"));
    assert.ok(!text.includes("7"), "範囲外の正解の位置が出ていない");
    assert.equal((await submit("badkey", '{"answers":[0]}')).status, 409);
  });
});

// ───────────── 他人のデータ（RLS の代わり） ─────────────

describe("受験記録は本人の分だけ（自分の受験が他人の集計に入らない）", () => {
  it("STUDENT が受験・保存しても、OTHER の一覧・1 件の集計は OTHER 自身の記録だけ", async () => {
    // STUDENT が mini1 を 2 回（不合格・合格）
    assert.equal((await submit("mini1", '{"answers":[1]}')).status, 200);
    assert.equal((await submit("mini1", '{"answers":[0]}')).status, 200);
    assert.deepEqual(creates().map((c) => (c.args.data as Row).userId), [STUDENT, STUDENT]);

    const mine = await (await getOne("mini1")).json();
    assert.deepEqual([mine.attemptCount, mine.bestScore, mine.passed], [2, 100, true]);

    session = OTHER_SESSION;
    const theirs = await (await getOne("mini1")).json();
    assert.deepEqual([theirs.attemptCount, theirs.bestScore, theirs.passed], [0, null, null]);
    const theirList = await (await LIST()).json();
    const mini = theirList.courses[0].miniQuizzes.find((q: Row) => q.id === "mini1");
    assert.deepEqual([mini.attemptCount, mini.bestScore, mini.passed], [0, null, null]);
    // OTHER 自身の fin1 の記録は OTHER には見える
    const fin = theirList.courses[0].finalQuizzes.find((q: Row) => q.id === "fin1");
    assert.deepEqual([fin.attemptCount, fin.bestScore, fin.passed], [1, 100, true]);
  });

  it("STUDENT からは OTHER の fin1 の合格（100 点）が見えない", async () => {
    const one = await (await getOne("fin1")).json();
    assert.deepEqual([one.attemptCount, one.bestScore, one.passed], [0, null, null]);
    const list = await (await LIST()).json();
    const fin = list.courses[0].finalQuizzes.find((q: Row) => q.id === "fin1");
    assert.deepEqual([fin.attemptCount, fin.bestScore, fin.passed, fin.lastAttemptAt], [0, null, null, null]);
  });

  it("受験記録の読み出しは、毎回セッションの userId で絞る", async () => {
    session = OTHER_SESSION;
    await LIST();
    await getOne("fin1");
    const wheres = calls.filter((c) => c.method === "quizAttempt.findMany").map((c) => c.args.where as Row);
    assert.equal(wheres.length, 2);
    for (const w of wheres) assert.equal(w.userId, OTHER);
  });
});

// ───────────── 回答の検証の境界（公開後） ─────────────

describe("POST submit（公開後）：回答の境界", () => {
  for (const [label, raw] of [
    ["Infinity（1e400）", '{"answers":[1,0,1e400]}'],
    ["入れ子の配列", '{"answers":[[1],0,2]}'],
    ["真偽値", '{"answers":[true,false,2]}'],
    ["文字列の数字（全部）", '{"answers":["1","0","2"]}'],
    ["小数（1.5）", '{"answers":[1.5,0,2]}'],
    ["負の数（-1）", '{"answers":[-1,0,2]}'],
    ["オブジェクト", '{"answers":[{"v":1},0,2]}'],
  ] as Array<[string, string]>) {
    it(`${label}は 400 invalid_answers で、書き込まない`, async () => {
      const res = await submit("fin1", raw);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_answers" });
      assert.equal(creates().length, 0);
    });
  }

  for (const [label, raw] of [
    ["length を持つオブジェクト", '{"answers":{"0":1,"1":0,"2":2,"length":3}}'],
    ["__proto__ の中の answers", '{"__proto__":{"answers":[1,0,2]}}'],
    ["空文字", '""'],
    ["数値", "3"],
    ["answers が null", '{"answers":null}'],
  ] as Array<[string, string]>) {
    it(`${label}は 400 invalid_answers で、DB を読まない`, async () => {
      const res = await submit("fin1", raw);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, "invalid_answers");
      assert.equal(calls.length, 0);
    });
  }

  it("空の body は 400 invalid_json で、DB を読まない", async () => {
    const res = await submit("fin1", "");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "invalid_json");
    assert.equal(calls.length, 0);
  });

  it("-0 と 1.0 は JSON では 0 と 1 なので受け付け、採点も 0・1 として扱う", async () => {
    const res = await submit("fin1", '{"answers":[1.0,-0,2]}');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { score: 100, passed: true, total: 3, correct: 3, results: [true, true, true] });
    const saved = (creates()[0].args.data as Row).answers as number[];
    assert.equal(JSON.stringify(saved), "[1,0,2]");
  });

  it("100 万件の配列も 400 で、書き込まない（応答に回答を含めない）", async () => {
    const raw = `{"answers":[${new Array(1_000_000).fill(0).join(",")}]}`;
    const res = await submit("fin1", raw);
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(text.length < 100);
    assert.equal(creates().length, 0);
  });

  it("答え合わせ：正解の位置を 1 つずつずらしても、正解数は正解した問題の数だけ", async () => {
    const cases: Array<[number[], boolean[]]> = [
      [[1, 0, 2], [true, true, true]],
      [[0, 0, 2], [false, true, true]],
      [[1, 1, 2], [true, false, true]],
      [[1, 0, 1], [true, true, false]],
      [[0, 1, 0], [false, false, false]],
    ];
    for (const [answers, results] of cases) {
      const body = await (await submit("fin1", JSON.stringify({ answers }))).json();
      assert.deepEqual(body.results, results, JSON.stringify(answers));
      assert.equal(body.correct, results.filter(Boolean).length);
    }
  });
});

// ───────────── ログ・503 ─────────────

describe("失敗の応答ではログを出さない", () => {
  it("400（壊れた JSON・不正な回答）・404・409 は何もログに出さない", async () => {
    const done = captureLogs();
    assert.equal((await submit("fin1", "{ answers: [")).status, 400);
    assert.equal((await submit("fin1", '{"answers":[9,9,9]}')).status, 400);
    assert.equal((await submit("missing", '{"answers":[0]}')).status, 404);
    assert.equal((await submit("badkey", '{"answers":[0]}')).status, 409);
    assert.equal((await getOne("missing")).status, 404);
    assert.equal((await getOne("")).status, 400);
    assert.equal(done(), "");
  });

  it("一覧・1 件の成功もログを出さない", async () => {
    const done = captureLogs();
    await LIST();
    await getOne("fin1");
    assert.equal(done(), "");
  });
});

describe("POST submit（route、いまの本番）：503", () => {
  it("ログイン済みなら body を読まずに 503。ログも出さない", async () => {
    const req = submitRequest("fin1", '{"answers":[1,0,2],"userId":"x"}');
    const done = captureLogs();
    const res = await SUBMIT(req, ctx("fin1"));
    assert.equal(done(), "");
    assert.equal(res.status, 503);
    assert.equal(req.bodyUsed, false);
    assert.equal(calls.length, 0);
    assert.equal(db.attempts.length, 1);
  });

  it("講師のセッションでも 503（受験の停止は役割に関係なく効く）", async () => {
    session = { user: { id: "inst_dummy", role: "INSTRUCTOR" } };
    const res = await SUBMIT(submitRequest("fin1", '{"answers":[1,0,2]}'), ctx("fin1"));
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0);
  });

  it("未ログインは 503 ではなく 401（停止中であることも知らせない）", async () => {
    session = null;
    const res = await SUBMIT(submitRequest("fin1", '{"answers":[1,0,2]}'), ctx("fin1"));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
  });
});
