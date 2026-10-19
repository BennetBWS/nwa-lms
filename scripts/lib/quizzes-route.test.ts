import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { join } from "node:path";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { isCourseLocked, type LessonCounts } from "../../src/lib/course-lock";
import { deriveQuizKeys, issueAttemptToken, optionPermutation } from "../../src/lib/quiz-shuffle";

// #32 確認テストの API：GET /api/quizzes、GET /api/quizzes/[quizId]、POST /api/quizzes/[quizId]/submit。
// submit は QUIZ_ATTEMPTS_ENABLED が false の間 503 を返すので、採点・保存は本体の handleQuizSubmit に
// attemptsEnabled: true を渡して確かめる（route の POST 経由は 401 / 503 だけ）。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数を記録し、where（値の一致）・orderBy・select（入れ子のリレーションと _count）を最低限だけ再現する）。
// NextAuth は installFakeAuth で差し替える。データはすべてダミー（example.com）。
// 選択肢のシャッフル（#51 追加修正）の鍵は、ダミーの AUTH_SECRET から作る（本物の値は使わない）。
// submit の helper は、テストが書いた「元の位置」の回答を、同じ鍵で作ったトークンの並びの「表示位置」に直して送る。

const DUMMY_AUTH_SECRET = "dummy-auth-secret-for-quiz-route-tests";
const KEYS = deriveQuizKeys(DUMMY_AUTH_SECRET);
/** helper が使う決まった nonce（base64url 22 字）。同じ nonce なら同じトークン・同じ並び */
const TEST_NONCE = Buffer.alloc(16, 7).toString("base64url");

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
  opts: { attemptsEnabled: boolean; role: string | null | undefined; now?: Date }
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
    if (typeof v === "object" && v !== null) {
      // 受験記録の期間（createdAt: { gt: Date }。#51）だけを再現する
      const keys = Object.keys(v);
      const gt = (v as { gt?: unknown }).gt;
      if (keys.length !== 1 || !(gt instanceof Date) || !(row[k] instanceof Date)) throw new Error(`fake prisma: unsupported where ${k}`);
      return (row[k] as Date).getTime() > gt.getTime();
    }
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
    const taken = typeof args.take === "number" ? hit.slice(0, args.take) : hit;
    return taken.map((r) => project(model, r, args.select as Select | undefined));
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
  process.env.AUTH_SECRET = DUMMY_AUTH_SECRET;
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
  submitNow = new Date(BASE);
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
/** いまのダミーのデータで、そのクイズの問題の id を GET と同じ並び（[order, id]）で返す */
const serverQuestionIds = (quizId: string) =>
  sortRows(db.questions.filter((q) => q.quizId === quizId), [{ order: "asc" }, { id: "asc" }]).map((q) => q.id as string);
/** いまのダミーのデータで、そのクイズの問題（[order, id] の順）の id と選択肢。トークンの MAC が覆う内容 */
const serverQuestions = (quizId: string) =>
  sortRows(db.questions.filter((q) => q.quizId === quizId), [{ order: "asc" }, { id: "asc" }]).map((q) => ({
    id: q.id as string,
    options: (Array.isArray(q.options) ? q.options : []) as string[],
  }));
/** いまのデータで、GET と同じ手順のトークンを作る（userId は既定でセッションの値） */
const tokenFor = (quizId: string, userId: string = session!.user.id!, nonce: string = TEST_NONCE) =>
  issueAttemptToken(KEYS, { userId, quizId, questions: serverQuestions(quizId) }, nonce);
/** そのトークン（nonce）で表示される、問題 i の並べ替え（perm[表示位置] = 元の位置） */
const permFor = (quizId: string, i: number, userId: string = session!.user.id!, nonce: string = TEST_NONCE) => {
  const q = serverQuestions(quizId)[i];
  return optionPermutation(KEYS.shuffleKey, { userId, quizId, questionId: q.id, nonce, n: q.options.length });
};
/**
 * 元の位置の回答を表示位置に直す。範囲内の整数でない要素（不正な回答のテスト）と、長さが問題数と違う回答はそのまま
 */
const toDisplayed = (quizId: string, answers: unknown, userId: string = session!.user.id!, nonce: string = TEST_NONCE): unknown => {
  const qs = serverQuestions(quizId);
  if (!Array.isArray(answers) || answers.length !== qs.length) return answers;
  return answers.map((a, i) => {
    if (typeof a !== "number" || !Number.isInteger(a) || a < 0 || a >= qs[i].options.length) return a;
    return permFor(quizId, i, userId, nonce).indexOf(a);
  });
};
/** 送信の時刻（#51 の間隔・回数の判定に使う）。ダミーの受験記録・偽 create の日時と同じ BASE */
let submitNow: Date;
/**
 * 本体に attemptsEnabled: true を渡す（受験を公開したあとの動き）。userId は route と同じくセッションの値。
 * body が questionIds を持たないオブジェクトなら、画面と同じく、いまの問題の id（[order, id] の順）を足して送る（#51）。
 * attemptToken を持たなければ、決まった nonce のトークンを足し、answers（元の位置）をその並びの表示位置に直して送る
 * （#51 選択肢のシャッフル。採点・保存・重複判定は元の位置で行われるので、テストの期待値は元の位置のまま書ける）。
 * questionIds の検証そのものは submitExact（questionIds を足さない）で確かめる
 */
const submit = (quizId: string, body: unknown, raw?: string) => {
  if (raw !== undefined || typeof body !== "object" || body === null || Array.isArray(body)) return submitExact(quizId, body, raw);
  const b = { ...(body as Row) };
  if (!("questionIds" in b)) b.questionIds = serverQuestionIds(quizId);
  if (!("attemptToken" in b)) {
    b.attemptToken = tokenFor(quizId);
    b.answers = toDisplayed(quizId, b.answers);
  }
  return submitRaw(quizId, b);
};
/**
 * questionIds を足さずに送る。attemptToken がなければ、いまのデータのトークンだけを足す（answers は直さない）。
 * トークンの検証そのものは submitRaw（何も足さない）で確かめる
 */
const submitExact = (quizId: string, body: unknown, raw?: string) => {
  const b =
    raw === undefined && typeof body === "object" && body !== null && !Array.isArray(body) && !("attemptToken" in body)
      ? { ...(body as Row), attemptToken: tokenFor(quizId) }
      : body;
  return submitRaw(quizId, b, raw);
};
/** body をそのまま送る（何も足さない） */
const submitRaw = (quizId: string, body: unknown, raw?: string) =>
  HANDLE_SUBMIT(session!.user.id!, submitRequest(quizId, body, raw), ctx(quizId), { attemptsEnabled: true, role: session!.user.role, now: submitNow });
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
    assert.equal((await HANDLE_SUBMIT(STUDENT, submitRequest("badkey", { answers: [0], questionIds: ["bk1"], attemptToken: tokenFor("badkey", STUDENT) }), ctx("badkey"), { attemptsEnabled: true, role: "STUDENT" })).status, 409);
  });
});

