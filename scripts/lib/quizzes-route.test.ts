import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { isCourseLocked, type LessonCounts } from "../../src/lib/course-lock";

// #32 確認テストの API：GET /api/quizzes、GET /api/quizzes/[quizId]、POST /api/quizzes/[quizId]/submit。
// submit は QUIZ_ATTEMPTS_ENABLED が false の間 503 を返すので、採点・保存は本体の handleQuizSubmit に
// attemptsEnabled: true を渡して確かめる（route の POST 経由は 401 / 503 だけ）。
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
let HANDLE_SUBMIT: (
  userId: string,
  req: Request,
  ctx: { params: Promise<{ quizId: string }> },
  opts: { attemptsEnabled: boolean; role: string | null | undefined }
) => Promise<Response>;
let ATTEMPTS_ENABLED: boolean;

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
  ({ handleQuizSubmit: HANDLE_SUBMIT } = await import("../../src/lib/quiz-submit"));
  ({ QUIZ_ATTEMPTS_ENABLED: ATTEMPTS_ENABLED } = await import("../../src/lib/student-quizzes"));
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
      // 受講生に解放済みのコース（STEP2）に置く（ロック中のコースだと 409 より先に 403 になる。#47 P5）
      { id: "badkey", title: "正解が範囲外", type: "MINI", courseId: null, lessonId: "l2a" },
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
const submitRequest = (quizId: string, body: unknown, raw?: string) =>
  new Request(`https://nwa-lms.example.com/api/quizzes/${encodeURIComponent(quizId)}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
/** route の POST（QUIZ_ATTEMPTS_ENABLED の値のまま） */
const submitRoute = (quizId: string, body: unknown, raw?: string) => SUBMIT(submitRequest(quizId, body, raw), ctx(quizId));
/** 本体に attemptsEnabled: true を渡す（受験を公開したあとの動き）。userId は route と同じくセッションの値 */
const submit = (quizId: string, body: unknown, raw?: string) =>
  HANDLE_SUBMIT(session!.user.id!, submitRequest(quizId, body, raw), ctx(quizId), { attemptsEnabled: true, role: session!.user.role });
const creates = () => calls.filter((c) => c.method === "quizAttempt.create");
/** 問題を読んだ quiz.findUnique（ロックの確認で読む quiz.findUnique は questions を select しない。#47 P5） */
const questionReads = () => calls.filter((c) => c.method === "quiz.findUnique" && (c.args.select as Select | undefined)?.questions !== undefined);

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
  it("コースの順（order）に、修了テスト・ミニテスト（レッスン順）を振り分ける。問題 0 件・選択肢が壊れている・正解が範囲外・コースに属さないクイズは除く", async () => {
    const body = await (await LIST()).json();
    assert.deepEqual(
      body.courses.map((c: { id: string; finalQuizzes: Array<{ id: string }>; miniQuizzes: Array<{ id: string }> }) => [
        c.id,
        c.finalQuizzes.map((q) => q.id),
        c.miniQuizzes.map((q) => q.id),
      ]),
      [
        ["c1", ["fin1"], ["mini1a", "mini1b"]],
        ["c2", ["fin2"], []],
        ["c3", ["fin3"], []],
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

  it("コースは [order, id] で並べ、クイズの問題は受験できるかの確認に options・correctIndex だけを読む（問題文・回答は読まない）", async () => {
    await LIST();
    const courses = calls.find((c) => c.method === "course.findMany");
    assert.deepEqual(courses?.args.orderBy, [{ order: "asc" }, { id: "asc" }]);
    const quizzes = calls.find((c) => c.method === "quiz.findMany");
    const select = quizzes?.args.select as Select;
    assert.deepEqual(select.questions, { select: { options: true, correctIndex: true } });
    const { questions: _questions, ...rest } = select;
    assert.doesNotMatch(JSON.stringify(rest), /correctIndex|options|question"|answers|attempts/);
  });

  it("選択肢・正解の問題が 1 つでも壊れていればそのクイズは出さない（ほかの問題が正常でも）", async () => {
    db.questions.push({ id: "qbad", quizId: "fin1", question: "壊れ", options: "x,y", correctIndex: 0, order: 9 });
    db.questions.push({ id: "f2bad", quizId: "fin2", question: "範囲外", options: ["x", "y"], correctIndex: 2, order: 9 });
    const body = await (await LIST()).json();
    assert.deepEqual(
      body.courses.map((c: { id: string; finalQuizzes: Array<{ id: string }>; miniQuizzes: Array<{ id: string }> }) => [
        c.id,
        c.finalQuizzes.map((q) => q.id),
        c.miniQuizzes.map((q) => q.id),
      ]),
      [
        ["c1", [], ["mini1a", "mini1b"]],
        ["c3", ["fin3"], []],
      ]
    );
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
    ["correctIndex が範囲外", "badkey"],
  ]) {
    it(`${label}なら 409 quiz_unavailable`, async () => {
      const res = await getOne(id);
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "Quiz unavailable", reason: "quiz_unavailable" });
    });
  }

  it("correctIndex が範囲外のクイズは、一覧（除外）・submit（409）と同じく受験できない扱いで、問題も正解も返さない", async () => {
    const res = await getOne("badkey");
    assert.equal(res.status, 409);
    const text = await res.text();
    for (const s of ["correctIndex", "questions", "options", "範囲外", "bk1"]) assert.ok(!text.includes(s), s);
    const list = await (await LIST()).text();
    assert.ok(!list.includes("badkey"));
    assert.equal((await HANDLE_SUBMIT(STUDENT, submitRequest("badkey", { answers: [0] }), ctx("badkey"), { attemptsEnabled: true, role: "STUDENT" })).status, 409);
  });
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

  it("問題の select は受験できるかの判定に必要な項目だけ（correctIndex は判定用。応答には出ない）で、orderBy は [order, id]。受験記録は where userId・quizId で集計に必要な項目だけ", async () => {
    await getOne("fin1");
    const quiz = questionReads()[0];
    const questions = (quiz?.args.select as Select).questions as { orderBy: unknown; select: Select };
    assert.deepEqual(questions.orderBy, [{ order: "asc" }, { id: "asc" }]);
    assert.deepEqual(questions.select, { id: true, question: true, options: true, correctIndex: true });
    assert.doesNotMatch(JSON.stringify(quiz?.args), /attempts/);
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

describe("POST submit：route（受験の公開前）", () => {
  it("前提：QUIZ_ATTEMPTS_ENABLED は false", () => {
    assert.equal(ATTEMPTS_ENABLED, false);
  });

  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    assert.equal((await submitRoute("fin1", { answers: [1, 0, 2] })).status, 401);
    assert.equal(calls.length, 0);
  });

  it("user.id のないセッションも 401 で、DB を読まない", async () => {
    session = { user: { role: "STUDENT" } };
    assert.equal((await submitRoute("fin1", { answers: [1, 0, 2] })).status, 401);
    assert.equal(calls.length, 0);
  });

  it("ログイン済みでも 503 attempts_disabled で、DB を読まず・書かない", async () => {
    const res = await submitRoute("fin1", { answers: [1, 0, 2] });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "Quiz attempts are not available yet", reason: "attempts_disabled" });
    assert.equal(calls.length, 0);
    assert.equal(db.attempts.length, 5);
  });

  for (const [label, quizId, raw] of [
    ["壊れた JSON", "fin1", "{ answers: [1,"],
    ["空の quizId", "", '{"answers":[0]}'],
    ["存在しないクイズ", "missing", '{"answers":[0]}'],
    ["問題 0 件のクイズ", "empty", '{"answers":[0]}'],
  ] as Array<[string, string, string]>) {
    it(`${label}でも（入力を見ずに）503 で、DB を読まない`, async () => {
      const res = await submitRoute(quizId, undefined, raw);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).reason, "attempts_disabled");
      assert.equal(calls.length, 0);
    });
  }

  it("本体に attemptsEnabled: false を渡しても 503 で、DB を読まない", async () => {
    const res = await HANDLE_SUBMIT(STUDENT, submitRequest("fin1", { answers: [1, 0, 2] }), ctx("fin1"), { attemptsEnabled: false, role: "STUDENT" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).reason, "attempts_disabled");
    assert.equal(calls.length, 0);
  });

  it("route はセッションの user.id・user.role と QUIZ_ATTEMPTS_ENABLED を本体に渡す（ソース）", () => {
    const source = readFileSync(join(process.cwd(), "src/app/api/quizzes/[quizId]/submit/route.ts"), "utf8");
    assert.match(source, /handleQuizSubmit\(session\.user\.id, request, context, \{ attemptsEnabled: QUIZ_ATTEMPTS_ENABLED, role: session\.user\.role \}\)/);
    assert.doesNotMatch(source, /prisma/);
    // route ファイルは POST だけを export する
    assert.deepEqual(Array.from(source.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)).map((m) => m[1]), ["POST"]);
  });
});

describe("POST submit：認証・入力（attemptsEnabled: true）", () => {
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

describe("POST submit：採点と保存（attemptsEnabled: true）", () => {
  // fin1 の並び（[order, id]）：qz（正解 1）→ qa（正解 0）→ qb（正解 2）
  it("採点はサーバーで、GET と同じ並び。応答は score / passed / total / correct / results だけ", async () => {
    const res = await submit("fin1", { answers: [1, 0, 0] });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { score: 67, passed: false, total: 3, correct: 2, results: [true, true, false] });
    for (const k of ["correctIndex", "answers", "options", STUDENT]) assert.doesNotMatch(text, new RegExp(k), k);
    const quiz = questionReads()[0];
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

describe("POST submit：エラー（attemptsEnabled: true）", () => {
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

// ───────────── コースのロック（#47 P5） ─────────────
// 既定のデータ：STEP1（c1）を全部終えている → c1・c2 は解放、c3 はロック。
// fin3（c3 の修了テスト）は受講生にはロック中、orphan はどのコースにも属さない。

const LOCK_READS = ["course.findMany", "progress.findMany", "quiz.findUnique"];
const isLockedBody = (body: unknown) => {
  assert.deepEqual(body, { error: "Forbidden", reason: "course_locked" }, "403 の本文が { error, reason: course_locked } だけでない");
};

/** ロールが INSTRUCTOR と完全に一致しないセッション（受講生と同じくロックを確かめる） */
const NOT_INSTRUCTOR: Array<[string, FakeSession]> = [
  ["STUDENT", { user: { id: STUDENT, role: "STUDENT" } }],
  ["小文字の instructor", { user: { id: STUDENT, role: "instructor" } }],
  ["前後に空白のある INSTRUCTOR", { user: { id: STUDENT, role: " INSTRUCTOR " } }],
  ["ADMIN", { user: { id: STUDENT, role: "ADMIN" } }],
  ["空文字", { user: { id: STUDENT, role: "" } }],
  ["ロールなし", { user: { id: STUDENT } }],
];

describe("GET /api/quizzes/[quizId]：コースのロック（#47 P5）", () => {
  it("受講生のロック中のコースのクイズは 403 course_locked で、問題と受験記録を読まない", async () => {
    const res = await getOne("fin3");
    assert.equal(res.status, 403);
    isLockedBody(await res.json());
    assert.deepEqual(calls.map((c) => c.method).sort(), LOCK_READS, "ロックの判定以外を読んでいる");
    assert.equal(questionReads().length, 0, "問題を読んでいる");
    const quiz = calls.find((c) => c.method === "quiz.findUnique");
    assert.ok(quiz, "quiz.findUnique が呼ばれていない");
    assert.doesNotMatch(JSON.stringify(quiz.args), /question|options|correctIndex|attempts|title/, "ロックの確認でクイズの中身を読んでいる");
  });

  it("403 の本文に、クイズ名・問題・選択肢・コースの id を含まない", async () => {
    const text = await (await getOne("fin3")).text();
    for (const s of ["STEP3", "問3", "f3q", "c3", "fin3", "questions", "options", "correctIndex", STUDENT]) assert.ok(!text.includes(s), `403 の本文に ${s} が含まれる`);
  });

  it("ミニテストはレッスンのコースで判定する（ロック中のコースのレッスンのミニテストは 403）", async () => {
    db.quizzes.push({ id: "mini3", title: "L3 ミニ", type: "MINI", courseId: null, lessonId: "l3a" });
    db.questions.push({ id: "m3", quizId: "mini3", question: "ミニ3", options: ["x", "y"], correctIndex: 0, order: 1 });
    assert.equal((await getOne("mini3")).status, 403);
    assert.equal((await getOne("mini1a")).status, 200);
  });

  it("ロック中なら、受験できないクイズ（選択肢が壊れている）でも 409 より先に 403", async () => {
    db.quizzes.push({ id: "broken3", title: "壊れ3", type: "FINAL", courseId: "c3", lessonId: null });
    db.questions.push({ id: "br3", quizId: "broken3", question: "壊れ", options: ["only"], correctIndex: 0, order: 1 });
    assert.equal((await getOne("broken3")).status, 403);
  });

  it("解放済みのコース（前のコースを終えた STEP2）のクイズは 200", async () => {
    const res = await getOne("fin2");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, "fin2");
  });

  it("前のコース（STEP2）が未完了でも、STEP3 に完了が 1 件あれば解放", async () => {
    db.progress.push({ id: "p4", userId: STUDENT, lessonId: "l3a", completed: true });
    assert.equal((await getOne("fin3")).status, 200);
  });

  it("他の受講生の進捗では解放されない", async () => {
    db.progress = db.progress.filter((p) => p.userId !== STUDENT);
    db.progress.push({ id: "px", userId: OTHER, lessonId: "l1a", completed: true }, { id: "py", userId: OTHER, lessonId: "l1b", completed: true });
    assert.equal((await getOne("fin2")).status, 403);
    assert.equal((await getOne("fin1")).status, 200);
  });

  it("受講生には、どのコースにも属さないクイズ（一覧に出ない）は 404 で、問題を読まない", async () => {
    const res = await getOne("orphan");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Quiz not found" });
    assert.equal(questionReads().length, 0, "問題を読んでいる");
  });

  it("講師はロックを見ない（ロック中のコースのクイズも 200、コースと進捗を読まない）", async () => {
    session = INSTRUCTOR_SESSION;
    const res = await getOne("fin3");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, "fin3");
    assert.ok(!calls.some((c) => c.method === "course.findMany" || c.method === "progress.findMany"), "講師でロックを確かめている");
    assert.equal(calls.filter((c) => c.method === "quiz.findUnique").length, 1, "講師で quiz を 2 回読んでいる");
  });

  it("講師には、コースに属さないクイズもこれまでどおり返す", async () => {
    session = INSTRUCTOR_SESSION;
    assert.equal((await getOne("orphan")).status, 200);
  });

  for (const [label, s] of NOT_INSTRUCTOR) {
    it(`ロールが ${label} のセッションは受講生と同じくロックを確かめる（403）`, async () => {
      session = s;
      assert.equal((await getOne("fin3")).status, 403);
    });
  }

  it("403 のときはログを出さない", async () => {
    const done = captureLogs();
    await getOne("fin3");
    assert.equal(done(), "", "403 でログが出た");
  });

  it("ロックの確認の例外は 500 で、ログはエラーの名前だけ", async () => {
    failOn = "progress.findMany";
    failWith = piiError();
    const done = captureLogs();
    const res = await getOne("fin1");
    const out = done();
    assert.equal(res.status, 500);
    assertSafeLog(out);
  });
});

describe("POST submit：コースのロック（#47 P5、attemptsEnabled: true）", () => {
  it("受講生のロック中のコースのクイズは 403 course_locked で、正解を読まず・採点も保存もしない", async () => {
    const before = db.attempts.length;
    const res = await submit("fin3", { answers: [0] });
    assert.equal(res.status, 403);
    isLockedBody(await res.json());
    assert.equal(creates().length, 0, "受験記録を書いている");
    assert.equal(db.attempts.length, before, "受験記録が増えた");
    assert.equal(questionReads().length, 0, "問題（正解）を読んでいる");
    assert.deepEqual(calls.map((c) => c.method).sort(), LOCK_READS, "ロックの判定以外を読んでいる");
  });

  it("ロック中なら、回答の数・範囲が合っていなくても 400 ではなく 403（正解の数を推測させない）", async () => {
    for (const answers of [[0], [0, 1, 0, 1], [9]]) {
      const res = await submit("fin3", { answers });
      assert.equal(res.status, 403, `answers ${JSON.stringify(answers)} が 403 でない`);
    }
    assert.equal(creates().length, 0, "受験記録を書いている");
  });

  it("ロック中でも、body の形が壊れていれば DB を読まずに 400（今までどおり）", async () => {
    assert.equal((await submit("fin3", { answers: "0" })).status, 400);
    assert.equal(calls.length, 0, "DB を読んでいる");
  });

  it("何度送ってもロックは外れない（受験記録も進捗も書かない）", async () => {
    for (let i = 0; i < 5; i++) assert.equal((await submit("fin3", { answers: [0] })).status, 403, `${i + 1} 回目が 403 でない`);
    assert.equal((await getOne("fin3")).status, 403, "送信後にロックが外れた");
    assert.equal(creates().length, 0, "受験記録を書いている");
  });

  it("解放済みのコースのクイズは今までどおり採点・保存する", async () => {
    const res = await submit("fin2", { answers: [0] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { score: 100, passed: true, total: 1, correct: 1, results: [true] });
    assert.equal(creates().length, 1, "受験記録を書いていない");
  });

  it("受講生には、どのコースにも属さないクイズは 404 で、書き込まない", async () => {
    const res = await submit("orphan", { answers: [0] });
    assert.equal(res.status, 404);
    assert.equal(creates().length, 0, "受験記録を書いている");
    assert.equal(questionReads().length, 0, "問題を読んでいる");
  });

  it("講師はロックを見ない（ロック中のコースのクイズも採点・保存する）", async () => {
    session = INSTRUCTOR_SESSION;
    const res = await submit("fin3", { answers: [0] });
    assert.equal(res.status, 200);
    assert.equal(creates().length, 1, "講師の受験記録を書いていない");
    assert.ok(!calls.some((c) => c.method === "course.findMany" || c.method === "progress.findMany"), "講師でロックを確かめている");
  });

  for (const [label, s] of NOT_INSTRUCTOR) {
    it(`ロールが ${label} は受講生と同じく 403 で書き込まない`, async () => {
      session = s;
      assert.equal((await submit("fin3", { answers: [0] })).status, 403);
      assert.equal(creates().length, 0, "受験記録を書いている");
    });
  }

  it("本体に role を渡さない（undefined・null）ときも受講生として扱う", async () => {
    for (const role of [undefined, null]) {
      const res = await HANDLE_SUBMIT(STUDENT, submitRequest("fin3", { answers: [0] }), ctx("fin3"), { attemptsEnabled: true, role });
      assert.equal(res.status, 403, `role ${String(role)} が 403 でない`);
    }
    assert.equal(creates().length, 0, "受験記録を書いている");
  });

  it("attemptsEnabled が false なら、ロック中でも 503 で DB を読まない（今までどおり）", async () => {
    const res = await HANDLE_SUBMIT(STUDENT, submitRequest("fin3", { answers: [0] }), ctx("fin3"), { attemptsEnabled: false, role: "STUDENT" });
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0, "DB を読んでいる");
  });

  it("route（公開前）は、ロック中のクイズでも 503 で DB を読まない", async () => {
    const res = await submitRoute("fin3", { answers: [0] });
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0, "DB を読んでいる");
  });

  it("ロックの確認の例外は 500 で書き込まず、ログはエラーの名前だけ", async () => {
    failOn = "course.findMany";
    failWith = piiError();
    const done = captureLogs();
    const res = await submit("fin1", { answers: [1, 0, 2] });
    const out = done();
    assert.equal(res.status, 500);
    assert.equal(creates().length, 0, "受験記録を書いている");
    assertSafeLog(out);
  });
});

describe("コースのロック：lessonId と courseId が別のコースを指すクイズ（#47 P5）", () => {
  // c1・c2 は解放、c3 はロック。種類の側（FINAL は courseId、MINI はレッスン）だけで判定し、一覧と一致すること
  const CASES: Array<[string, Row, boolean]> = [
    ["FINAL：courseId は解放（c1）、lessonId はロック中（c3）", { id: "fx_open", title: "FX1", type: "FINAL", courseId: "c1", lessonId: "l3a" }, false],
    ["FINAL：courseId はロック中（c3）、lessonId は解放（c1）", { id: "fx_lock", title: "FX2", type: "FINAL", courseId: "c3", lessonId: "l1a" }, true],
    ["MINI：レッスンは解放（c1）、courseId はロック中（c3）", { id: "mx_open", title: "MX1", type: "MINI", courseId: "c3", lessonId: "l1a" }, false],
    ["MINI：レッスンはロック中（c3）、courseId は解放（c1）", { id: "mx_lock", title: "MX2", type: "MINI", courseId: "c1", lessonId: "l3a" }, true],
  ];

  for (const [label, quiz, locked] of CASES) {
    it(`${label}：一覧の locked と GET・submit が一致する（${locked ? "403" : "200"}）`, async () => {
      db.quizzes.push(quiz);
      db.questions.push({ id: `q_${quiz.id}`, quizId: quiz.id, question: "問", options: ["x", "y"], correctIndex: 0, order: 1 });
      const list = (await (await LIST()).json()) as { courses: Array<{ id: string; locked: boolean; finalQuizzes: Array<{ id: string }>; miniQuizzes: Array<{ id: string }> }> };
      const owner = list.courses.find((c) => [...c.finalQuizzes, ...c.miniQuizzes].some((q) => q.id === quiz.id));
      assert.ok(owner, `${quiz.id} が一覧に出ない`);
      assert.equal(owner.locked, locked, `一覧の locked が想定と違う（${owner.id}）`);
      assert.equal((await getOne(quiz.id as string)).status, locked ? 403 : 200, "GET が一覧の locked と違う");
      const before = creates().length;
      assert.equal((await submit(quiz.id as string, { answers: [0] })).status, locked ? 403 : 200, "submit が一覧の locked と違う");
      assert.equal(creates().length - before, locked ? 0 : 1, "受験記録の書き込みが一覧の locked と合わない");
    });
  }

  it("courseId のない FINAL・レッスンのない MINI は一覧に出ず、受講生の GET・submit は 404", async () => {
    db.quizzes.push(
      { id: "f_nocourse", title: "F", type: "FINAL", courseId: null, lessonId: "l1a" },
      { id: "m_nolesson", title: "M", type: "MINI", courseId: "c1", lessonId: null }
    );
    db.questions.push(
      { id: "q_fn", quizId: "f_nocourse", question: "問", options: ["x", "y"], correctIndex: 0, order: 1 },
      { id: "q_mn", quizId: "m_nolesson", question: "問", options: ["x", "y"], correctIndex: 0, order: 1 }
    );
    const text = await (await LIST()).text();
    for (const id of ["f_nocourse", "m_nolesson"]) {
      assert.ok(!text.includes(id), `${id} が一覧に出ている`);
      assert.equal((await getOne(id)).status, 404, `${id} の GET が 404 でない`);
      assert.equal((await submit(id, { answers: [0] })).status, 404, `${id} の submit が 404 でない`);
    }
    assert.equal(creates().length, 0, "受験記録を書いている");
  });
});

describe("コースのロック：一覧の locked・GET・submit と isCourseLocked の照合（乱数。#47 P5）", () => {
  /** シード固定の乱数（mulberry32） */
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("80 通りのコース構成（レッスン 0 件のコース・同じ order・他人の進捗を含む）で一致する", async () => {
    const rand = rng(4705);
    const pick = (n: number) => Math.floor(rand() * n);
    let checked = 0;
    let lockedSeen = 0;
    for (let trial = 0; trial < 80; trial++) {
      const courses: Row[] = [];
      const sections: Row[] = [];
      const lessons: Row[] = [];
      const quizzes: Row[] = [];
      const questions: Row[] = [];
      const nCourses = 1 + pick(4);
      for (let ci = 0; ci < nCourses; ci++) {
        const cid = `r${trial}_${String.fromCharCode(97 + pick(26))}${ci}`;
        courses.push({ id: cid, name: `C${ci}`, order: pick(3), icon: "it", color: "#000000" });
        quizzes.push({ id: `fin_${cid}`, title: `F${ci}`, type: "FINAL", courseId: cid, lessonId: null });
        const nSections = pick(3);
        for (let si = 0; si < nSections; si++) {
          const sid = `${cid}_s${si}`;
          sections.push({ id: sid, courseId: cid, title: sid, order: si });
          for (let li = 0; li < pick(3); li++) {
            const lid = `${sid}_l${li}`;
            lessons.push({ id: lid, sectionId: sid, title: lid, order: li, type: "TEXT" });
            quizzes.push({ id: `mini_${lid}`, title: `M${lid}`, type: "MINI", courseId: null, lessonId: lid });
          }
        }
      }
      // 種類と違う側の列にも、別のコース・レッスンをランダムに入れる（一覧と API が同じ側だけを見ることを確かめる）
      for (const q of quizzes) {
        if (q.type === "FINAL" && lessons.length > 0 && rand() < 0.5) q.lessonId = lessons[pick(lessons.length)].id;
        if (q.type === "MINI" && rand() < 0.5) q.courseId = courses[pick(courses.length)].id;
      }
      for (const q of quizzes) questions.push({ id: `q_${q.id}`, quizId: q.id, question: "問", options: ["x", "y"], correctIndex: 0, order: 1 });
      const progress: Row[] = [];
      for (const l of lessons) {
        const r = rand();
        if (r < 0.4) progress.push({ id: `p_${l.id}`, userId: STUDENT, lessonId: l.id, completed: true });
        else if (r < 0.5) progress.push({ id: `p_${l.id}`, userId: STUDENT, lessonId: l.id, completed: false });
        else if (r < 0.7) progress.push({ id: `p_${l.id}`, userId: OTHER, lessonId: l.id, completed: true });
      }
      db = { courses, sections, lessons, progress, quizzes, questions, attempts: [] };

      // 正解：[order, id] の順に並べ、直前のコースの件数と isCourseLocked で判定する
      const done = new Set(progress.filter((p) => p.userId === STUDENT && p.completed === true).map((p) => p.lessonId));
      const sorted = [...courses].sort((a, b) => (a.order as number) - (b.order as number) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const lockedByCourse = new Map<string, boolean>();
      let prev: LessonCounts | null = null;
      for (const c of sorted) {
        const ls = lessons.filter((l) => sections.some((s) => s.id === l.sectionId && s.courseId === c.id));
        const counts = { totalLessons: ls.length, completedLessons: ls.filter((l) => done.has(l.id)).length };
        lockedByCourse.set(c.id as string, isCourseLocked(prev, counts));
        prev = counts;
      }

      session = STUDENT_SESSION;
      const list = (await (await LIST()).json()) as { courses: Array<{ id: string; locked: boolean; finalQuizzes: Array<{ id: string }>; miniQuizzes: Array<{ id: string }> }> };
      for (const c of list.courses) {
        const want = lockedByCourse.get(c.id);
        assert.equal(c.locked, want, `trial ${trial} course ${c.id}: 一覧の locked が isCourseLocked と違う`);
        for (const q of [...c.finalQuizzes, ...c.miniQuizzes]) {
          const status = (await getOne(q.id)).status;
          assert.equal(status, want ? 403 : 200, `trial ${trial} quiz ${q.id}: GET が一覧の locked と違う`);
          const sub = (await submit(q.id, { answers: [0] })).status;
          assert.equal(sub, want ? 403 : 200, `trial ${trial} quiz ${q.id}: submit が一覧の locked と違う`);
          checked++;
          if (want) lockedSeen++;
        }
      }
      // 一覧に出るクイズの数（全コースのクイズ。どれも受験できる）
      assert.equal(
        list.courses.reduce((n, c) => n + c.finalQuizzes.length + c.miniQuizzes.length, 0),
        quizzes.length,
        `trial ${trial}: 一覧のクイズの数が違う`
      );
      // 書いた受験記録は解放済みのクイズの分だけ
      assert.ok(
        db.attempts.every((a) => {
          const q = quizzes.find((x) => x.id === a.quizId);
          const lesson = q?.lessonId ? lessons.find((l) => l.id === q.lessonId) : undefined;
          const cid = q?.type === "MINI" && lesson ? (sections.find((s) => s.id === lesson.sectionId)?.courseId as string) : (q?.courseId as string);
          return lockedByCourse.get(cid) === false;
        }),
        `trial ${trial}: ロック中のクイズの受験記録が書かれた`
      );
    }
    assert.ok(checked > 200, `照合したクイズが少ない: ${checked}`);
    assert.ok(lockedSeen > 0 && lockedSeen < checked, `locked と ok の両方を照合できていない: ${lockedSeen}/${checked}`);
  });
});
