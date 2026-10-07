import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { installFakeAuth, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #32 確認テストの API：GET /api/quizzes、GET /api/quizzes/[quizId]、POST /api/quizzes/[quizId]/submit。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数を記録し、where（値の一致）・orderBy・select（入れ子のリレーションと _count）を最低限だけ再現する）。
// NextAuth は installFakeAuth で差し替える。データはすべてダミー（example.com）。

type Row = Record<string, unknown>;
type Select = Record<string, unknown>;
type Call = { method: string; args: Row };

const STUDENT = "stu_active";
const OTHER = "stu_other";
const DUMMY_EMAIL = "student@example.com";
const BASE = Date.parse("2026-10-07T12:00:00.000Z");

let session: FakeSession;
let calls: Call[];
let failOn: string | undefined;
let failWith: unknown;
let db: {
  courses: Row[];
  sections: Row[];
  lessons: Row[];
  progress: Row[];
  quizzes: Row[];
  questions: Row[];
  attempts: Row[];
};

let LIST: () => Promise<Response>;
let GET_ONE: (req: Request, ctx: { params: Promise<{ quizId: string }> }) => Promise<Response>;
let SUBMIT: (req: Request, ctx: { params: Promise<{ quizId: string }> }) => Promise<Response>;

// ───────────── 偽 prisma ─────────────

type Relation = { model: string; many: boolean; rows: (parent: Row) => Row[] };

const RELATIONS: Record<string, Record<string, Relation>> = {
  course: { sections: { model: "section", many: true, rows: (c) => db.sections.filter((s) => s.courseId === c.id) } },
  section: { lessons: { model: "lesson", many: true, rows: (s) => db.lessons.filter((l) => l.sectionId === s.id) } },
  lesson: { section: { model: "section", many: false, rows: (l) => db.sections.filter((s) => s.id === l.sectionId) } },
  quiz: {
    lesson: { model: "lesson", many: false, rows: (q) => db.lessons.filter((l) => l.id === q.lessonId) },
    questions: { model: "question", many: true, rows: (q) => db.questions.filter((x) => x.quizId === q.id) },
    attempts: { model: "attempt", many: true, rows: (q) => db.attempts.filter((a) => a.quizId === q.id) },
  },
  question: {},
  attempt: {},
  progress: {},
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
      const av = a[k] instanceof Date ? (a[k] as Date).getTime() : (a[k] as string | number);
      const bv = b[k] instanceof Date ? (b[k] as Date).getTime() : (b[k] as string | number);
      if (av === bv) continue;
      const cmp = av < bv ? -1 : 1;
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
    if (k === "_count") {
      const counts: Row = {};
      for (const rk of Object.keys((v as { select: Select }).select)) counts[rk] = RELATIONS[model][rk].rows(row).length;
      out._count = counts;
      continue;
    }
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

function record(method: string, args: Row) {
  calls.push({ method, args });
  if (failOn === method) throw failWith;
}

function findMany(model: string, method: string, rows: () => Row[]) {
  return async (args: Row = {}) => {
    record(method, args);
    const hit = sortRows(rows().filter((r) => matchWhere(r, args.where)), args.orderBy);
    return hit.map((r) => project(model, r, args.select as Select | undefined));
  };
}

const fakePrisma = {
  course: { findMany: findMany("course", "course.findMany", () => db.courses) },
  progress: { findMany: findMany("progress", "progress.findMany", () => db.progress) },
  quiz: {
    findMany: findMany("quiz", "quiz.findMany", () => db.quizzes),
    async findUnique(args: Row) {
      record("quiz.findUnique", args);
      const id = (args.where as { id: string }).id;
      const q = db.quizzes.find((x) => x.id === id);
      return q ? project("quiz", q, args.select as Select | undefined) : null;
    },
  },
  quizAttempt: {
    findMany: findMany("attempt", "quizAttempt.findMany", () => db.attempts),
    async create(args: Row) {
      record("quizAttempt.create", args);
      const row: Row = { id: `att_new_${db.attempts.length}`, createdAt: new Date(BASE), ...(args.data as Row) };
      db.attempts.push(row);
      return project("attempt", row, args.select as Select | undefined);
    },
  },
};

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ GET: LIST } = await import("../../src/app/api/quizzes/route"));
  ({ GET: GET_ONE } = await import("../../src/app/api/quizzes/[quizId]/route"));
  ({ POST: SUBMIT } = await import("../../src/app/api/quizzes/[quizId]/submit/route"));
});