describe("GET /api/quizzes/[quizId]：応答", () => {
  it("問題は [order, id] の順で、id・question・options（トークンの並びに並べ替え済み）と attemptToken だけ。受験記録は自分の分の集計値だけ", async () => {
    const res = await getOne("fin1");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const body = await res.json();
    assert.match(body.attemptToken, /^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    const nonce = body.attemptToken.split(".")[1];
    // トークンは GET と同じ手順で作ったものと一致する（MAC は元の並びの選択肢を覆う）
    assert.equal(body.attemptToken, tokenFor("fin1", STUDENT, nonce));
    const shuffled = (i: number, options: string[]) => permFor("fin1", i, STUDENT, nonce).map((o) => options[o]);
    assert.deepEqual(body, {
      id: "fin1",
      title: "STEP1 修了テスト",
      type: "FINAL",
      questionCount: 3,
      questions: [
        { id: "qz", question: "問Z", options: shuffled(0, ["z0", "z1"]) },
        { id: "qa", question: "問A", options: shuffled(1, ["a0", "a1", "a2", "a3"]) },
        { id: "qb", question: "問B", options: shuffled(2, ["b0", "b1", "b2"]) },
      ],
      attemptToken: body.attemptToken,
      attemptCount: 2,
      bestScore: 67,
      passed: false,
      // 受験記録はどれも 24 時間より前（BASE は過去の日時。GET は実際の時刻で判定する）
      retryAfterSeconds: null,
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
  it("採点はサーバーで、GET と同じ並び。応答は score / passed / total / correct / results / duplicate だけ", async () => {
    const res = await submit("fin1", { answers: [1, 0, 0] });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { score: 66, passed: false, total: 3, correct: 2, results: [true, true, false], duplicate: false });
    for (const k of ["correctIndex", "answers", "options", STUDENT]) assert.doesNotMatch(text, new RegExp(k), k);
    const quiz = questionReads()[0];
    const questions = (quiz?.args.select as Select).questions as { orderBy: unknown; select: Select };
    assert.deepEqual(questions.orderBy, [{ order: "asc" }, { id: "asc" }]);
    // id は questionIds の照合（#51）に使う
    assert.deepEqual(questions.select, { id: true, options: true, correctIndex: true });
  });

  it("全問正解は 100 点で合格", async () => {
    const body = await (await submit("fin1", { answers: [1, 0, 2] })).json();
    assert.deepEqual(body, { score: 100, passed: true, total: 3, correct: 3, results: [true, true, true], duplicate: false });
  });

  it("70% ちょうどは合格（10 問中 7 問）", async () => {
    db.questions = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, quizId: "fin1", question: `問${i}`, options: ["x", "y"], correctIndex: 0, order: i }));
    const body = await (await submit("fin1", { answers: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1] })).json();
    assert.equal(body.score, 70);
    assert.equal(body.passed, true);
  });

  it("1 問のクイズ", async () => {
    const body = await (await submit("mini1a", { answers: [0] })).json();
    assert.deepEqual(body, { score: 100, passed: true, total: 1, correct: 1, results: [true], duplicate: false });
  });

  it("create の data：userId はセッションの値（body の userId・score・passed は使わない）、answers は検証済みの配列だけ", async () => {
    const res = await submit("fin1", { answers: [1, 0, 0], userId: OTHER, score: 100, passed: true, quizId: "fin2", extra: "x" });
    assert.equal(res.status, 200);
    assert.equal(creates().length, 1);
    const args = creates()[0].args;
    assert.deepEqual(args.data, { userId: STUDENT, quizId: "fin1", score: 66, passed: false, answers: [1, 0, 0] });
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
    assert.deepEqual(await res.json(), { score: 100, passed: true, total: 1, correct: 1, results: [true], duplicate: false });
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
      const res = await HANDLE_SUBMIT(STUDENT, submitRequest("fin3", { answers: [0], questionIds: ["f3q"], attemptToken: tokenFor("fin3", STUDENT) }), ctx("fin3"), { attemptsEnabled: true, role });
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

// ───────────── コースのロック：追加の観点（tester。#47 P5） ─────────────

describe("コースのロック：追加の観点（#47 P5）", () => {
  it("ロールが null のセッションも受講生として扱い、GET・submit とも 403 で書き込まない", async () => {
    session = { user: { id: STUDENT, role: null } } as unknown as FakeSession;
    const g = await getOne("fin3");
    assert.equal(g.status, 403, "GET が 403 でない");
    isLockedBody(await g.json());
    const s = await submit("fin3", { answers: [0] });
    assert.equal(s.status, 403, "submit が 403 でない");
    isLockedBody(await s.json());
    assert.equal(creates().length, 0, "受験記録を書いている");
    assert.equal(questionReads().length, 0, "問題を読んでいる");
  });

  it("ロック中の GET の 403 では、受験記録（quizAttempt.findMany）を読まない", async () => {
    await getOne("fin3");
    assert.ok(!calls.some((c) => c.method === "quizAttempt.findMany"), "受験記録を読んでいる");
  });

  for (const target of ["GET", "submit"] as const) {
    it(`${target}：ロックの確認で quiz を読む段階の例外も 500 で、書き込まず、ログはエラーの名前だけ`, async () => {
      failOn = "quiz.findUnique";
      failWith = piiError();
      const done = captureLogs();
      const res = target === "GET" ? await getOne("fin1") : await submit("fin1", { answers: [1, 0, 2] });
      const out = done();
      assert.equal(res.status, 500, "500 でない");
      assert.deepEqual(await res.json(), { error: "Internal server error" }, "500 の本文が想定と違う");
      assert.equal(creates().length, 0, "受験記録を書いている");
      assert.ok(!calls.some((c) => c.method === "course.findMany" || c.method === "progress.findMany"), "例外のあとも読み続けている");
      assertSafeLog(out);
    });
  }

  it("FINAL の courseId が存在しないコースを指すクイズは、一覧に出ず、受講生の GET・submit は 404 で問題を読まない", async () => {
    db.quizzes.push({ id: "f_ghost", title: "消えたコース", type: "FINAL", courseId: "c_deleted", lessonId: null });
    db.questions.push({ id: "q_ghost", quizId: "f_ghost", question: "問", options: ["x", "y"], correctIndex: 0, order: 1 });
    assert.ok(!(await (await LIST()).text()).includes("f_ghost"), "一覧に出ている");
    calls = [];
    assert.equal((await getOne("f_ghost")).status, 404, "GET が 404 でない");
    assert.equal((await submit("f_ghost", { answers: [0] })).status, 404, "submit が 404 でない");
    assert.equal(questionReads().length, 0, "問題を読んでいる");
    assert.equal(creates().length, 0, "受験記録を書いている");
  });

  it("ロックの確認のあとにクイズが消えても、GET・submit は 404（500 にならない）で書き込まない", async () => {
    for (const target of ["GET", "submit"] as const) {
      db.quizzes.push({ id: "f_vanish", title: "消える", type: "FINAL", courseId: "c1", lessonId: null });
      db.questions.push({ id: "q_vanish", quizId: "f_vanish", question: "問", options: ["x", "y"], correctIndex: 0, order: 1 });
      const m = mock.method(fakePrisma.progress, "findMany", async (args: Row) => {
        record("progress.findMany", args);
        db.quizzes = db.quizzes.filter((q) => q.id !== "f_vanish");
        return db.progress.filter((p) => matchWhere(p, args.where)).map((p) => project("progress", p, args.select as Select | undefined));
      });
      try {
        const res = target === "GET" ? await getOne("f_vanish") : await submit("f_vanish", { answers: [0] });
        assert.equal(res.status, 404, `${target} が 404 でない`);
      } finally {
        m.mock.restore();
      }
    }
    assert.equal(creates().length, 0, "受験記録を書いている");
  });

  it("ロック中のコースのレッスンに completed: false の進捗があっても解放されない", async () => {
    db.progress.push({ id: "p_nc", userId: STUDENT, lessonId: "l3a", completed: false });
    assert.equal((await getOne("fin3")).status, 403, "GET が 403 でない");
    assert.equal((await submit("fin3", { answers: [0] })).status, 403, "submit が 403 でない");
    assert.equal(creates().length, 0, "受験記録を書いている");
  });

  it("前のコース（STEP2）を全部終えると、ロック中だったクイズも GET・submit できる（一覧も locked: false）", async () => {
    assert.equal((await submit("fin3", { answers: [0] })).status, 403, "最初は 403 のはず");
    db.progress.push({ id: "p_s2", userId: STUDENT, lessonId: "l2a", completed: true });
    const list = (await (await LIST()).json()) as { courses: Array<{ id: string; locked: boolean }> };
    assert.equal(list.courses.find((c) => c.id === "c3")?.locked, false, "一覧で c3 がロックのまま");
    assert.equal((await getOne("fin3")).status, 200, "GET が 200 でない");
    assert.equal((await submit("fin3", { answers: [0] })).status, 200, "submit が 200 でない");
    assert.equal(creates().length, 1, "受験記録が 1 件でない");
  });

  it("ロック中でも、壊れた JSON・不正な quizId は DB を読まずに 400", async () => {
    assert.equal((await submit("fin3", undefined, "{not json")).status, 400, "壊れた JSON が 400 でない");
    assert.equal((await submit("", { answers: [0] })).status, 400, "空の quizId が 400 でない");
    assert.equal((await getOne("")).status, 400, "GET の空の quizId が 400 でない");
    assert.equal(calls.length, 0, "DB を読んでいる");
  });

  it("他の受講生の受験記録・合格（OTHER の fin2 100 点）があっても、ロックの判定には使わない", async () => {
    db.attempts.push({ id: "att_o3", userId: OTHER, quizId: "fin3", score: 100, passed: true, answers: [0], createdAt: at(1) });
    db.progress.push({ id: "p_o3", userId: OTHER, lessonId: "l3a", completed: true });
    assert.equal((await getOne("fin3")).status, 403, "他人の記録で解放された");
  });
});

describe("quizCourseId の規則は 1 か所だけ（ソース。#47 P5）", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("lesson-access.ts は quizCourseId を使い、FINAL / MINI の分岐を自分で書かない", () => {
    const s = strip(read("src/lib/lesson-access.ts"));
    assert.match(s, /import \{[^}]*\bquizCourseId\b[^}]*\} from "\.\/student-quizzes";/, "quizCourseId を import していない");
    assert.match(s, /quizCourseId\(quiz\)/, "quizCourseId を呼んでいない");
    assert.doesNotMatch(s, /"FINAL"|"MINI"/, "lesson-access.ts に種類の分岐がある");
  });

  it("buildQuizCourses は quizCourseId でコースを決め、student-quizzes.ts の中で courseId の規則は quizCourseId だけ", () => {
    const s = strip(read("src/lib/student-quizzes.ts"));
    assert.match(s, /const courseId = quizCourseId\(q\);/, "buildQuizCourses が quizCourseId を使っていない");
    const hits = s.match(/lesson\?\.section\.courseId|lesson\.section\.courseId/g) ?? [];
    assert.equal(hits.length, 1, `lesson.section.courseId を読む箇所が 1 つでない: ${hits.length}`);
  });

  it("GET・submit は quizAccessFor だけでロックを確かめ、コースの規則を持たない", () => {
    for (const p of ["src/app/api/quizzes/[quizId]/route.ts", "src/lib/quiz-submit.ts"]) {
      const s = strip(read(p));
      assert.match(s, /quizAccessFor\(prisma, userId, quizId\)/, `${p} が quizAccessFor を呼んでいない`);
      assert.doesNotMatch(s, /"FINAL"|"MINI"|section/, `${p} にコースの規則がある`);
      assert.match(s, /role !== "INSTRUCTOR"/, `${p} の講師の判定が完全一致でない`);
    }
  });
});

// ───────────── 受験の公開前の修正（#51） ─────────────
// 既定のデータ：fin1（修了テスト、問題は qz → qa → qb、正解 [1, 0, 2]）に STUDENT の受験が 100 分前・300 分前の 2 件。
// mini1a（ミニテスト）に 50 分前の 1 件。送信の時刻（submitNow）は BASE、偽 create の createdAt も BASE。

const attemptReads = () => calls.filter((c) => c.method === "quizAttempt.findMany");
const HOUR_MS = 60 * 60_000;
/** STUDENT の fin1 の既定の受験記録（100 分前・300 分前）を消す（回数の上限にかからない状態で間隔だけを見る） */
const clearMyFin1 = () => {
  db.attempts = db.attempts.filter((a) => !(a.userId === STUDENT && a.quizId === "fin1"));
};

/** 429・409 の本文に、点数・正誤・正解・問題の id・クイズの中身を含まないこと */
function assertNoQuizContent(text: string) {
  for (const s of ["score", "results", "correct", "passed", "total", "qz", "qa", "qb", "問Z", "options", "duplicate", STUDENT]) {
    assert.ok(!text.includes(s), `本文に ${s} が含まれる: ${text}`);
  }
}

describe("POST submit：questionIds の形（#51）", () => {
  it("questionIds がなければ 400 invalid_question_ids で、DB を読まない", async () => {
    const res = await submitExact("fin1", { answers: [1, 0, 2] });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_question_ids" });
    assert.equal(calls.length, 0, "DB を読んでいる");
  });

  for (const [label, questionIds] of [
    ["文字列", "qz,qa,qb"],
    ["空文字の id を含む", ["qz", "", "qb"]],
    ["数値の id を含む", ["qz", 1, "qb"]],
    ["65 文字の id を含む", ["qz", "q".repeat(65), "qb"]],
  ] as Array<[string, unknown]>) {
    it(`questionIds が${label}なら 400 invalid_question_ids で、DB を読まない`, async () => {
      const res = await submitExact("fin1", { answers: [1, 0, 2], questionIds });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, "invalid_question_ids");
      assert.equal(calls.length, 0, "DB を読んでいる");
    });
  }

  it("answers も壊れていれば invalid_answers（answers を先に見る）", async () => {
    const res = await submitExact("fin1", { answers: "x" });
    assert.equal((await res.json()).reason, "invalid_answers");
  });

  it("ロック中のコースでも、形が壊れていれば DB を読まずに 400", async () => {
    assert.equal((await submitExact("fin3", { answers: [0] })).status, 400);
    assert.equal(calls.length, 0, "DB を読んでいる");
  });
});

