import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #51 PR 2：受験を止めるスイッチ（QUIZ_ATTEMPTS_ENABLED を false にしたとき）を、本体ではなく route ごと確かめる。
// 本番の値は true なので、このファイルだけ CommonJS のモジュールキャッシュの src/lib/student-quizzes.ts を
// 「本物の export ＋ QUIZ_ATTEMPTS_ENABLED: false」に差し替えてから route を import する（ほかの関数は本物）。
// node --test はファイルごとに別のプロセスで動くので、ほかのテストファイルには影響しない。
// 確かめること：
//   - 止めても未ログインは 401（503 ではない。停止中であることも知らせない）で、body も DB も読まない
//   - ログイン済みは受講生も講師も 503 attempts_disabled で、body も DB も読まない（不正な入力・ロック中・存在しないクイズでも）
//   - 一覧（GET /api/quizzes）と問題の取得（GET /api/quizzes/[quizId]）は止まらない
// DB・ネットワークなし。prisma は globalThis.prisma に置く偽物。NextAuth は installFakeAuth で差し替える。
// 鍵はダミーの AUTH_SECRET から作る（本物の値は使わない）。データはすべてダミー。

const DUMMY_AUTH_SECRET = "dummy-auth-secret-for-quiz-disabled-tests";

type Row = Record<string, unknown>;
type Select = Record<string, unknown>;
type Call = { method: string; args: Row };

let session: FakeSession;
let calls: Call[];
let db: { courses: Row[]; sections: Row[]; lessons: Row[]; progress: Row[]; quizzes: Row[]; questions: Row[]; attempts: Row[] };

let LIST: () => Promise<Response>;
let GET_ONE: (req: Request, ctx: { params: Promise<{ quizId: string }> }) => Promise<Response>;
let SUBMIT: (req: Request, ctx: { params: Promise<{ quizId: string }> }) => Promise<Response>;
let REAL_ENABLED: boolean;
let SEEN_ENABLED: unknown;

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
      const av = a[k] as string | number;
      const bv = b[k] as string | number;
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
    return sortRows(rows().filter((r) => matchWhere(r, args.where)), args.orderBy).map((r) => project(model, r, args.select as Select | undefined));
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
      return q ? project("quiz", q, args.select as Select | undefined) : null;
    },
  },
  quizAttempt: {
    findMany: findMany("attempt", "quizAttempt.findMany", () => db.attempts),
    async create(args: Row) {
      calls.push({ method: "quizAttempt.create", args });
      throw new Error("fake prisma: create must not be called while attempts are disabled");
    },
  },
};

let restoreSwap: (() => void) | null = null;

after(() => {
  restoreSwap?.();
});

before(async () => {
  process.env.AUTH_SECRET = DUMMY_AUTH_SECRET;
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);

  // 本物の student-quizzes を読み、キャッシュの exports を「本物 ＋ QUIZ_ATTEMPTS_ENABLED: false」に置き換える
  const real = (await import("../../src/lib/student-quizzes")) as unknown as Row;
  REAL_ENABLED = real.QUIZ_ATTEMPTS_ENABLED as boolean;
  const sqPath = join(process.cwd(), "src/lib/student-quizzes.ts");
  const cache = (Module as unknown as { _cache: Record<string, { exports: unknown } | undefined> })._cache;
  const entry = cache[sqPath];
  if (!entry) throw new Error("student-quizzes がモジュールキャッシュにない（差し替えられない）");
  const swapped: Row = { ...real, QUIZ_ATTEMPTS_ENABLED: false };
  Object.defineProperty(swapped, "__esModule", { value: true });
  restoreSwap = () => {
    // 差し替えを戻し、false を読み込んだ route もキャッシュから外す
    // （tsx --test はファイルごとに別プロセスなので漏れない。戻せるのは require のキャッシュだけで、import() の ESM 側の
    //  キャッシュは戻せないので、テストを同じプロセスで動かす設定にはしない）
    entry.exports = entry_original;
    for (const rel of ["src/app/api/quizzes/route.ts", "src/app/api/quizzes/[quizId]/route.ts", "src/app/api/quizzes/[quizId]/submit/route.ts"]) {
      delete cache[join(process.cwd(), rel)];
    }
  };
  const entry_original = entry.exports;
  entry.exports = swapped;

  ({ GET: LIST } = await import("../../src/app/api/quizzes/route"));
  ({ GET: GET_ONE } = await import("../../src/app/api/quizzes/[quizId]/route"));
  ({ POST: SUBMIT } = await import("../../src/app/api/quizzes/[quizId]/submit/route"));
  // route と同じ経路（require）で読んだときの値（差し替えが効いているか）。
  // import() は Node の ESM 側の名前空間を別にキャッシュするので、ここでは使わない
  SEEN_ENABLED = (Module.createRequire(join(process.cwd(), "package.json"))(sqPath) as Row).QUIZ_ATTEMPTS_ENABLED;
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
      { id: "s1", courseId: "c1", title: "S1", order: 1 },
      { id: "s2", courseId: "c2", title: "S2", order: 1 },
    ],
    lessons: [
      { id: "l1", sectionId: "s1", title: "ダミーレッスン1", order: 1 },
      { id: "l2", sectionId: "s2", title: "ダミーレッスン2", order: 1 },
    ],
    progress: [],
    quizzes: [
      { id: "mini1", title: "ダミーミニ", type: "MINI", courseId: null, lessonId: "l1" },
      // STEP2 は STEP1 が未完了なので受講生にはロック中
      { id: "fin2", title: "ダミー修了2", type: "FINAL", courseId: "c2", lessonId: null },
    ],
    questions: [
      { id: "q1", quizId: "mini1", question: "ダミー問1", options: ["a", "b", "c"], correctIndex: 0, order: 1 },
      { id: "q2", quizId: "fin2", question: "ダミー問2", options: ["x", "y"], correctIndex: 1, order: 1 },
    ],
    attempts: [],
  };
});