const at = (minutesAgo: number) => new Date(BASE - minutesAgo * 60_000);

beforeEach(() => {
  session = STUDENT_SESSION;
  calls = [];
  failOn = undefined;
  failWith = undefined;
  db = {
    courses: [
      { id: "c2", name: "STEP2 HTML", order: 2, icon: "html", color: "#EF4444", description: "説明" },
      { id: "c1", name: "STEP1 IT", order: 1, icon: "it", color: "#6366F1", description: "説明" },
      { id: "c3", name: "STEP3 CSS", order: 3, icon: "css", color: "#3B82F6", description: "説明" },
    ],
    sections: [
      { id: "s1", courseId: "c1", title: "S1", order: 1 },
      { id: "s2", courseId: "c2", title: "S2", order: 1 },
      { id: "s3", courseId: "c3", title: "S3", order: 1 },
    ],
    lessons: [
      { id: "l1b", sectionId: "s1", title: "L1-2", order: 2, type: "TEXT", content: "本文" },
      { id: "l1a", sectionId: "s1", title: "L1-1", order: 1, type: "TEXT", content: "本文" },
      { id: "l2a", sectionId: "s2", title: "L2-1", order: 1, type: "TEXT", content: "本文" },
      { id: "l3a", sectionId: "s3", title: "L3-1", order: 1, type: "TEXT", content: "本文" },
    ],
    // STEP1 を全部終えている。STEP2 は未着手、STEP3 も未着手（STEP2 が未完了なのでロック）
    progress: [
      { id: "p1", userId: STUDENT, lessonId: "l1a", completed: true },
      { id: "p2", userId: STUDENT, lessonId: "l1b", completed: true },
      { id: "p3", userId: OTHER, lessonId: "l2a", completed: true },
    ],
    quizzes: [
      { id: "fin1", title: "STEP1 修了テスト", type: "FINAL", courseId: "c1", lessonId: null },
      { id: "mini1b", title: "L1-2 ミニ", type: "MINI", courseId: null, lessonId: "l1b" },
      { id: "mini1a", title: "L1-1 ミニ", type: "MINI", courseId: null, lessonId: "l1a" },
      { id: "fin2", title: "STEP2 修了テスト", type: "FINAL", courseId: "c2", lessonId: null },
      { id: "fin3", title: "STEP3 修了テスト", type: "FINAL", courseId: "c3", lessonId: null },
      { id: "empty", title: "問題なし", type: "FINAL", courseId: "c1", lessonId: null },
      { id: "orphan", title: "どこにも属さない", type: "FINAL", courseId: null, lessonId: null },
      { id: "broken", title: "壊れた選択肢", type: "MINI", courseId: null, lessonId: "l2a" },
      { id: "badkey", title: "正解が範囲外", type: "MINI", courseId: null, lessonId: "l3a" },
    ],
    questions: [
      // fin1：order 2 が 2 件（id の昇順で qa → qb）、order 1 が 1 件
      { id: "qb", quizId: "fin1", question: "問B", options: ["b0", "b1", "b2"], correctIndex: 2, order: 2 },
      { id: "qz", quizId: "fin1", question: "問Z", options: ["z0", "z1"], correctIndex: 1, order: 1 },
      { id: "qa", quizId: "fin1", question: "問A", options: ["a0", "a1", "a2", "a3"], correctIndex: 0, order: 2 },
      { id: "m1a", quizId: "mini1a", question: "ミニA", options: ["x", "y"], correctIndex: 0, order: 1 },
      { id: "m1b", quizId: "mini1b", question: "ミニB", options: ["x", "y"], correctIndex: 1, order: 1 },
      { id: "f2q", quizId: "fin2", question: "問2", options: ["x", "y"], correctIndex: 0, order: 1 },
      { id: "f3q", quizId: "fin3", question: "問3", options: ["x", "y"], correctIndex: 0, order: 1 },
      { id: "oq", quizId: "orphan", question: "問O", options: ["x", "y"], correctIndex: 0, order: 1 },
      { id: "br1", quizId: "broken", question: "壊れ", options: ["only"], correctIndex: 0, order: 1 },
      { id: "bk1", quizId: "badkey", question: "範囲外", options: ["x", "y"], correctIndex: 5, order: 1 },
    ],
    attempts: [
      { id: "att_1", userId: STUDENT, quizId: "fin1", score: 33, passed: false, answers: [1, 1, 1], createdAt: at(300) },
      { id: "att_2", userId: STUDENT, quizId: "fin1", score: 67, passed: false, answers: [1, 0, 1], createdAt: at(100) },
      { id: "att_3", userId: STUDENT, quizId: "mini1a", score: 100, passed: true, answers: [0], createdAt: at(50) },
      // 他人の記録（数えない）
      { id: "att_9", userId: OTHER, quizId: "fin1", score: 100, passed: true, answers: [1, 0, 2], createdAt: at(10) },
      { id: "att_8", userId: OTHER, quizId: "fin2", score: 100, passed: true, answers: [0], createdAt: at(10) },
    ],
  };
});