describe("POST submit：問題の入れ替え（409 quiz_changed。#51）", () => {
  for (const [label, questionIds] of [
    ["問題が増えた（画面は 2 問）", ["qz", "qa"]],
    ["問題が減った（画面は 4 問）", ["qz", "qa", "qb", "qx"]],
    ["順番が違う", ["qa", "qz", "qb"]],
    ["中身が違う", ["qz", "qa", "qx"]],
    ["空", []],
  ] as Array<[string, string[]]>) {
    it(`${label}なら 409 quiz_changed で、受験記録を読まず・書かない`, async () => {
      const res = await submitExact("fin1", { answers: [1, 0, 2], questionIds });
      assert.equal(res.status, 409);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { error: "Conflict", reason: "quiz_changed" });
      assertNoQuizContent(text);
      assert.equal(attemptReads().length, 0, "受験記録を読んでいる");
      assert.equal(creates().length, 0, "受験記録を書いている");
    });
  }

  it("answers の長さが合わなくても、questionIds が違えば 400 ではなく 409（問題が増えたことを先に知らせる）", async () => {
    const res = await submitExact("fin1", { answers: [1, 0], questionIds: ["qz", "qa"] });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, "quiz_changed");
  });

  it("questionIds が一致して answers の長さが違えば 400 invalid_answers", async () => {
    const res = await submitExact("fin1", { answers: [1, 0], questionIds: ["qz", "qa", "qb"] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "invalid_answers");
    assert.equal(attemptReads().length, 0, "受験記録を読んでいる");
  });

  it("問題が足されたあとに古い画面から送ると 409、読み直した並びで送れば 200", async () => {
    db.questions.push({ id: "qc", quizId: "fin1", question: "問C", options: ["c0", "c1"], correctIndex: 1, order: 3 });
    assert.equal((await submitExact("fin1", { answers: [1, 0, 2], questionIds: ["qz", "qa", "qb"] })).status, 409);
    const res = await submitExact("fin1", { answers: [1, 0, 2, 1], questionIds: ["qz", "qa", "qb", "qc"] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).total, 4);
  });

  it("ロック中のコースは、questionIds が違っても 409 より先に 403（問題を読まない）", async () => {
    const res = await submitExact("fin3", { answers: [0], questionIds: ["wrong"] });
    assert.equal(res.status, 403);
    assert.equal(questionReads().length, 0, "問題を読んでいる");
  });

  it("受験できないクイズは、questionIds が違っても 409 quiz_unavailable", async () => {
    const res = await submitExact("badkey", { answers: [0], questionIds: ["wrong"] });
    assert.deepEqual(await res.json(), { error: "Quiz unavailable", reason: "quiz_unavailable" });
  });

  it("409 quiz_changed はログを出さない", async () => {
    const done = captureLogs();
    await submitExact("fin1", { answers: [1, 0, 2], questionIds: ["qa"] });
    assert.equal(done(), "", "ログが出た");
  });
});