const ctx = (quizId: string) => ({ params: Promise.resolve({ quizId }) });
const submitRequest = (quizId: string, raw: string) =>
  new Request(`https://nwa-lms.example.com/api/quizzes/${encodeURIComponent(quizId)}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
/** 形の正しい body（トークンは形だけ正しいダミー。503 なら中身は見られない） */
const VALID_SHAPE = JSON.stringify({ answers: [0], questionIds: ["q1"], attemptToken: `v1.${"A".repeat(22)}.${"B".repeat(43)}`, userId: "stu_other" });

function captureLogs() {
  const spies = [mock.method(console, "error", () => {}), mock.method(console, "log", () => {}), mock.method(console, "warn", () => {})];
  return () => {
    const args = spies.flatMap((m) => m.mock.calls.flatMap((c) => c.arguments));
    for (const s of spies) s.mock.restore();
    return args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ");
  };
}

describe("前提：このファイルでは route が QUIZ_ATTEMPTS_ENABLED を false として読む", () => {
  it("本物（src/lib/student-quizzes.ts）の値は true、差し替え後に route と同じ経路（require）で読む値は false", () => {
    assert.equal(REAL_ENABLED, true);
    assert.equal(SEEN_ENABLED, false);
  });

  it("route のソースは QUIZ_ATTEMPTS_ENABLED を @/lib/student-quizzes から import して本体に渡す（差し替えが届く経路）", () => {
    const source = readFileSync(join(process.cwd(), "src/app/api/quizzes/[quizId]/submit/route.ts"), "utf8");
    assert.match(source, /import \{ QUIZ_ATTEMPTS_ENABLED \} from "@\/lib\/student-quizzes";/);
    assert.match(source, /attemptsEnabled: QUIZ_ATTEMPTS_ENABLED/);
  });

  it("GET /api/quizzes と GET /api/quizzes/[quizId] のソースは QUIZ_ATTEMPTS_ENABLED を見ない（止めても GET は止まらない）", () => {
    for (const f of ["src/app/api/quizzes/route.ts", "src/app/api/quizzes/[quizId]/route.ts"]) {
      assert.ok(!readFileSync(join(process.cwd(), f), "utf8").includes("QUIZ_ATTEMPTS_ENABLED"), `${f} が QUIZ_ATTEMPTS_ENABLED を見ている`);
    }
  });
});

describe("POST submit（route、受験を止めたとき）", () => {
  it("未ログインは 401 で、停止中であることを知らせない。body も DB も読まない", async () => {
    session = null;
    const req = submitRequest("mini1", VALID_SHAPE);
    const done = captureLogs();
    const res = await SUBMIT(req, ctx("mini1"));
    assert.equal(done(), "", "ログを出した");
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: "Unauthorized" });
    assert.ok(!JSON.stringify(body).includes("attempts_disabled"), "401 に停止中の理由が入っている");
    assert.equal(req.bodyUsed, false, "body を読んだ");
    assert.equal(calls.length, 0, "DB を読んだ");
  });

  it("session.user に id がないときも 401（503 にしない）", async () => {
    session = { user: { role: "STUDENT" } };
    const res = await SUBMIT(submitRequest("mini1", VALID_SHAPE), ctx("mini1"));
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0, "DB を読んだ");
  });

  it("受講生は正しい形の body でも 503 attempts_disabled で、body も DB も読まず、記録しない。ログも出さない", async () => {
    const req = submitRequest("mini1", VALID_SHAPE);
    const done = captureLogs();
    const res = await SUBMIT(req, ctx("mini1"));
    assert.equal(done(), "", "ログを出した");
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "Quiz attempts are not available yet", reason: "attempts_disabled" });
    assert.equal(req.bodyUsed, false, "body を読んだ");
    assert.equal(calls.length, 0, "DB を読んだ");
    assert.equal(db.attempts.length, 0);
  });

  it("講師でも 503（止めるスイッチは役割に関係なく効く）", async () => {
    session = INSTRUCTOR_SESSION;
    const req = submitRequest("mini1", VALID_SHAPE);
    const res = await SUBMIT(req, ctx("mini1"));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).reason, "attempts_disabled");
    assert.equal(req.bodyUsed, false, "body を読んだ");
    assert.equal(calls.length, 0, "DB を読んだ");
  });

  for (const [label, quizId, raw] of [
    ["壊れた JSON", "mini1", "{ answers: [0"],
    ["空の quizId", "", VALID_SHAPE],
    ["形の違う body", "mini1", '{"answers":"x"}'],
    ["存在しないクイズ", "missing", VALID_SHAPE],
    ["ロック中のコースのクイズ", "fin2", VALID_SHAPE],
  ] as Array<[string, string, string]>) {
    it(`${label}でも（入力を見ずに）503 で、DB を読まない`, async () => {
      const res = await SUBMIT(submitRequest(quizId, raw), ctx(quizId));
      assert.equal(res.status, 503);
      assert.equal((await res.json()).reason, "attempts_disabled");
      assert.equal(calls.length, 0, "DB を読んだ");
    });
  }

  it("AUTH_SECRET がなくても 503（鍵より先に止まる）", async () => {
    const saved = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      const res = await SUBMIT(submitRequest("mini1", VALID_SHAPE), ctx("mini1"));
      assert.equal(res.status, 503);
    } finally {
      process.env.AUTH_SECRET = saved;
    }
  });
});

describe("GET は止まらない（受験を止めたとき）", () => {
  it("GET /api/quizzes は 200 で一覧を返す（受講生のロックも付く）", async () => {
    const res = await LIST();
    assert.equal(res.status, 200);
    const { courses } = (await res.json()) as { courses: Array<Row & { miniQuizzes: Row[]; finalQuizzes: Row[] }> };
    assert.deepEqual(courses.map((c) => [c.id, c.locked]), [["c1", false], ["c2", true]]);
    assert.equal(courses[0].miniQuizzes[0].id, "mini1");
  });

  it("GET /api/quizzes/[quizId] は 200 で問題・トークンを返す（受講生）", async () => {
    const res = await GET_ONE(new Request("https://nwa-lms.example.com/api/quizzes/mini1"), ctx("mini1"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const j = await res.json();
    assert.equal(j.id, "mini1");
    assert.equal(j.questions.length, 1);
    assert.deepEqual([...j.questions[0].options].sort(), ["a", "b", "c"]);
    assert.match(j.attemptToken, /^v1\./);
    assert.ok(!JSON.stringify(j).includes("correctIndex"), "応答に correctIndex が含まれる");
  });

  it("GET /api/quizzes/[quizId] のロック（403 course_locked）と未ログイン（401）もそのまま", async () => {
    const locked = await GET_ONE(new Request("https://nwa-lms.example.com/api/quizzes/fin2"), ctx("fin2"));
    assert.equal(locked.status, 403);
    assert.equal((await locked.json()).reason, "course_locked");
    session = null;
    const anon = await GET_ONE(new Request("https://nwa-lms.example.com/api/quizzes/mini1"), ctx("mini1"));
    assert.equal(anon.status, 401);
  });
});