const ctx = (quizId: string) => ({ params: Promise.resolve({ quizId }) });
const getOne = (quizId: string) => GET_ONE(new Request(`https://nwa-lms.example.com/api/quizzes/${encodeURIComponent(quizId)}`), ctx(quizId));
const submit = (quizId: string, body: unknown, raw?: string) =>
  SUBMIT(
    new Request(`https://nwa-lms.example.com/api/quizzes/${encodeURIComponent(quizId)}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
    ctx(quizId)
  );
const creates = () => calls.filter((c) => c.method === "quizAttempt.create");

function captureLogs() {
  const err = mock.method(console, "error", () => {});
  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "warn", () => {});
  return () => {
    const args = [err, log, warn].flatMap((m) => m.mock.calls.flatMap((c) => c.arguments));
    err.mock.restore();
    log.mock.restore();
    warn.mock.restore();
    return args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ");
  };
}

/** メッセージ・meta に回答・正解・メールアドレス・ID を含む例外 */
function piiError() {
  const err = new Error(`write failed for ${DUMMY_EMAIL} (${STUDENT}) answers=[2,1,0] correctIndex=2`);
  Object.assign(err, { code: "P2003", meta: { email: DUMMY_EMAIL, userId: STUDENT, answers: [2, 1, 0], correctIndex: 2 } });
  return err;
}

function assertSafeLog(out: string) {
  assert.ok(out.length > 0, "ログが出ていない");
  assert.match(out, /Error/);
  for (const k of ["example\\.com", STUDENT, "write failed", "answers", "correctIndex", "\\[2,1,0\\]", "P2003", "fin1"]) {
    assert.doesNotMatch(out, new RegExp(k), k);
  }
}

// ───────────── GET /api/quizzes ─────────────

describe("GET /api/quizzes：認証", () => {
  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    const res = await LIST();
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  it("user.id のないセッションも 401", async () => {
    session = { user: { role: "STUDENT" } };
    assert.equal((await LIST()).status, 401);
    assert.equal(calls.length, 0);
  });
});

describe("GET /api/quizzes：応答", () => {
  it("コースの順（order）に、修了テスト・ミニテスト（レッスン順）を振り分ける。問題 0 件・コースに属さないクイズは除く", async () => {
    const body = await (await LIST()).json();
    assert.deepEqual(
      body.courses.map((c: { id: string; finalQuizzes: Array<{ id: string }>; miniQuizzes: Array<{ id: string }> }) => [
        c.id,
        c.finalQuizzes.map((q) => q.id),
        c.miniQuizzes.map((q) => q.id),
      ]),
      [
        ["c1", ["fin1"], ["mini1a", "mini1b"]],
        ["c2", ["fin2"], ["broken"]],
        ["c3", ["fin3"], ["badkey"]],
      ]
    );
  });

  it("コースの項目と、ロック（STEP1 を終えて STEP2 は開く、STEP3 はロック）", async () => {
    const body = await (await LIST()).json();
    const [c1, c2, c3] = body.courses;
    assert.deepEqual(Object.keys(c1).sort(), ["color", "finalQuizzes", "icon", "id", "locked", "miniQuizzes", "name", "order"]);
    assert.deepEqual([c1.locked, c2.locked, c3.locked], [false, false, true]);
    assert.deepEqual({ name: c1.name, order: c1.order, icon: c1.icon, color: c1.color }, { name: "STEP1 IT", order: 1, icon: "it", color: "#6366F1" });
  });

  it("自分の受験記録だけを数える（他人の 100 点・合格は入らない）", async () => {
    const body = await (await LIST()).json();
    const c1 = body.courses[0];
    assert.deepEqual(c1.finalQuizzes[0], {
      id: "fin1",
      title: "STEP1 修了テスト",
      type: "FINAL",
      lessonId: null,
      lessonTitle: null,
      questionCount: 3,
      attemptCount: 2,
      bestScore: 67,
      passed: false,
      lastAttemptAt: at(100).toISOString(),
    });
    assert.deepEqual(
      c1.miniQuizzes.map((q: { id: string; lessonId: string; lessonTitle: string; attemptCount: number; bestScore: number | null; passed: boolean | null }) => [
        q.id,
        q.lessonId,
        q.lessonTitle,
        q.attemptCount,
        q.bestScore,
        q.passed,
      ]),
      [
        ["mini1a", "l1a", "L1-1", 1, 100, true],
        ["mini1b", "l1b", "L1-2", 0, null, null],
      ]
    );
    const fin2 = body.courses[1].finalQuizzes[0];
    assert.deepEqual([fin2.attemptCount, fin2.bestScore, fin2.passed], [0, null, null]);
  });

  it("受験記録と進捗は where userId で自分の分だけ読む", async () => {
    await LIST();
    const attempts = calls.find((c) => c.method === "quizAttempt.findMany");
    assert.deepEqual(attempts?.args.where, { userId: STUDENT });
    assert.deepEqual(attempts?.args.select, { quizId: true, score: true, passed: true, createdAt: true });
    const progress = calls.find((c) => c.method === "progress.findMany");
    assert.deepEqual(progress?.args.where, { userId: STUDENT, completed: true });
  });

  it("コースは [order, id] で並べ、クイズは正解・問題文を読まない（問題は件数だけ）", async () => {
    await LIST();
    const courses = calls.find((c) => c.method === "course.findMany");
    assert.deepEqual(courses?.args.orderBy, [{ order: "asc" }, { id: "asc" }]);
    const quizzes = calls.find((c) => c.method === "quiz.findMany");
    const text = JSON.stringify(quizzes?.args);
    assert.doesNotMatch(text, /correctIndex|options|question"|answers|attempts/);
    assert.deepEqual((quizzes?.args.select as Select)._count, { select: { questions: true } });
  });

  it("応答 JSON に正解・回答・他人の ID・メールアドレスを含まない", async () => {
    const text = await (await LIST()).text();
    for (const k of ["correctIndex", "answers", "options", OTHER, STUDENT, "userId", "example\\.com", "description"]) {
      assert.doesNotMatch(text, new RegExp(k), k);
    }
  });

  it("クイズが 1 件もなければ courses は空配列", async () => {
    db.quizzes = [];
    assert.deepEqual(await (await LIST()).json(), { courses: [] });
  });
});

describe("GET /api/quizzes：エラー", () => {
  it("例外なら 500 で、ログはエラーの名前だけ", async () => {
    failOn = "quizAttempt.findMany";
    failWith = piiError();
    const done = captureLogs();
    const res = await LIST();
    const out = done();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assertSafeLog(out);
  });
});

// ───────────── GET /api/quizzes/[quizId] ─────────────

describe("GET /api/quizzes/[quizId]：認証・入力", () => {
  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    assert.equal((await getOne("fin1")).status, 401);
    assert.equal(calls.length, 0);
  });

  it("quizId が空なら 400 で、DB を読まない", async () => {
    assert.equal((await getOne("")).status, 400);
    assert.equal(calls.length, 0);
  });

  it("quizId が 65 文字なら 400、64 文字なら（なければ）404", async () => {
    assert.equal((await getOne("a".repeat(65))).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await getOne("a".repeat(64))).status, 404);
  });

  it("なければ 404", async () => {
    const res = await getOne("missing");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Quiz not found" });
  });

  for (const [label, id] of [
    ["問題 0 件", "empty"],
    ["options が壊れている", "broken"],
  ]) {
    it(`${label}なら 409 quiz_unavailable`, async () => {
      const res = await getOne(id);
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "Quiz unavailable", reason: "quiz_unavailable" });
    });
  }
});

describe("GET /api/quizzes/[quizId]：応答", () => {
  it("問題は [order, id] の順で、id・question・options だけ。受験記録は自分の分の集計値だけ", async () => {
    const res = await getOne("fin1");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      id: "fin1",
      title: "STEP1 修了テスト",
      type: "FINAL",
      questionCount: 3,
      questions: [
        { id: "qz", question: "問Z", options: ["z0", "z1"] },
        { id: "qa", question: "問A", options: ["a0", "a1", "a2", "a3"] },
        { id: "qb", question: "問B", options: ["b0", "b1", "b2"] },
      ],
      attemptCount: 2,
      bestScore: 67,
      passed: false,
    });
  });

  it("応答 JSON 全体に correctIndex・回答・受験記録の行・ユーザー ID を含まない", async () => {
    const text = await (await getOne("fin1")).text();
    for (const k of ["correctIndex", "answers", "attempts", "createdAt", "userId", STUDENT, OTHER, "att_"]) {
      assert.doesNotMatch(text, new RegExp(k), k);
    }
  });

  it("問題の select に correctIndex がなく、orderBy は [order, id]。受験記録は where userId・quizId で集計に必要な項目だけ", async () => {
    await getOne("fin1");
    const quiz = calls.find((c) => c.method === "quiz.findUnique");
    const questions = (quiz?.args.select as Select).questions as { orderBy: unknown; select: Select };
    assert.deepEqual(questions.orderBy, [{ order: "asc" }, { id: "asc" }]);
    assert.deepEqual(questions.select, { id: true, question: true, options: true });
    assert.doesNotMatch(JSON.stringify(quiz?.args), /correctIndex|attempts/);
    const attempts = calls.find((c) => c.method === "quizAttempt.findMany");
    assert.deepEqual(attempts?.args.where, { userId: STUDENT, quizId: "fin1" });
    assert.deepEqual(attempts?.args.select, { score: true, passed: true, createdAt: true });
  });

  it("未受験なら 0 回・null", async () => {
    const body = await (await getOne("mini1b")).json();
    assert.deepEqual([body.attemptCount, body.bestScore, body.passed], [0, null, null]);
  });

  it("他人だけが合格しているクイズでも、自分の集計は未受験", async () => {
    const body = await (await getOne("fin2")).json();
    assert.deepEqual([body.attemptCount, body.bestScore, body.passed], [0, null, null]);
  });
});

describe("GET /api/quizzes/[quizId]：エラー", () => {
  it("例外なら 500 で、ログはエラーの名前だけ", async () => {
    failOn = "quiz.findUnique";
    failWith = piiError();
    const done = captureLogs();
    const res = await getOne("fin1");
    const out = done();
    assert.equal(res.status, 500);
    assertSafeLog(out);
  });
});

// ───────────── POST /api/quizzes/[quizId]/submit ─────────────

describe("POST submit：認証・入力", () => {
  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    assert.equal((await submit("fin1", { answers: [1, 0, 2] })).status, 401);
    assert.equal(calls.length, 0);
  });

  it("quizId が空・65 文字なら 400 で、DB を読まない", async () => {
    assert.equal((await submit("", { answers: [0] })).status, 400);
    assert.equal((await submit("a".repeat(65), { answers: [0] })).status, 400);
    assert.equal(calls.length, 0);
  });

  it("壊れた JSON は 400 invalid_json で、DB を読まない", async () => {
    const res = await submit("fin1", undefined, "{ answers: [1,");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid JSON", reason: "invalid_json" });
    assert.equal(calls.length, 0);
  });

  for (const [label, body] of [
    ["null", null],
    ["配列", [1, 0, 2]],
    ["answers なし", {}],
    ["answers が文字列", { answers: "1,0,2" }],
  ] as Array<[string, unknown]>) {
    it(`${label} は 400 invalid_answers で、DB を読まない`, async () => {
      const res = await submit("fin1", body);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, "invalid_answers");
      assert.equal(calls.length, 0);
    });
  }

  for (const [label, answers] of [
    ["短い", [1, 0]],
    ["長い", [1, 0, 2, 0]],
    ["巨大な配列", new Array(50_000).fill(0)],
    ["範囲外（1 問目は 2 択）", [2, 0, 0]],
    ["範囲外（3 問目は 3 択）", [1, 0, 3]],
    ["負の数", [1, -1, 0]],
    ["小数", [1, 0.5, 0]],
    ["文字列", [1, "0", 0]],
    ["null", [1, null, 0]],
  ] as Array<[string, unknown[]]>) {
    it(`${label}は 400 invalid_answers で、書き込まない`, async () => {
      const res = await submit("fin1", { answers });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, "invalid_answers");
      assert.equal(creates().length, 0);
    });
  }

  it("NaN（JSON では null になる）も 400", async () => {
    const res = await submit("fin1", undefined, '{"answers":[1,NaN,0]}');
    assert.equal(res.status, 400);
    assert.equal(creates().length, 0);
  });

  it("なければ 404 で、書き込まない", async () => {
    const res = await submit("missing", { answers: [0] });
    assert.equal(res.status, 404);
    assert.equal(creates().length, 0);
  });

  for (const [label, id] of [
    ["問題 0 件", "empty"],
    ["options が壊れている", "broken"],
    ["correctIndex が範囲外", "badkey"],
  ]) {
    it(`${label}なら 409 quiz_unavailable で、書き込まない`, async () => {
      const res = await submit(id, { answers: [0] });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "Quiz unavailable", reason: "quiz_unavailable" });
      assert.equal(creates().length, 0);
    });
  }
});

describe("POST submit：採点と保存", () => {
  // fin1 の並び（[order, id]）：qz（正解 1）→ qa（正解 0）→ qb（正解 2）
  it("採点はサーバーで、GET と同じ並び。応答は score / passed / total / correct / results だけ", async () => {
    const res = await submit("fin1", { answers: [1, 0, 0] });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { score: 67, passed: false, total: 3, correct: 2, results: [true, true, false] });
    for (const k of ["correctIndex", "answers", "options", STUDENT]) assert.doesNotMatch(text, new RegExp(k), k);
    const quiz = calls.find((c) => c.method === "quiz.findUnique");
    const questions = (quiz?.args.select as Select).questions as { orderBy: unknown; select: Select };
    assert.deepEqual(questions.orderBy, [{ order: "asc" }, { id: "asc" }]);
    assert.deepEqual(questions.select, { options: true, correctIndex: true });
  });

  it("全問正解は 100 点で合格", async () => {
    const body = await (await submit("fin1", { answers: [1, 0, 2] })).json();
    assert.deepEqual(body, { score: 100, passed: true, total: 3, correct: 3, results: [true, true, true] });
  });

  it("70% ちょうどは合格（10 問中 7 問）", async () => {
    db.questions = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, quizId: "fin1", question: `問${i}`, options: ["x", "y"], correctIndex: 0, order: i }));
    const body = await (await submit("fin1", { answers: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1] })).json();
    assert.equal(body.score, 70);
    assert.equal(body.passed, true);
  });

  it("1 問のクイズ", async () => {
    const body = await (await submit("mini1a", { answers: [0] })).json();
    assert.deepEqual(body, { score: 100, passed: true, total: 1, correct: 1, results: [true] });
  });

  it("create の data：userId はセッションの値（body の userId・score・passed は使わない）、answers は検証済みの配列だけ", async () => {
    const res = await submit("fin1", { answers: [1, 0, 0], userId: OTHER, score: 100, passed: true, quizId: "fin2", extra: "x" });
    assert.equal(res.status, 200);
    assert.equal(creates().length, 1);
    const args = creates()[0].args;
    assert.deepEqual(args.data, { userId: STUDENT, quizId: "fin1", score: 67, passed: false, answers: [1, 0, 0] });
    assert.deepEqual(args.select, { id: true });
    const saved = db.attempts[db.attempts.length - 1];
    assert.equal(saved.userId, STUDENT);
  });

  it("成功時はログを出さない", async () => {
    const done = captureLogs();
    await submit("fin1", { answers: [1, 0, 2] });
    assert.equal(done(), "");
  });
});

describe("POST submit：エラー", () => {
  it("書き込みの例外なら 500 で、ログに回答・正解・メールアドレス・ID を出さない", async () => {
    failOn = "quizAttempt.create";
    failWith = piiError();
    const done = captureLogs();
    const res = await submit("fin1", { answers: [1, 1, 0] });
    const out = done();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assertSafeLog(out);
  });
});