describe("POST submit：受験記録の読み方（#51）", () => {
  it("自分の、このクイズの直近 24 時間の記録を、新しい順に修了テストは 3 件まで読む", async () => {
    await submit("fin1", { answers: [1, 0, 2], userId: OTHER });
    const reads = attemptReads();
    assert.equal(reads.length, 1, "受験記録の読み取りが 1 回でない");
    const args = reads[0].args;
    assert.deepEqual(args.where, { userId: STUDENT, quizId: "fin1", createdAt: { gt: new Date(BASE - 24 * HOUR_MS) } });
    assert.deepEqual(args.select, { answers: true, createdAt: true });
    assert.deepEqual(args.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
    assert.equal(args.take, 3);
  });

  it("ミニテストは 10 件まで読む", async () => {
    await submit("mini1b", { answers: [1] });
    assert.equal(attemptReads()[0]?.args.take, 10);
  });

  it("読む順番：問題を読んで questionIds・answers を確かめたあと、保存の前", async () => {
    await submit("fin1", { answers: [1, 0, 2] });
    const order = calls.map((c) => c.method);
    const q = order.lastIndexOf("quiz.findUnique");
    const a = order.indexOf("quizAttempt.findMany");
    const w = order.indexOf("quizAttempt.create");
    assert.ok(q >= 0 && a > q && w > a, `読む順番が違う: ${order.join(" → ")}`);
  });

  it("受験記録の読み取りの例外は 500 で書き込まず、ログはエラーの名前だけ", async () => {
    failOn = "quizAttempt.findMany";
    failWith = piiError();
    const done = captureLogs();
    const res = await submit("fin1", { answers: [1, 0, 2] });
    const out = done();
    assert.equal(res.status, 500);
    assert.equal(creates().length, 0, "受験記録を書いている");
    assertSafeLog(out);
  });
});

describe("POST submit：間隔と回数の上限（429。#51）", () => {
  it("修了テストを受けた直後に別の回答を送ると 429。Retry-After と retryAfterSeconds は 30 分、記録しない", async () => {
    clearMyFin1();
    assert.equal((await submit("fin1", { answers: [1, 0, 2] })).status, 200);
    const res = await submit("fin1", { answers: [0, 0, 0] });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "1800");
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "Too many requests", reason: "rate_limited", retryAfterSeconds: 1800 });
    assertNoQuizContent(text);
    assert.equal(creates().length, 1, "429 で記録した");
  });

  it("30 分たてば送れる（ちょうど 30 分で 200）", async () => {
    clearMyFin1();
    await submit("fin1", { answers: [1, 0, 2] });
    submitNow = new Date(BASE + 30 * 60_000 - 1);
    assert.equal((await submit("fin1", { answers: [0, 0, 0] })).status, 429, "30 分の 1 ms 前が 429 でない");
    submitNow = new Date(BASE + 30 * 60_000);
    assert.equal((await submit("fin1", { answers: [0, 0, 0] })).status, 200, "ちょうど 30 分が 200 でない");
  });

  it("修了テストは 24 時間に 3 回まで（4 回目は、最も古い 1 件が 24 時間を過ぎるまで 429）", async () => {
    // 既定の 2 件（300 分前・100 分前）に、いま 1 件を足して 3 件
    assert.equal((await submit("fin1", { answers: [1, 0, 2] })).status, 200);
    submitNow = new Date(BASE + 2 * HOUR_MS);
    const res = await submit("fin1", { answers: [0, 0, 0] });
    assert.equal(res.status, 429);
    // 最も古い 300 分前の記録が期間から出るのは BASE + 19 時間。いまは BASE + 2 時間なので 17 時間後
    assert.equal((await res.json()).retryAfterSeconds, 17 * 60 * 60);
    assert.equal(res.headers.get("Retry-After"), String(17 * 60 * 60));
    submitNow = new Date(BASE + 19 * HOUR_MS + 1);
    assert.equal((await submit("fin1", { answers: [0, 0, 0] })).status, 200, "古い記録が期間から出ても 429 のまま");
  });

  it("ミニテストは 60 秒あければ続けて受けられる", async () => {
    assert.equal((await submit("mini1b", { answers: [0] })).status, 200);
    assert.equal((await submit("mini1b", { answers: [1] })).status, 429);
    submitNow = new Date(BASE + 60_000);
    assert.equal((await submit("mini1b", { answers: [1] })).status, 200);
  });

  it("他人の受験記録は数えない（OTHER が直前に受けていても STUDENT は送れる）", async () => {
    for (let i = 0; i < 5; i++) db.attempts.push({ id: `att_o${i}`, userId: OTHER, quizId: "mini1b", score: 0, passed: false, answers: [0], createdAt: at(i * 0.1) });
    const res = await submit("mini1b", { answers: [0] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).duplicate, false, "他人の記録で重複になった");
  });

  it("別のクイズの受験記録は数えない", async () => {
    await submit("fin1", { answers: [1, 0, 2] });
    assert.equal((await submit("fin2", { answers: [0] })).status, 200);
  });

  it("429 はログを出さない", async () => {
    await submit("fin1", { answers: [1, 0, 2] });
    const done = captureLogs();
    assert.equal((await submit("fin1", { answers: [0, 0, 0] })).status, 429);
    assert.equal(done(), "", "ログが出た");
  });
});

describe("POST submit：応答が届かなかったときの再送（重複。#51）", () => {
  it("直前と同じ回答を間隔の内側で送ると、記録せずに 200 duplicate: true（同じ結果）", async () => {
    const first = await (await submit("fin1", { answers: [1, 0, 0] })).json();
    submitNow = new Date(BASE + 5_000);
    const res = await submit("fin1", { answers: [1, 0, 0] });
    assert.equal(res.status, 200);
    const text = await res.text();
    const again = JSON.parse(text);
    assert.deepEqual(again, { ...first, duplicate: true });
    assert.deepEqual(Object.keys(again).sort(), ["correct", "duplicate", "passed", "results", "score", "total"]);
    for (const k of ["correctIndex", "answers", "options", STUDENT]) assert.ok(!text.includes(k), `本文に ${k} が含まれる`);
    assert.equal(creates().length, 1, "重複を記録した");
  });

  it("24 時間に 3 回受けたあとの再送も、429 ではなく duplicate", async () => {
    await submit("fin1", { answers: [1, 0, 2] }); // 3 回目
    const res = await submit("fin1", { answers: [1, 0, 2] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).duplicate, true);
  });

  it("間隔を過ぎたら、同じ回答でも新しい受験として記録する", async () => {
    clearMyFin1();
    await submit("fin1", { answers: [1, 0, 2] });
    submitNow = new Date(BASE + 30 * 60_000);
    const res = await submit("fin1", { answers: [1, 0, 2] });
    assert.equal((await res.json()).duplicate, false);
    assert.equal(creates().length, 2);
  });

  it("前回の記録の answers が壊れていれば重複にしない（429）", async () => {
    db.attempts.push({ id: "att_broken", userId: STUDENT, quizId: "mini1b", score: 0, passed: false, answers: "1", createdAt: at(0.1) });
    assert.equal((await submit("mini1b", { answers: [1] })).status, 429);
  });

  it("重複の点数は、今の正解で採点し直した値", async () => {
    await submit("mini1b", { answers: [1] });
    db.questions = db.questions.map((q) => (q.id === "m1b" ? { ...q, correctIndex: 0 } : q));
    const body = await (await submit("mini1b", { answers: [1] })).json();
    assert.deepEqual(body, { score: 0, passed: false, total: 1, correct: 0, results: [false], duplicate: true });
  });

  it("重複はログを出さない", async () => {
    await submit("fin1", { answers: [1, 0, 2] });
    const done = captureLogs();
    await submit("fin1", { answers: [1, 0, 2] });
    assert.equal(done(), "", "ログが出た");
  });
});

describe("POST submit：講師（#51、Tec 決定 Q2 a）", () => {
  it("講師は間隔・回数の上限を受けない（続けて 5 回、別の回答で受けられる）", async () => {
    session = INSTRUCTOR_SESSION;
    const answers = [[1, 0, 2], [0, 0, 0], [1, 1, 1], [0, 1, 2], [1, 0, 0]];
    for (const a of answers) assert.equal((await submit("fin1", { answers: a })).status, 200, `${JSON.stringify(a)} が 200 でない`);
    assert.equal(creates().length, 5);
  });

  it("講師も重複の判定は受ける（同じ回答の再送は記録しない）", async () => {
    session = INSTRUCTOR_SESSION;
    await submit("fin1", { answers: [1, 0, 2] });
    const body = await (await submit("fin1", { answers: [1, 0, 2] })).json();
    assert.equal(body.duplicate, true);
    assert.equal(creates().length, 1);
  });

  it("講師の受験記録の読み取りも、講師自身の userId で絞る", async () => {
    session = INSTRUCTOR_SESSION;
    await submit("fin1", { answers: [1, 0, 2] });
    assert.equal((attemptReads()[0]?.args.where as Row).userId, INSTRUCTOR_SESSION!.user.id);
  });
});

describe("POST submit：route は now を渡さない（本番は実際の時刻。#51）", () => {
  it("route のソースは now を渡さず、本体は省略時に new Date() を使う", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/quizzes/[quizId]/submit/route.ts"), "utf8");
    assert.doesNotMatch(route, /\bnow\b/, "route が now を渡している");
    const body = readFileSync(join(process.cwd(), "src/lib/quiz-submit.ts"), "utf8");
    assert.match(body, /const at = now \?\? new Date\(\);/, "本体が省略時に new Date() を使っていない");
  });
});

describe("GET /api/quizzes/[quizId]：retryAfterSeconds（#51、Tec 決定 Q3 b）", () => {
  // GET は実際の時刻で判定する。記録の日時も実際の時刻から作る
  const realAgo = (ms: number) => new Date(Date.now() - ms);

  it("直近の受験がなければ null", async () => {
    assert.equal((await (await getOne("mini1b")).json()).retryAfterSeconds, null);
  });

  it("修了テストを 5 分前に受けていれば、残りの秒数（約 25 分）", async () => {
    db.attempts.push({ id: "att_r1", userId: STUDENT, quizId: "fin2", score: 0, passed: false, answers: [1], createdAt: realAgo(5 * 60_000) });
    const s = (await (await getOne("fin2")).json()).retryAfterSeconds;
    assert.ok(typeof s === "number" && s >= 25 * 60 - 2 && s <= 25 * 60, `retryAfterSeconds が約 25 分でない: ${s}`);
  });

  it("他人の直近の受験では知らせない", async () => {
    db.attempts.push({ id: "att_r2", userId: OTHER, quizId: "fin2", score: 0, passed: false, answers: [1], createdAt: realAgo(60_000) });
    assert.equal((await (await getOne("fin2")).json()).retryAfterSeconds, null);
  });

  it("講師には null（上限を受けない）", async () => {
    session = INSTRUCTOR_SESSION;
    db.attempts.push({ id: "att_r3", userId: INSTRUCTOR_SESSION!.user.id, quizId: "fin2", score: 0, passed: false, answers: [1], createdAt: realAgo(60_000) });
    assert.equal((await (await getOne("fin2")).json()).retryAfterSeconds, null);
  });

  it("受験記録の読み取りは 1 回だけで、answers を読まない（追加の読み取りなし）", async () => {
    await getOne("fin1");
    const reads = attemptReads();
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0].args.select, { score: true, passed: true, createdAt: true });
  });

  it("GET の retryAfterSeconds と、同じ時刻の submit の 429 はほぼ同じ値", async () => {
    db.attempts.push({ id: "att_r4", userId: STUDENT, quizId: "fin2", score: 0, passed: false, answers: [1], createdAt: realAgo(10 * 60_000) });
    const fromGet = (await (await getOne("fin2")).json()).retryAfterSeconds as number;
    submitNow = new Date();
    const res = await submit("fin2", { answers: [0] });
    assert.equal(res.status, 429);
    const fromSubmit = (await res.json()).retryAfterSeconds as number;
    assert.ok(Math.abs(fromGet - fromSubmit) <= 2, `GET ${fromGet} と submit ${fromSubmit} が離れている`);
  });
});

// ───────────── テスト担当の追加（#51） ─────────────

/** 応答のヘッダーを「名前: 値」の行にする（target が古く Headers をスプレッドできないため forEach を使う） */
function headersText(res: Response): string {
  const lines: string[] = [];
  res.headers.forEach((value, name) => lines.push(`${name}: ${value}`));
  return lines.join("\n");
}

describe("POST submit：ロールの扱い（#51 追加）", () => {
  for (const [label, role] of [
    ["小文字の instructor", "instructor"],
    ["前後に空白のある INSTRUCTOR", " INSTRUCTOR "],
    ["ADMIN", "ADMIN"],
    ["空文字", ""],
    ["null", null],
    ["undefined", undefined],
  ] as Array<[string, string | null | undefined]>) {
    it(`role が${label}なら受講生として上限を受ける（429）`, async () => {
      const send = (answers: number[]) =>
        HANDLE_SUBMIT(STUDENT, submitRequest("fin1", { answers: toDisplayed("fin1", answers, STUDENT), questionIds: serverQuestionIds("fin1"), attemptToken: tokenFor("fin1", STUDENT) }), ctx("fin1"), {
          attemptsEnabled: true,
          role,
          now: submitNow,
        });
      clearMyFin1();
      assert.equal((await send([1, 0, 2])).status, 200, "1 回目が 200 でない");
      const res = await send([0, 0, 0]);
      assert.equal(res.status, 429, `${label} が上限を受けていない`);
      assert.equal(creates().length, 1, "429 で記録した");
    });
  }
});

describe("GET /api/quizzes/[quizId]：retryAfterSeconds のロール（#51 追加）", () => {
  const realAgo = (ms: number) => new Date(Date.now() - ms);
  for (const role of ["instructor", "ADMIN", undefined]) {
    it(`role が ${String(role)} のセッションは受講生として retryAfterSeconds を返す`, async () => {
      session = { user: { id: STUDENT, ...(role === undefined ? {} : { role }) } };
      db.attempts.push({ id: "att_role", userId: STUDENT, quizId: "fin1", score: 0, passed: false, answers: [0, 0, 0], createdAt: realAgo(60_000) });
      const s = (await (await getOne("fin1")).json()).retryAfterSeconds;
      assert.ok(typeof s === "number" && s > 0 && s <= 1800, `retryAfterSeconds が数値でない: ${s}`);
    });
  }

  it("ロック中のコースの 403 の本文に retryAfterSeconds を含めず、受験記録を読まない", async () => {
    db.attempts.push({ id: "att_l", userId: STUDENT, quizId: "fin3", score: 0, passed: false, answers: [0], createdAt: realAgo(60_000) });
    const res = await getOne("fin3");
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.ok(!text.includes("retryAfterSeconds"), `403 に retryAfterSeconds がある: ${text}`);
    assert.equal(attemptReads().length, 0, "受験記録を読んでいる");
  });

  it("24 時間に 3 回受けた修了テストは、間隔の外でも上限の待ち時間を返す（GET は記録を全件読む）", async () => {
    clearMyFin1();
    for (const h of [3, 5, 7]) {
      db.attempts.push({ id: `att_g${h}`, userId: STUDENT, quizId: "fin1", score: 0, passed: false, answers: [0, 0, 0], createdAt: realAgo(h * HOUR_MS) });
    }
    const s = (await (await getOne("fin1")).json()).retryAfterSeconds;
    // 7 時間前の記録が期間から出るまで約 17 時間
    assert.ok(typeof s === "number" && Math.abs(s - 17 * 3600) <= 2, `retryAfterSeconds が約 17 時間でない: ${s}`);
  });

  it("#51 より前の受験記録（四捨五入の 67 点・不合格）は、点数・合否をそのまま表示する", async () => {
    const body = await (await getOne("fin1")).json();
    assert.equal(body.bestScore, 67);
    assert.equal(body.passed, false);
    assert.equal(body.attemptCount, 2);
  });
});

describe("POST submit：判定の順番・本文とヘッダー（#51 追加）", () => {
  it("上限にかかっていても、範囲外の回答は 400 で、受験記録を読まない", async () => {
    await submit("fin1", { answers: [1, 0, 2] });
    calls = [];
    const res = await submit("fin1", { answers: [9, 9, 9] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "invalid_answers");
    assert.equal(attemptReads().length, 0, "受験記録を読んでいる");
  });

  it("409 quiz_unavailable では受験記録を読まない", async () => {
    await submitExact("badkey", { answers: [0], questionIds: ["bk1"] });
    assert.equal(attemptReads().length, 0, "受験記録を読んでいる");
  });

  it("429 のヘッダーは Retry-After が本文の retryAfterSeconds と一致し、ヘッダーにも点数・問題の id を含まない", async () => {
    clearMyFin1();
    await submit("fin1", { answers: [1, 0, 2] });
    submitNow = new Date(BASE + 123_456);
    const res = await submit("fin1", { answers: [0, 0, 0] });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.retryAfterSeconds, Math.ceil((30 * 60_000 - 123_456) / 1000));
    assert.equal(res.headers.get("Retry-After"), String(body.retryAfterSeconds));
    const headers = headersText(res);
    assertNoQuizContent(headers);
  });

  it("409 quiz_changed のヘッダーに Retry-After・問題の id を含まない", async () => {
    const res = await submitExact("fin1", { answers: [1, 0, 2], questionIds: ["qa", "qz", "qb"] });
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("Retry-After"), null);
    assertNoQuizContent(headersText(res));
  });

  it("ミニテストは 24 時間に 10 回まで（11 回目は 429、Retry-After と本文が一致）", async () => {
    for (let i = 0; i < 10; i++) {
      db.attempts.push({ id: `att_m${i}`, userId: STUDENT, quizId: "mini1b", score: 0, passed: false, answers: [0], createdAt: at(10 + i * 60) });
    }
    const res = await submit("mini1b", { answers: [1] });
    assert.equal(res.status, 429);
    const body = await res.json();
    // 最も古い 550 分前の記録が期間から出るまで：24 時間 - 550 分 = 890 分
    assert.equal(body.retryAfterSeconds, 890 * 60);
    assert.equal(res.headers.get("Retry-After"), String(890 * 60));
    assert.equal(creates().length, 0);
  });

  it("未来の日時の記録（時計のずれ）があれば 429 で、待ち時間は間隔（30 分）を超えない", async () => {
    clearMyFin1();
    db.attempts.push({ id: "att_future", userId: STUDENT, quizId: "fin1", score: 0, passed: false, answers: [0, 0, 0], createdAt: new Date(BASE + HOUR_MS) });
    const res = await submit("fin1", { answers: [1, 0, 2] });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).retryAfterSeconds, 1800);
  });

  it("講師は記録が上限を超えていても 200 で、Retry-After を付けない", async () => {
    session = INSTRUCTOR_SESSION;
    const ins = INSTRUCTOR_SESSION!.user.id!;
    for (let i = 0; i < 5; i++) {
      db.attempts.push({ id: `att_i${i}`, userId: ins, quizId: "fin1", score: 0, passed: false, answers: [0, 0, 0], createdAt: at(i + 1) });
    }
    const res = await submit("fin1", { answers: [1, 0, 2] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Retry-After"), null);
    assert.equal((await res.json()).duplicate, false);
  });
});

describe("POST submit：重複の追加の観点（#51 追加）", () => {
  it("JSON の 1.0 と -0 で送り直しても、同じ回答として重複になり記録しない", async () => {
    clearMyFin1();
    await submit("fin1", { answers: [1, 0, 2] });
    // 表示位置で 0 になる問題があるトークンを選び、その位置を -0、ほかを 1.0 のように書く（#51 選択肢のシャッフル）
    let nonce = TEST_NONCE;
    for (let i = 0; !(toDisplayed("fin1", [1, 0, 2], STUDENT, nonce) as number[]).includes(0); i++) {
      nonce = Buffer.alloc(16, i).toString("base64url");
    }
    const displayed = toDisplayed("fin1", [1, 0, 2], STUDENT, nonce) as number[];
    const rawAnswers = displayed.map((d) => (d === 0 ? "-0" : `${d}.0`)).join(",");
    assert.ok(rawAnswers.includes("-0") && rawAnswers.includes(".0"), "-0 と 1.0 の形を両方含んでいない");
    const raw = `{"answers":[${rawAnswers}],"questionIds":${JSON.stringify(serverQuestionIds("fin1"))},"attemptToken":"${tokenFor("fin1", STUDENT, nonce)}"}`;
    const res = await submitRaw("fin1", undefined, raw);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.duplicate, true);
    assert.equal(body.score, 100);
    assert.equal(creates().length, 1, "重複を記録した");
  });

  it("body の userId に他人を書いても、他人の同じ回答では重複にならない（findMany の where はセッションの userId）", async () => {
    clearMyFin1();
    db.attempts.push({ id: "att_o_dup", userId: OTHER, quizId: "fin1", score: 100, passed: true, answers: [1, 0, 2], createdAt: at(0.1) });
    const res = await submit("fin1", { answers: [1, 0, 2], userId: OTHER });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).duplicate, false);
    assert.equal((attemptReads()[0].args.where as Row).userId, STUDENT);
    assert.equal((creates()[0].args.data as Row).userId, STUDENT);
  });

  it("重複では quizAttempt.create を呼ばない（呼び出しの記録で確認）", async () => {
    clearMyFin1();
    await submit("fin1", { answers: [0, 0, 0] });
    calls = [];
    await submit("fin1", { answers: [0, 0, 0] });
    assert.deepEqual(calls.map((c) => c.method).filter((m) => m.startsWith("quizAttempt")), ["quizAttempt.findMany"]);
  });

  it("前回と長さが違う回答（問題が足されたあとの送信）は重複にしない", async () => {
    clearMyFin1();
    db.attempts.push({ id: "att_short", userId: STUDENT, quizId: "fin1", score: 0, passed: false, answers: [1, 0], createdAt: at(1) });
    assert.equal((await submit("fin1", { answers: [1, 0, 2] })).status, 429);
  });
});

// ───────────── 選択肢のシャッフル（#51 追加修正、Tec 決定 2026-10-19） ─────────────

/** 4 択 5 問で、正解がすべて元の 0 番目のクイズ（本番の偏りを再現したダミー）。STEP1（解放済み）に置く */
function addZeroQuiz() {
  db.quizzes.push({ id: "zero", title: "正解がすべて 0 番目", type: "MINI", courseId: null, lessonId: "l1a" });
  for (let i = 1; i <= 5; i++) {
    db.questions.push({ id: `zq${i}`, quizId: "zero", question: `ゼロ問${i}`, options: [`正解${i}`, `誤${i}a`, `誤${i}b`, `誤${i}c`], correctIndex: 0, order: i });
  }
}

/** randomBytes を i を符号化した決まった値にする（GET の nonce を決定的にする。統計テストを毎回同じ結果にするため） */
function fixRandomBytes() {
  let i = 0;
  const m = mock.method(crypto, "randomBytes", (n: number) => {
    const b = Buffer.alloc(n);
    b.writeUInt32BE(i++, n - 4);
    return b;
  });
  return () => m.mock.restore();
}

type QuestionJson = { id: string; question: string; options: string[] };
type TakeJson = { questions: QuestionJson[]; attemptToken: string };

/** GET で受験画面の応答を読む */
const take = async (quizId: string): Promise<TakeJson> => {
  const res = await getOne(quizId);
  assert.equal(res.status, 200, `GET ${quizId} が 200 でない`);
  return res.json();
};

/** GET の応答を画面と同じく送る（answers は表示位置） */
const sendTake = (quizId: string, t: TakeJson, displayed: number[]) =>
  submitRaw(quizId, { answers: displayed, questionIds: t.questions.map((q) => q.id), attemptToken: t.attemptToken });

/** 元の位置 original[i] の文が、GET の応答で表示されている位置 */
const displayedOf = (quizId: string, t: TakeJson, original: number[]) => {
  const qs = serverQuestions(quizId);
  return t.questions.map((q, i) => q.options.indexOf(qs[i].options[original[i]]));
};

describe("選択肢のシャッフル：GET の応答から正解の位置が分からない（#51）", () => {
  it("正解がすべて 0 番目でも、2,000 回の GET で正解の文の表示位置は一様（カイ二乗、p = 0.001。nonce は決まった列）", async () => {
    addZeroQuiz();
    const restore = fixRandomBytes();
    const perQuestion = Array.from({ length: 5 }, () => [0, 0, 0, 0]);
    try {
      for (let k = 0; k < 2000; k++) {
        const t = await take("zero");
        t.questions.forEach((q, i) => {
          const pos = q.options.indexOf(`正解${i + 1}`);
          assert.ok(pos >= 0, "正解の文が選択肢にない");
          perQuestion[i][pos]++;
        });
      }
    } finally {
      restore();
    }
    const chi = (c: number[]) => c.reduce((s, x) => s + (x - 500) ** 2 / 500, 0);
    perQuestion.forEach((c, i) => assert.ok(chi(c) < 16.266, `問 ${i + 1} の正解の表示位置が一様でない（${c.join(",")}）`));
    const total = [0, 1, 2, 3].map((p) => perQuestion.reduce((s, c) => s + c[p], 0));
    const chiTotal = total.reduce((s, x) => s + (x - 2500) ** 2 / 2500, 0);
    assert.ok(chiTotal < 16.266, `全体の正解の表示位置が一様でない（${total.join(",")}）`);
  });

  it("GET のたびに新しいトークン（nonce）になる", async () => {
    const seen = new Set<string>();
    for (let k = 0; k < 20; k++) seen.add((await take("fin1")).attemptToken);
    assert.equal(seen.size, 20);
  });

  it("応答に correctIndex・並べ替えの表・内容のダイジェスト・AUTH_SECRET・鍵を含まない。Cache-Control: no-store", async () => {
    addZeroQuiz();
    const res = await getOne("zero");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const text = await res.text();
    for (const k of ["correctIndex", "perm", "digest", "nonce", "shuffle", DUMMY_AUTH_SECRET, KEYS.shuffleKey.toString("base64url"), KEYS.tokenKey.toString("base64url")]) {
      assert.ok(!text.includes(k), `応答に ${k} が入っている`);
    }
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body.questions[0]).sort(), ["id", "options", "question"]);
  });

  it("講師にも並べ替えた選択肢とトークンを返す（Tec 決定 Q2 a）", async () => {
    session = INSTRUCTOR_SESSION;
    const t = await take("fin1");
    const nonce = t.attemptToken.split(".")[1];
    assert.equal(t.attemptToken, tokenFor("fin1", "ins_1", nonce));
    const qs = serverQuestions("fin1");
    t.questions.forEach((q, i) => assert.deepEqual(q.options, permFor("fin1", i, "ins_1", nonce).map((o) => qs[i].options[o])));
  });

  it("ほかのエラー（401・403・404・409）の本文にはトークンを入れない", async () => {
    const texts: string[] = [];
    session = null;
    texts.push(await (await getOne("fin1")).text());
    session = STUDENT_SESSION;
    texts.push(await (await getOne("fin3")).text());
    texts.push(await (await getOne("missing")).text());
    texts.push(await (await getOne("badkey")).text());
    for (const t of texts) assert.doesNotMatch(t, /attemptToken|v1\./);
  });
});

describe("選択肢のシャッフル：採点と保存は元の位置（#51）", () => {
  it("表示された正解の文の位置を送ると全問正解で、保存する answers は元の位置（correctIndex と同じ）", async () => {
    addZeroQuiz();
    const t = await take("zero");
    const displayed = displayedOf("zero", t, [0, 0, 0, 0, 0]);
    const res = await sendTake("zero", t, displayed);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([body.score, body.correct, body.duplicate], [100, 5, false]);
    assert.deepEqual((creates()[0].args.data as Row).answers, [0, 0, 0, 0, 0]);
  });

  it("「表示位置 0 を全問」送ると、その位置に出ていた元の選択肢で採点する（元の 0 番目として採点しない）", async () => {
    addZeroQuiz();
    const restore = fixRandomBytes();
    try {
      let checked = 0;
      for (let k = 0; k < 20; k++) {
        db.attempts = db.attempts.filter((a) => a.quizId !== "zero");
        const t = await take("zero");
        const nonce = t.attemptToken.split(".")[1];
        const originals = t.questions.map((_, i) => permFor("zero", i, STUDENT, nonce)[0]);
        const body = await (await sendTake("zero", t, [0, 0, 0, 0, 0])).json();
        assert.deepEqual(body.results, originals.map((o) => o === 0));
        assert.deepEqual((creates()[creates().length - 1].args.data as Row).answers, originals);
        if (originals.some((o) => o !== 0)) checked++;
      }
      assert.ok(checked > 0, "表示位置 0 が元の 0 番目でない場合を確かめていない");
    } finally {
      restore();
    }
  });

  it("並び替えた fin1 でも、元の位置の正解 [1, 0, 2] の文を選べば 100 点", async () => {
    clearMyFin1();
    const t = await take("fin1");
    const body = await (await sendTake("fin1", t, displayedOf("fin1", t, [1, 0, 2]))).json();
    assert.equal(body.score, 100);
    assert.deepEqual((creates()[0].args.data as Row).answers, [1, 0, 2]);
  });
});

describe("選択肢のシャッフル：トークンの検証（#51）", () => {
  for (const [label, token] of [
    ["なし", undefined],
    ["null", null],
    ["数値", 1],
    ["版が違う", `v2.${"A".repeat(22)}.${"B".repeat(43)}`],
    ["短い", "v1.abc.def"],
    ["末尾に改行", `v1.${"A".repeat(22)}.${"B".repeat(43)}\n`],
  ] as Array<[string, unknown]>) {
    it(`attemptToken が${label}なら 400 invalid_attempt_token で、DB を読まない`, async () => {
      const body: Row = { answers: [1, 0, 2], questionIds: serverQuestionIds("fin1") };
      if (token !== undefined) body.attemptToken = token;
      const res = await submitRaw("fin1", body);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_attempt_token" });
      assert.equal(calls.length, 0, "DB を読んでいる");
    });
  }

  const flip = (s: string, at: number) => s.slice(0, at) + (s[at] === "A" ? "B" : "A") + s.slice(at + 1);

  for (const [label, mutate] of [
    ["MAC の末尾の 1 文字を変える", (t: TakeJson) => ({ token: flip(t.attemptToken, t.attemptToken.length - 1) })],
    ["MAC の先頭の 1 文字を変える", (t: TakeJson) => ({ token: flip(t.attemptToken, 3 + 22 + 1) })],
    ["nonce の 1 文字を変える", (t: TakeJson) => ({ token: flip(t.attemptToken, 3) })],
    ["別の受講生のトークン", () => ({ token: tokenFor("fin1", OTHER) })],
    ["別のクイズのトークン", () => ({ token: tokenFor("fin2", STUDENT) })],
    ["別の鍵で作ったトークン", () => ({ token: issueAttemptToken(deriveQuizKeys("another-dummy-secret"), { userId: STUDENT, quizId: "fin1", questions: serverQuestions("fin1") }, TEST_NONCE) })],
    ["受験中に選択肢の文が変わった", (t: TakeJson) => {
      const q = db.questions.find((x) => x.id === "qa")!;
      q.options = ["a0", "a1", "a2", "a3 改"];
      return { token: t.attemptToken };
    }],
    ["受験中に選択肢が並び替えられた", (t: TakeJson) => {
      const q = db.questions.find((x) => x.id === "qa")!;
      q.options = ["a1", "a0", "a2", "a3"];
      return { token: t.attemptToken };
    }],
    ["受験中に選択肢が足された", (t: TakeJson) => {
      const q = db.questions.find((x) => x.id === "qz")!;
      q.options = ["z0", "z1", "z2"];
      return { token: t.attemptToken };
    }],
  ] as Array<[string, (t: TakeJson) => { token: string }]>) {
    it(`${label}なら 409 quiz_changed で、記録しない（本文にトークン・並べ替えを入れない）`, async () => {
      clearMyFin1();
      const t = await take("fin1");
      const { token } = mutate(t);
      calls = []; // GET の読み取りを除く
      const done = captureLogs();
      const res = await submitRaw("fin1", { answers: [0, 0, 0], questionIds: t.questions.map((q) => q.id), attemptToken: token });
      assert.equal(done(), "", "ログが出た");
      assert.equal(res.status, 409);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { error: "Conflict", reason: "quiz_changed" });
      assert.equal(creates().length, 0, "記録した");
      assert.equal(attemptReads().length, 0, "受験記録を読んでいる");
    });
  }

  it("トークンが合わなければ、answers の範囲外より先に 409（400 と取り違えない）", async () => {
    const res = await submitRaw("fin1", { answers: [9, 9, 9], questionIds: serverQuestionIds("fin1"), attemptToken: tokenFor("fin1", OTHER) });
    assert.equal(res.status, 409);
  });

  it("questionIds が違えば、トークンが正しくても 409 quiz_changed（今までどおり）", async () => {
    const res = await submitRaw("fin1", { answers: [1, 0, 2], questionIds: ["qa", "qz", "qb"], attemptToken: tokenFor("fin1") });
    assert.deepEqual(await res.json(), { error: "Conflict", reason: "quiz_changed" });
  });

  it("トークンに有効期限はない：25 時間後に同じトークンで送っても受け付ける（Tec 決定 Q3 a）", async () => {
    clearMyFin1();
    submitNow = new Date(BASE + 25 * 3_600_000);
    const res = await submit("fin1", { answers: [1, 0, 2] });
    assert.equal(res.status, 200);
  });

  it("講師も同じ手順：トークンなしは 400、他人のトークンは 409", async () => {
    session = INSTRUCTOR_SESSION;
    assert.equal((await submitRaw("fin1", { answers: [1, 0, 2], questionIds: serverQuestionIds("fin1") })).status, 400);
    assert.equal((await submitRaw("fin1", { answers: [1, 0, 2], questionIds: serverQuestionIds("fin1"), attemptToken: tokenFor("fin1", STUDENT) })).status, 409);
    const res = await submit("fin1", { answers: [1, 0, 2] });
    assert.equal(res.status, 200);
    assert.deepEqual((creates()[0].args.data as Row).answers, [1, 0, 2]);
  });
});

describe("選択肢のシャッフル：#77 の重複・上限との関係（#51）", () => {
  it("同じトークン・同じ表示位置で再送すると duplicate で、記録は 1 件", async () => {
    clearMyFin1();
    const t = await take("fin1");
    const d = displayedOf("fin1", t, [1, 0, 2]);
    assert.equal((await (await sendTake("fin1", t, d)).json()).duplicate, false);
    const again = await (await sendTake("fin1", t, d)).json();
    assert.equal(again.duplicate, true);
    assert.equal(again.score, 100);
    assert.equal(creates().length, 1);
  });

  it("読み直して（新しいトークン）同じ文を選ぶと duplicate", async () => {
    clearMyFin1();
    const t1 = await take("fin1");
    await sendTake("fin1", t1, displayedOf("fin1", t1, [0, 1, 1]));
    const t2 = await take("fin1");
    assert.notEqual(t1.attemptToken, t2.attemptToken);
    const res = await sendTake("fin1", t2, displayedOf("fin1", t2, [0, 1, 1]));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).duplicate, true);
    assert.equal(creates().length, 1);
  });

  it("新しいトークンで同じ表示位置を送っても、元の位置が違えば duplicate にしない（講師：上限なし）", async () => {
    session = INSTRUCTOR_SESSION;
    const restore = fixRandomBytes();
    try {
      const t1 = await take("fin1");
      const shown = [0, 0, 0];
      await sendTake("fin1", t1, shown);
      const first = (creates()[0].args.data as Row).answers as number[];
      let t2 = await take("fin1");
      // 同じ表示位置が別の元の位置になるトークンまで読み直す
      for (let k = 0; k < 50; k++) {
        const n2 = t2.attemptToken.split(".")[1];
        const orig2 = t2.questions.map((_, i) => permFor("fin1", i, "ins_1", n2)[0]);
        if (JSON.stringify(orig2) !== JSON.stringify(first)) break;
        t2 = await take("fin1");
      }
      const body = await (await sendTake("fin1", t2, shown)).json();
      assert.equal(body.duplicate, false);
      assert.equal(creates().length, 2);
      assert.notDeepEqual((creates()[1].args.data as Row).answers, first);
    } finally {
      restore();
    }
  });

  it("429 の本文にトークン・並べ替え・回答を入れず、同じトークンで後から送れる", async () => {
    clearMyFin1();
    const t1 = await take("fin1");
    await sendTake("fin1", t1, displayedOf("fin1", t1, [1, 0, 2]));
    const t2 = await take("fin1");
    const d2 = displayedOf("fin1", t2, [0, 0, 0]);
    const limited = await sendTake("fin1", t2, d2);
    assert.equal(limited.status, 429);
    const text = await limited.text();
    for (const k of [t2.attemptToken, t2.attemptToken.split(".")[1], t2.attemptToken.split(".")[2], "attemptToken", "answers", "options"]) {
      assert.ok(!text.includes(k), `429 の本文に ${k.slice(0, 8)} が入っている`);
    }
    // 間隔（30 分）をあければ同じトークンで送れる
    submitNow = new Date(BASE + 31 * 60_000);
    const later = await sendTake("fin1", t2, d2);
    assert.equal(later.status, 200);
    assert.deepEqual((creates()[1].args.data as Row).answers, [0, 0, 0]);
  });
});

describe("選択肢のシャッフル：鍵（AUTH_SECRET）がないとき（#51）", () => {
  const withoutSecret = async (fn: () => Promise<void>) => {
    const saved = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      await fn();
    } finally {
      process.env.AUTH_SECRET = saved;
    }
  };

  it("GET は 500 で DB を読まず、ログはエラーの名前だけ（値・トークンを出さない）", async () => {
    await withoutSecret(async () => {
      const done = captureLogs();
      const res = await getOne("fin1");
      const out = done();
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.equal(calls.length, 0, "DB を読んでいる");
      assert.match(out, /QuizKeyUnavailableError/);
      assert.ok(!out.includes(DUMMY_AUTH_SECRET), "ログに secret が出た");
      assert.doesNotMatch(out, /AUTH_SECRET|v1\./);
    });
  });

  it("空文字の AUTH_SECRET も 500", async () => {
    const saved = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "";
    try {
      const done = captureLogs();
      assert.equal((await getOne("fin1")).status, 500);
      done();
    } finally {
      process.env.AUTH_SECRET = saved;
    }
  });

  it("submit は形の確認のあと 500 で、DB を読まず記録しない。ログに値・トークン・回答を出さない", async () => {
    const token = tokenFor("fin1");
    await withoutSecret(async () => {
      const done = captureLogs();
      const res = await submitRaw("fin1", { answers: [1, 0, 2], questionIds: serverQuestionIds("fin1"), attemptToken: token });
      const out = done();
      assert.equal(res.status, 500);
      assert.equal(calls.length, 0, "DB を読んでいる");
      assert.match(out, /QuizKeyUnavailableError/);
      for (const k of [DUMMY_AUTH_SECRET, token, token.split(".")[1], "[1,0,2]", "answers"]) assert.ok(!out.includes(k), `ログに ${k.slice(0, 8)} が出た`);
      // 形が違えば鍵より先に 400（今までどおり）
      assert.equal((await submitRaw("fin1", { answers: [1, 0, 2], questionIds: serverQuestionIds("fin1") })).status, 400);
    });
  });

  it("route の POST は受験の公開前なので、鍵がなくても 503（今までどおり）", async () => {
    await withoutSecret(async () => {
      assert.equal((await submitRoute("fin1", { answers: [1, 0, 2] })).status, 503);
    });
  });
});
