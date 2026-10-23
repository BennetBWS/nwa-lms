import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { COURSE_ORDER_BY } from "../../src/lib/course-order";
import { questionRevision } from "../../src/lib/admin-quiz-revision";

// #81 Q1 クイズ管理 API（GET /api/admin/quizzes・GET /api/admin/quizzes/[id]・PATCH /api/admin/questions/[id]）。
// #82（Q3）で GET の一覧の今の挙動を固定していたファイルを、Q1 の仕様に書き換えた。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物（受け取った引数を記録し、
// 知らないモデル・メソッドは例外。select は入れ子のリレーションと _count まで再現する。偽 $transaction は
// コールバックを呼ぶだけで、原子性・ロールバックは再現しない）。NextAuth は installFakeAuth で差し替える。データはすべてダミー。

type Row = Record<string, unknown>;
type Call = { method: string; args: Row };

let session: FakeSession;
let calls: Call[];
let db: { courses: Row[]; sections: Row[]; lessons: Row[]; quizzes: Row[]; questions: Row[]; attempts: Row[]; revisions: Row[] };
/** method 名 → 投げるエラー */
let failOn: Map<string, unknown>;
/** updateMany の直前に呼ぶ（読んでから書くまでの間に別の講師が直した、を再現する） */
let beforeUpdate: (() => void) | null;
let logs: string[];

let LIST: () => Promise<Response>;
let DETAIL: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let listModule: Row;
let detailModule: Row;
let patchModule: Row;

// ───────────── 偽 prisma ─────────────

type Relation = { model: string; many: boolean; rows: (parent: Row) => Row[] };

const RELATIONS: Record<string, Record<string, Relation>> = {
  course: {},
  lesson: { section: { model: "section", many: false, rows: (l) => db.sections.filter((s) => s.id === l.sectionId) } },
  section: {},
  quiz: {
    lesson: { model: "lesson", many: false, rows: (q) => db.lessons.filter((l) => l.id === q.lessonId) },
    questions: { model: "question", many: true, rows: (q) => db.questions.filter((x) => x.quizId === q.id) },
  },
  question: {},
};

const COUNTS: Record<string, Record<string, (parent: Row) => number>> = {
  quiz: { attempts: (q) => db.attempts.filter((a) => a.quizId === q.id).length },
};

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

function project(model: string, row: Row, select: Row | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    if (k === "_count") {
      const counted: Row = {};
      for (const [ck, cv] of Object.entries((v as { select: Row }).select)) {
        const fn = COUNTS[model]?.[ck];
        if (!cv || !fn) throw new Error(`fake prisma: unsupported _count ${model}.${ck}`);
        counted[ck] = fn(row);
      }
      out._count = counted;
      continue;
    }
    const rel = RELATIONS[model]?.[k];
    if (rel) {
      const spec = (v === true ? {} : v) as { orderBy?: unknown; select?: Row };
      const rows = sortRows(rel.rows(row), spec.orderBy);
      out[k] = rel.many ? rows.map((r) => project(rel.model, r, spec.select)) : rows[0] ? project(rel.model, rows[0], spec.select) : null;
      continue;
    }
    if (v !== true) throw new Error(`fake prisma: unsupported select ${model}.${k}`);
    if (!(k in row)) throw new Error(`fake prisma: unknown column ${model}.${k}`);
    out[k] = row[k];
  }
  return out;
}

function record(method: string, args: unknown) {
  calls.push({ method, args: (args ?? {}) as Row });
  if (failOn.has(method)) throw failOn.get(method);
}

/** updateMany の where（値の一致と、Json の equals だけ） */
function matchQuestion(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "options") {
      const eq = (v as { equals?: unknown }).equals;
      if (Object.keys(v as Row).join() !== "equals") throw new Error("fake prisma: unsupported options filter");
      if (eq === Prisma.JsonNull) return row.options === null;
      return JSON.stringify(row.options) === JSON.stringify(eq);
    }
    if (typeof v === "object" && v !== null) throw new Error(`fake prisma: unsupported where ${k}`);
    return row[k] === v;
  });
}

const tables: Record<string, () => Row[]> = {
  course: () => db.courses,
  quiz: () => db.quizzes,
  question: () => db.questions,
};

function findUnique(model: string, method: string) {
  return async (args: Row) => {
    record(method, args);
    const id = (args.where as { id: string }).id;
    const row = tables[model]().find((r) => r.id === id);
    return row ? project(model, row, args.select as Row | undefined) : null;
  };
}

function unexpected(prop: string) {
  return new Proxy(
    {},
    {
      get(_t, method) {
        return () => {
          throw new Error(`fake prisma: unexpected ${prop}.${String(method)}`);
        };
      },
    }
  );
}

const fakeBase: Row = {
  course: {
    async findMany(args: Row) {
      record("course.findMany", args);
      return sortRows(db.courses, args.orderBy).map((c) => project("course", c, args.select as Row | undefined));
    },
    findUnique: findUnique("course", "course.findUnique"),
  },
  quiz: {
    async findMany(args: Row) {
      record("quiz.findMany", args);
      return db.quizzes.map((q) => project("quiz", q, args.select as Row | undefined));
    },
    findUnique: findUnique("quiz", "quiz.findUnique"),
  },
  quizQuestion: {
    findUnique: findUnique("question", "quizQuestion.findUnique"),
    async updateMany(args: Row) {
      if (beforeUpdate) beforeUpdate();
      record("quizQuestion.updateMany", args);
      const hit = db.questions.filter((r) => matchQuestion(r, args.where as Row));
      for (const r of hit) Object.assign(r, args.data as Row);
      return { count: hit.length };
    },
  },
  quizQuestionRevision: {
    async create(args: Row) {
      record("quizQuestionRevision.create", args);
      const row = { id: `rev_${db.revisions.length}`, createdAt: new Date("2026-10-21T00:00:00.000Z"), ...(args.data as Row) };
      db.revisions.push(row);
      return { id: row.id };
    },
  },
  quizAttempt: {
    async count(args: Row) {
      record("quizAttempt.count", args);
      const quizId = (args.where as { quizId: string }).quizId;
      return db.attempts.filter((a) => a.quizId === quizId).length;
    },
  },
};

const fake: Row = new Proxy(fakeBase, {
  get(target, prop) {
    if (prop === "$transaction") {
      return async (fn: (tx: unknown) => Promise<unknown>) => {
        calls.push({ method: "$transaction", args: {} });
        return fn(fake);
      };
    }
    if (typeof prop === "string" && !(prop in target)) return unexpected(prop);
    return target[prop as string];
  },
});

// ───────────── 準備 ─────────────

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fake;
  installFakeAuth(() => session);
  listModule = (await import("../../src/app/api/admin/quizzes/route")) as Row;
  detailModule = (await import("../../src/app/api/admin/quizzes/[id]/route")) as Row;
  patchModule = (await import("../../src/app/api/admin/questions/[id]/route")) as Row;
  LIST = listModule.GET as typeof LIST;
  DETAIL = detailModule.GET as typeof DETAIL;
  PATCH = patchModule.PATCH as typeof PATCH;
});

const SECRET_TEXT = "ダミー問題文の本文";
const SECRET_OPTION = "ダミー選択肢の文";

beforeEach(() => {
  session = INSTRUCTOR_SESSION;
  calls = [];
  failOn = new Map();
  beforeUpdate = null;
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    mock.method(console, level, (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  mock.method(globalThis, "fetch", async () => {
    throw new Error("network access is not allowed in tests");
  });
  db = {
    courses: [
      // 登録順と [order, id] の順を逆にしておく
      { id: "c2", name: "STEP2 ダミー", order: 2, icon: "x", color: "#000000", description: null },
      { id: "c1", name: "STEP1 ダミー", order: 1, icon: "x", color: "#000000", description: null },
    ],
    sections: [
      { id: "s1", courseId: "c1", title: "S1", order: 1 },
      { id: "s2", courseId: "c2", title: "S2", order: 1 },
    ],
    lessons: [
      { id: "l1", sectionId: "s1", title: "ダミーレッスン1", order: 1, type: "VIDEO", videoUrl: "https://example.com/v", content: null, pdfUrl: null, duration: null },
      { id: "l2", sectionId: "s2", title: "ダミーレッスン2", order: 1, type: "VIDEO", videoUrl: null, content: null, pdfUrl: null, duration: null },
    ],
    quizzes: [
      { id: "mini2", title: "ミニ2", type: "MINI", courseId: null, lessonId: "l2" },
      { id: "fin1", title: "修了1", type: "FINAL", courseId: "c1", lessonId: null },
      { id: "mini1", title: "ミニ1", type: "MINI", courseId: null, lessonId: "l1" },
      { id: "broken", title: "壊れた", type: "FINAL", courseId: "c2", lessonId: null },
      { id: "orphan", title: "コースなし", type: "FINAL", courseId: null, lessonId: null },
    ],
    questions: [
      { id: "q2", quizId: "mini1", question: "問2", options: ["a", "b"], correctIndex: 0, order: 2 },
      { id: "q1", quizId: "mini1", question: SECRET_TEXT, options: [SECRET_OPTION, "誤B", "誤C"], correctIndex: 0, order: 1 },
      { id: "f1", quizId: "fin1", question: "修了問", options: ["x", "y"], correctIndex: 1, order: 1 },
      { id: "m2", quizId: "mini2", question: "ミニ2問", options: ["x", "y"], correctIndex: 0, order: 1 },
      { id: "bq", quizId: "broken", question: "壊れた問", options: ["1つだけ"], correctIndex: 0, order: 1 },
      { id: "nq", quizId: "broken", question: "null の問", options: null, correctIndex: 0, order: 2 },
      { id: "oq", quizId: "orphan", question: "孤立問", options: ["x", "y"], correctIndex: 0, order: 1 },
    ],
    attempts: [
      { id: "a1", quizId: "mini1", userId: "stu_active", score: 50, passed: false, answers: [0, 1] },
      { id: "a2", quizId: "mini1", userId: "stu_2", score: 100, passed: true, answers: [0, 0] },
      { id: "a3", quizId: "fin1", userId: "stu_active", score: 0, passed: false, answers: [0] },
    ],
    revisions: [],
  };
});

afterEach(() => {
  mock.restoreAll();
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const detail = (id: string) => DETAIL(new Request(`http://localhost/api/admin/quizzes/${id}`), ctx(id));
const patchRaw = (id: string, body: string) =>
  PATCH(new Request(`http://localhost/api/admin/questions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body }), ctx(id));
const patch = (id: string, body: unknown) => patchRaw(id, JSON.stringify(body));
const question = (id: string) => {
  const q = db.questions.find((x) => x.id === id);
  assert.ok(q, `問題 ${id} がない`);
  return q;
};
const revOf = (id: string) => {
  const q = question(id);
  return questionRevision({ question: q.question as string, options: q.options as Prisma.JsonValue, correctIndex: q.correctIndex as number });
};
const writes = () => calls.filter((c) => c.method === "quizQuestion.updateMany" || c.method === "quizQuestionRevision.create");
const dbCalls = () => calls.filter((c) => c.method !== "$transaction");

// ───────────── export ─────────────

describe("export（閉じたメソッドを戻さない。#81 Q3）", () => {
  for (const [label, mod, expected] of [
    ["admin/quizzes/route.ts", () => listModule, ["GET"]],
    ["admin/quizzes/[id]/route.ts", () => detailModule, ["GET"]],
    ["admin/questions/[id]/route.ts", () => patchModule, ["PATCH"]],
  ] as Array<[string, () => Row, string[]]>) {
    it(`${label} は ${expected.join("・")} だけを export する`, () => {
      const methods = Object.keys(mod()).filter((k) => /^[A-Z]+$/.test(k));
      assert.deepEqual(methods, expected, `${label} の export が違う：${JSON.stringify(methods)}`);
    });
  }
});

// ───────────── 権限 ─────────────

const handlers: Array<[string, () => Promise<Response>]> = [
  ["GET 一覧", () => LIST()],
  ["GET 詳細", () => detail("mini1")],
  ["PATCH", () => patch("q1", { revision: "a".repeat(64), correctIndex: 1 })],
];

describe("権限：未ログインは 401、講師以外は 403。どちらも DB を読まない", () => {
  for (const [name, call] of handlers) {
    for (const [label, s, status] of [
      ["未ログイン", null, 401],
      ["id のないセッション", { user: { role: "INSTRUCTOR" } }, 401],
      ["受講生", STUDENT_SESSION, 403],
      ["role なし", { user: { id: "x" } }, 403],
      ["小文字の instructor", { user: { id: "x", role: "instructor" } }, 403],
    ] as Array<[string, FakeSession, number]>) {
      it(`${name}：${label}は ${status}`, async () => {
        session = s;
        const res = await call();
        assert.equal(res.status, status);
        assert.deepEqual(await res.json(), { error: status === 401 ? "Unauthorized" : "Forbidden" });
        assert.equal(res.headers.get("Cache-Control"), "no-store", "401 / 403 に no-store がない");
        assert.deepEqual(calls, [], "権限のない呼び出しで DB を読んでいる");
      });
    }
  }
});

// ───────────── GET 一覧 ─────────────

describe("GET /api/admin/quizzes", () => {
  it("コース（COURSE_ORDER_BY）→ 修了テスト → ミニテスト → コースなしの順で、状態・件数を付けて返す", async () => {
    const res = await LIST();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const courseCall = calls.find((c) => c.method === "course.findMany");
    assert.ok(courseCall, "コースを読んでいない");
    assert.equal(courseCall.args.orderBy, COURSE_ORDER_BY, "COURSE_ORDER_BY（同じ参照）で読んでいない");
    const body = (await res.json()) as { quizzes: Row[] };
    assert.deepEqual(Object.keys(body), ["quizzes"]);
    assert.deepEqual(
      body.quizzes.map((q) => [q.id, q.courseId, q.status, q.questionCount, q.attemptCount]),
      [
        ["fin1", "c1", "ok", 1, 1],
        ["mini1", "c1", "ok", 2, 2],
        ["broken", "c2", "unavailable", 2, 0],
        ["mini2", "c2", "ok", 1, 0],
        ["orphan", null, "no_course", 1, 0],
      ]
    );
  });

  it("項目は許可リストだけ（選択肢・正解・問題文・レッスンの URL を含めない）", async () => {
    const body = (await (await LIST()).json()) as { quizzes: Row[] };
    for (const q of body.quizzes) {
      assert.deepEqual(
        Object.keys(q).sort(),
        ["attemptCount", "courseId", "courseName", "id", "lessonTitle", "questionCount", "status", "title", "type"],
        `${String(q.id)} の項目が許可リストと違う`
      );
    }
    const text = JSON.stringify(body);
    for (const s of [SECRET_TEXT, SECRET_OPTION, "correctIndex", "options", "example.com"]) {
      assert.ok(!text.includes(s), `一覧に ${s} が含まれる`);
    }
  });

  it("クイズがなければ空配列", async () => {
    db.quizzes = [];
    const res = await LIST();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { quizzes: [] });
  });

  it("DB のエラーは 500 の汎用の本文で、ログはエラー名だけ", async () => {
    failOn.set("quiz.findMany", Object.assign(new Error(`connection failed for a@example.com ${SECRET_TEXT}`), { name: "PrismaClientInitializationError" }));
    const res = await LIST();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(logs, ["GET /api/admin/quizzes error: PrismaClientInitializationError"]);
  });
});

// ───────────── GET 詳細 ─────────────

describe("GET /api/admin/quizzes/[id]", () => {
  it("問題は [order, id] の順、選択肢は元の並び。valid と revision（内容の sha256）を付ける", async () => {
    const res = await detail("mini1");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const quizCall = calls.find((c) => c.method === "quiz.findUnique");
    assert.ok(quizCall, "クイズを読んでいない");
    const qs = (quizCall.args.select as { questions: { orderBy: unknown } }).questions;
    assert.deepEqual(qs.orderBy, [{ order: "asc" }, { id: "asc" }], "問題を [order, id] で読んでいない");
    const body = (await res.json()) as Row & { questions: Row[] };
    assert.deepEqual(
      { id: body.id, title: body.title, type: body.type, courseName: body.courseName, lessonTitle: body.lessonTitle, attemptCount: body.attemptCount, status: body.status },
      { id: "mini1", title: "ミニ1", type: "MINI", courseName: "STEP1 ダミー", lessonTitle: "ダミーレッスン1", attemptCount: 2, status: "ok" }
    );
    assert.deepEqual(body.questions.map((q) => q.id), ["q1", "q2"]);
    assert.deepEqual(body.questions[0], {
      id: "q1",
      order: 1,
      question: SECRET_TEXT,
      options: [SECRET_OPTION, "誤B", "誤C"],
      correctIndex: 0,
      valid: true,
      revision: revOf("q1"),
    });
    assert.deepEqual(Object.keys(body).sort(), ["attemptCount", "courseName", "id", "lessonTitle", "questions", "status", "title", "type"]);
  });

  it("ミニテストのコースはレッスンのコース、修了テストは courseId のコースを id で 1 件読む", async () => {
    await detail("mini2");
    assert.deepEqual(calls.find((c) => c.method === "course.findUnique")?.args.where, { id: "c2" });
    calls = [];
    const fin = (await (await detail("fin1")).json()) as Row;
    assert.deepEqual(calls.find((c) => c.method === "course.findUnique")?.args.where, { id: "c1" });
    assert.deepEqual([fin.courseName, fin.lessonTitle], ["STEP1 ダミー", null]);
  });

  it("壊れた問題は options が null・valid が false で、クイズは unavailable", async () => {
    const body = (await (await detail("broken")).json()) as Row & { questions: Row[] };
    assert.equal(body.status, "unavailable");
    assert.deepEqual(body.questions.map((q) => [q.id, q.options, q.valid]), [["bq", null, false], ["nq", null, false]]);
  });

  it("コースのないクイズは courseName が null・no_course（コースを読まない）", async () => {
    const body = (await (await detail("orphan")).json()) as Row;
    assert.deepEqual([body.courseName, body.status], [null, "no_course"]);
    assert.ok(!calls.some((c) => c.method === "course.findUnique"), "コースのないクイズでコースを読んだ");
  });

  it("修了テストの courseId のコースが存在しなければ no_course", async () => {
    db.quizzes.push({ id: "gone", title: "消えたコース", type: "FINAL", courseId: "c_gone", lessonId: null });
    db.questions.push({ id: "gq", quizId: "gone", question: "問", options: ["x", "y"], correctIndex: 0, order: 1 });
    const body = (await (await detail("gone")).json()) as Row;
    assert.deepEqual([body.courseName, body.status], [null, "no_course"]);
  });

  it("id が空・65 文字なら 400 invalid_id で、DB を読まない", async () => {
    for (const id of ["", "x".repeat(65)]) {
      const res = await detail(id);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_id" });
      assert.equal(res.headers.get("Cache-Control"), "no-store");
    }
    assert.deepEqual(calls, [], "invalid_id で DB を読んだ");
  });

  it("ないクイズは 404", async () => {
    const res = await detail("nope");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Quiz not found" });
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });

  it("P2025 は 404、それ以外の DB のエラーは 500（ログはエラー名だけ）", async () => {
    failOn.set("quiz.findUnique", Object.assign(new Error("Record not found mini1"), { name: "PrismaClientKnownRequestError", code: "P2025" }));
    assert.equal((await detail("mini1")).status, 404);
    failOn.set("quiz.findUnique", Object.assign(new Error(`boom ${SECRET_TEXT} mini1`), { name: "PrismaClientUnknownRequestError" }));
    const res = await detail("mini1");
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.deepEqual(logs, ["GET /api/admin/quizzes/[id] error: PrismaClientUnknownRequestError"]);
  });
});

// ───────────── PATCH ─────────────

describe("PATCH /api/admin/questions/[id]：200", () => {
  it("正解だけを変える：条件付きの updateMany・履歴 1 行・受験件数を返す", async () => {
    const before = revOf("q1");
    const res = await patch("q1", { revision: before, correctIndex: 2 });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const body = (await res.json()) as Row & { question: Row };

    // updateMany は読んだ値と同じことを条件にし、変わった項目だけを書く
    const upd = calls.find((c) => c.method === "quizQuestion.updateMany");
    assert.ok(upd, "updateMany を呼んでいない");
    assert.deepEqual(upd.args.where, {
      id: "q1",
      question: SECRET_TEXT,
      correctIndex: 0,
      options: { equals: [SECRET_OPTION, "誤B", "誤C"] },
    });
    assert.deepEqual(upd.args.data, { correctIndex: 2 });
    assert.equal(question("q1").correctIndex, 2);

    // 履歴は 1 行。changedFields は空でない配列。before / after は {question, options, correctIndex}
    const created = calls.filter((c) => c.method === "quizQuestionRevision.create");
    assert.equal(created.length, 1, "履歴を 1 行だけ書いていない");
    const data = created[0].args.data as Row;
    assert.deepEqual(Object.keys(data).sort(), ["after", "before", "changedFields", "editorId", "questionId", "quizId"]);
    assert.ok(Array.isArray(data.changedFields) && (data.changedFields as unknown[]).length > 0, "changedFields が空でない配列ではない");
    assert.deepEqual(data.changedFields, ["correctIndex"]);
    assert.deepEqual([data.questionId, data.quizId, data.editorId], ["q1", "mini1", "ins_1"]);
    assert.deepEqual(data.before, { question: SECRET_TEXT, options: [SECRET_OPTION, "誤B", "誤C"], correctIndex: 0 });
    assert.deepEqual(data.after, { question: SECRET_TEXT, options: [SECRET_OPTION, "誤B", "誤C"], correctIndex: 2 });

    // 受験記録はクイズで数える（再採点しない：記録は変わらない）
    assert.deepEqual(calls.find((c) => c.method === "quizAttempt.count")?.args, { where: { quizId: "mini1" } });
    assert.deepEqual(db.attempts.map((a) => [a.id, a.score, a.passed]), [["a1", 50, false], ["a2", 100, true], ["a3", 0, false]]);

    // 応答
    assert.deepEqual(Object.keys(body).sort(), ["attemptCount", "changed", "inProgressInvalidated", "question"]);
    assert.deepEqual([body.changed, body.inProgressInvalidated, body.attemptCount], [["correctIndex"], false, 2]);
    assert.deepEqual(body.question, {
      id: "q1",
      order: 1,
      question: SECRET_TEXT,
      options: [SECRET_OPTION, "誤B", "誤C"],
      correctIndex: 2,
      valid: true,
      revision: revOf("q1"),
    });
    assert.notEqual(body.question.revision, before, "revision が変わっていない");

    // 1 つのトランザクションで、読む → 書く → 履歴 → 数える の順
    assert.deepEqual(calls.map((c) => c.method), ["$transaction", "quizQuestion.findUnique", "quizQuestion.updateMany", "quizQuestionRevision.create", "quizAttempt.count"]);
  });

  it("応答の revision は、続けて GET した詳細の revision と同じ（続けて編集できる）", async () => {
    const body = (await (await patch("q1", { revision: revOf("q1"), question: "直した問題文" })).json()) as { question: { revision: string } };
    const d = (await (await detail("mini1")).json()) as { questions: Array<{ id: string; revision: string }> };
    assert.equal(d.questions.find((q) => q.id === "q1")?.revision, body.question.revision);
    const again = await patch("q1", { revision: body.question.revision, correctIndex: 1 });
    assert.equal(again.status, 200, "新しい revision で続けて編集できない");
  });

  it("選択肢を変えると inProgressInvalidated が true。前後の空白は除いて保存する", async () => {
    const res = await patch("q1", { revision: revOf("q1"), options: [" 新A ", "新B"], correctIndex: 1, question: `  ${SECRET_TEXT}  ` });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.deepEqual([body.changed, body.inProgressInvalidated], [["options", "correctIndex"], true]);
    assert.deepEqual(question("q1").options, ["新A", "新B"]);
    assert.deepEqual((calls.find((c) => c.method === "quizQuestion.updateMany")?.args.data), { options: ["新A", "新B"], correctIndex: 1 });
  });

  it("options が JSON の null の問題も直せる（updateMany の条件は Prisma.JsonNull）。before にも null を残す", async () => {
    const res = await patch("nq", { revision: revOf("nq"), options: ["x", "y"] });
    assert.equal(res.status, 200);
    const upd = calls.find((c) => c.method === "quizQuestion.updateMany");
    assert.equal((upd?.args.where as { options: { equals: unknown } }).options.equals, Prisma.JsonNull, "JSON の null の条件が Prisma.JsonNull でない");
    const data = calls.find((c) => c.method === "quizQuestionRevision.create")?.args.data as Row;
    assert.deepEqual(data.before, { question: "null の問", options: null, correctIndex: 0 });
    assert.deepEqual((await res.json()).question.valid, true);
  });

  it("ログは固定文と変わった項目の名前だけ（id・本文・選択肢を出さない）", async () => {
    await patch("q1", { revision: revOf("q1"), options: ["新しい選択肢の文A", "新しい選択肢の文B"], question: "新しい問題文", correctIndex: 1 });
    assert.deepEqual(logs, ["[admin] quiz question updated: question,options,correctIndex"]);
    const text = logs.join("\n");
    for (const s of ["q1", "mini1", "ins_1", SECRET_TEXT, SECRET_OPTION, "新しい問題文", "新しい選択肢の文"]) {
      assert.ok(!text.includes(s), `ログに ${s} が含まれる`);
    }
  });
});

describe("PATCH /api/admin/questions/[id]：400（DB を読まずに分かるもの）", () => {
  const R = "a".repeat(64);
  const cases: Array<[string, string, string]> = [
    ["JSON でない", "{", "invalid_json"],
    ["配列", "[]", "invalid_json"],
    ["null", "null", "invalid_json"],
    ["order（受け付けない項目）", JSON.stringify({ revision: R, order: 3 }), "unknown_field"],
    ["quizId（受け付けない項目）", JSON.stringify({ revision: R, question: "問", quizId: "fin1" }), "unknown_field"],
    ["revision なし", JSON.stringify({ question: "問" }), "invalid_revision"],
    ["revision の形が違う", JSON.stringify({ revision: "abc", question: "問" }), "invalid_revision"],
    ["問題文が空白だけ", JSON.stringify({ revision: R, question: "   " }), "invalid_question"],
    ["問題文が 1001 字", JSON.stringify({ revision: R, question: "あ".repeat(1001) }), "invalid_question"],
    ["選択肢 1 件", JSON.stringify({ revision: R, options: ["a"] }), "invalid_options"],
    ["選択肢 11 件", JSON.stringify({ revision: R, options: Array.from({ length: 11 }, (_, i) => `o${i}`) }), "invalid_options"],
    ["選択肢の重複", JSON.stringify({ revision: R, options: ["a", "a"] }), "invalid_options"],
    ["正解 -1", JSON.stringify({ revision: R, correctIndex: -1 }), "invalid_correct_index"],
    ["正解が小数", JSON.stringify({ revision: R, correctIndex: 0.5 }), "invalid_correct_index"],
    ["変更する項目がない", JSON.stringify({ revision: R }), "no_changes"],
  ];
  for (const [label, body, reason] of cases) {
    it(`${label}は 400 ${reason} で、DB を読まない`, async () => {
      const res = await patchRaw("q1", body);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason });
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(calls, [], `${reason} で DB を読んだ`);
    });
  }

  it("id が空・65 文字なら 400 invalid_id で、DB を読まない", async () => {
    for (const id of ["", "x".repeat(65)]) {
      const res = await patch(id, { revision: R, correctIndex: 1 });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_id" });
    }
    assert.deepEqual(calls, [], "invalid_id で DB を読んだ");
  });
});

describe("PATCH /api/admin/questions/[id]：DB の値と合わせて分かるもの", () => {
  it("今の選択肢の範囲外の正解は 400 invalid_correct_index で、書かない", async () => {
    const res = await patch("q1", { revision: revOf("q1"), correctIndex: 3 });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_correct_index" });
    assert.deepEqual(writes(), [], "400 なのに書いた");
  });

  it("選択肢を減らして今の正解が範囲外になるなら 400 invalid_correct_index", async () => {
    question("q1").correctIndex = 2;
    const res = await patch("q1", { revision: revOf("q1"), options: ["a", "b"] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "invalid_correct_index");
    assert.deepEqual(writes(), [], "400 なのに書いた");
  });

  it("送った値が今と同じなら 400 no_changes で、更新も履歴も書かない", async () => {
    const res = await patch("q1", { revision: revOf("q1"), question: SECRET_TEXT, correctIndex: 0, options: [SECRET_OPTION, "誤B", "誤C"] });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid request", reason: "no_changes" });
    assert.deepEqual(writes(), [], "no_changes なのに書いた");
    assert.deepEqual(db.revisions, []);
  });

  it("ない問題は 404 で、書かない", async () => {
    const res = await patch("nope", { revision: "a".repeat(64), correctIndex: 1 });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Question not found" });
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(writes(), [], "404 なのに書いた");
  });
});

describe("PATCH /api/admin/questions/[id]：409 edit_conflict", () => {
  it("revision が今の内容と違えば 409 で、書かない", async () => {
    const stale = revOf("q1");
    question("q1").question = "別の講師が直した";
    const res = await patch("q1", { revision: stale, correctIndex: 1 });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "Conflict", reason: "edit_conflict" });
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(writes(), [], "409 なのに書いた");
  });

  for (const [label, change] of [
    ["問題文", (q: Row) => { q.question = "割り込み"; }],
    ["選択肢", (q: Row) => { q.options = ["割り込みA", "割り込みB", "割り込みC"]; }],
    ["正解", (q: Row) => { q.correctIndex = 1; }],
  ] as Array<[string, (q: Row) => void]>) {
    it(`読んでから書くまでに別の講師が${label}を直した（updateMany が 0 件）なら 409 で、履歴を書かない`, async () => {
      beforeUpdate = () => change(question("q1"));
      const res = await patch("q1", { revision: revOf("q1"), correctIndex: 2 });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "Conflict", reason: "edit_conflict" });
      assert.ok(calls.some((c) => c.method === "quizQuestion.updateMany"), "updateMany を呼んでいない");
      assert.ok(!calls.some((c) => c.method === "quizQuestionRevision.create"), "0 件なのに履歴を書いた");
      assert.notEqual(question("q1").correctIndex, 2, "割り込みを上書きした");
      assert.deepEqual(logs, [], "409 で成功のログを出した");
    });
  }
});

describe("PATCH /api/admin/questions/[id]：500 / P2025", () => {
  it("P2025 は 404（成功のログは出さない）", async () => {
    failOn.set("quizQuestion.updateMany", Object.assign(new Error("Record to update not found q1"), { name: "PrismaClientKnownRequestError", code: "P2025" }));
    const res = await patch("q1", { revision: revOf("q1"), correctIndex: 1 });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Question not found" });
    assert.deepEqual(logs, []);
  });

  it("履歴の insert が失敗したら 500（汎用の本文。ログはエラー名だけ）", async () => {
    failOn.set(
      "quizQuestionRevision.create",
      Object.assign(new Error(`check constraint violated ${SECRET_TEXT} q1`), { name: "PrismaClientKnownRequestError", code: "P2010" })
    );
    const res = await patch("q1", { revision: revOf("q1"), correctIndex: 1 });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(logs, ["PATCH /api/admin/questions/[id] error: PrismaClientKnownRequestError"]);
  });

  it("問題を読むところで失敗しても 500 で、書かない", async () => {
    failOn.set("quizQuestion.findUnique", Object.assign(new Error("boom"), { name: "PrismaClientInitializationError" }));
    const res = await patch("q1", { revision: revOf("q1"), correctIndex: 1 });
    assert.equal(res.status, 500);
    assert.deepEqual(writes(), [], "500 なのに書いた");
    assert.equal(dbCalls().length, 1, "読み込みの失敗のあとに DB を呼んだ");
  });
});

// ═════════════ tester による追加（#81 Q1） ═════════════

/** 乱数（シード固定。mulberry32） */
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

function shuffled<T>(xs: ReadonlyArray<T>, next: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const Q_KEYS = ["correctIndex", "id", "options", "order", "question", "revision", "valid"];

describe("権限（追加）：セッションの形の境界。401 / 403 では body も DB も読まない", () => {
  const extraSessions: Array<[string, FakeSession, number]> = [
    ["user のないセッション", {} as FakeSession, 401],
    ["id が空文字", { user: { id: "", role: "INSTRUCTOR" } }, 401],
    ["先頭だけ大文字の Instructor", { user: { id: "x", role: "Instructor" } }, 403],
    ["前後に空白のある INSTRUCTOR", { user: { id: "x", role: " INSTRUCTOR " } }, 403],
    ["ADMIN（存在しないロール）", { user: { id: "x", role: "ADMIN" } }, 403],
  ];
  for (const [name, call] of handlers) {
    for (const [label, s, status] of extraSessions) {
      it(`${name}：${label}は ${status}`, async () => {
        session = s;
        const res = await call();
        assert.equal(res.status, status, `${label} の状態コードが違う`);
        assert.equal(res.headers.get("Cache-Control"), "no-store", "no-store がない");
        assert.deepEqual(calls, [], "権限のない呼び出しで DB を読んでいる（$transaction を含む）");
      });
    }
  }

  for (const [label, s, status] of [
    ["未ログイン", null, 401],
    ["受講生", STUDENT_SESSION, 403],
  ] as Array<[string, FakeSession, number]>) {
    it(`PATCH：${label}（${status}）では body を読まない`, async () => {
      session = s;
      const req = new Request("http://localhost/api/admin/questions/q1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: revOf("q1"), correctIndex: 1 }),
      });
      const res = await PATCH(req, ctx("q1"));
      assert.equal(res.status, status, "状態コードが違う");
      assert.equal(req.bodyUsed, false, "権限の確認より先に body を読んだ");
      assert.deepEqual(calls, [], "DB を読んだ");
      assert.equal(question("q1").correctIndex, 0, "権限のない PATCH で書き換わった");
    });
  }
});

describe("PATCH（追加）：400 の境界（route を通す）", () => {
  const R = "a".repeat(64);
  const expect400 = async (body: string, reason: string, label: string) => {
    const res = await patchRaw("q1", body);
    assert.equal(res.status, 400, `${label} が 400 にならない（${res.status}）`);
    assert.deepEqual(await res.json(), { error: "Invalid request", reason }, `${label} の reason が違う`);
    assert.equal(res.headers.get("Cache-Control"), "no-store", `${label} に no-store がない`);
  };

  it("問題文：1000 字は 200、1001 字は 400（前後の空白は数えない）", async () => {
    const r1 = await patch("q1", { revision: revOf("q1"), question: `  ${"あ".repeat(1000)}\n` });
    assert.equal(r1.status, 200, "1000 字が通らない");
    assert.equal(question("q1").question, "あ".repeat(1000), "前後の空白を除いて保存していない");
    calls = [];
    await expect400(JSON.stringify({ revision: revOf("q1"), question: "い".repeat(1001) }), "invalid_question", "1001 字");
    assert.deepEqual(writes(), [], "1001 字で書いた");
  });

  it("サロゲートペア（絵文字）は 1 文字：1000 個は 200、1001 個は 400。\\u エスケープの JSON でも同じ", async () => {
    const e = "\u{1F600}";
    assert.equal(e.length, 2, "前提：UTF-16 で 2 単位");
    const r1 = await patchRaw("q1", JSON.stringify({ revision: revOf("q1"), question: e.repeat(1000) }));
    assert.equal(r1.status, 200, "絵文字 1000 個が通らない（2 文字として数えている）");
    // JSON のエスケープ（バックスラッシュ u D83D と u DE00 の 2 つ）で送っても 1 文字
    const escaped = `{"revision":"${revOf("q1")}","question":"${"\\uD83D\\uDE00".repeat(1001)}"}`;
    await expect400(escaped, "invalid_question", "エスケープした絵文字 1001 個");
    // 1000 字の上限は文字（コードポイント）単位：999 字 + 絵文字 1 個 = 1000 字は通る
    const r2 = await patch("q1", { revision: revOf("q1"), question: "あ".repeat(999) + e });
    assert.equal(r2.status, 200, "999 字 + 絵文字が通らない");
  });

  it("選択肢の数：1 件・11 件は 400、2 件・10 件は 200", async () => {
    const n = (k: number, p: string) => Array.from({ length: k }, (_, i) => `${p}${i}`);
    await expect400(JSON.stringify({ revision: R, options: n(1, "x") }), "invalid_options", "1 件");
    await expect400(JSON.stringify({ revision: R, options: n(11, "x") }), "invalid_options", "11 件");
    assert.deepEqual(calls, [], "1 件・11 件で DB を読んだ");
    const r2 = await patch("q1", { revision: revOf("q1"), options: n(2, "二"), correctIndex: 1 });
    assert.equal(r2.status, 200, "2 件が通らない");
    assert.deepEqual(question("q1").options, n(2, "二"));
    const r10 = await patch("q1", { revision: revOf("q1"), options: n(10, "十"), correctIndex: 9 });
    assert.equal(r10.status, 200, "10 件が通らない");
    assert.deepEqual([(question("q1").options as string[]).length, question("q1").correctIndex], [10, 9]);
  });

  it("空白（全角空白・NBSP・BOM・改行を含む）を除いたあとの重複は 400 invalid_options", async () => {
    for (const pair of [
      ["a", " a"],
      ["a", "a\n"],
      ["a", "\u3000a\u3000"],
      ["a", "\u00A0a"],
      ["a", "\uFEFFa"],
      ["選択肢", "\t選択肢 "],
    ]) {
      await expect400(JSON.stringify({ revision: R, options: [...pair, "別"] }), "invalid_options", `重複 ${JSON.stringify(pair)}`);
    }
    assert.deepEqual(calls, [], "重複で DB を読んだ");
  });

  it("見えない文字だけの問題文・選択肢は 400", async () => {
    const invisibles = ["\u200B", "\u200C\u200D", "\u2060", "\uFEFF", "\u3000", "\u3164", "\u0301", "\uFE0F", "\u00AD", "\u200E\u202E", "\u{E0041}", "\u2800", "\u200B \u3000\uFE0F\u200D"];
    for (const s of invisibles) {
      const label = JSON.stringify(s);
      await expect400(JSON.stringify({ revision: R, question: s }), "invalid_question", `問題文 ${label}`);
      await expect400(JSON.stringify({ revision: R, options: ["a", s] }), "invalid_options", `選択肢 ${label}`);
    }
    assert.deepEqual(calls, [], "見えない文字だけで DB を読んだ");
  });

  it("__proto__・constructor・prototype・toString などの項目は 400 unknown_field。Object.prototype を汚さない", async () => {
    const R2 = revOf("q1");
    const raws = [
      `{"revision":"${R2}","correctIndex":1,"__proto__":{"order":5}}`,
      `{"__proto__":{"question":"汚染","revision":"${R2}"}}`,
      `{"revision":"${R2}","correctIndex":1,"constructor":{"prototype":{"x":1}}}`,
      `{"revision":"${R2}","correctIndex":1,"prototype":1}`,
      `{"revision":"${R2}","correctIndex":1,"toString":"x"}`,
      `{"revision":"${R2}","correctIndex":1,"hasOwnProperty":1}`,
      `{"revision":"${R2}","correctIndex":1,"":1}`,
      `{"revision":"${R2}","correctIndex":1,"correctIndex ":1}`,
    ];
    for (const raw of raws) await expect400(raw, "unknown_field", raw);
    assert.deepEqual(calls, [], "unknown_field で DB を読んだ");
    const probe = {} as Record<string, unknown>;
    for (const k of ["order", "question", "revision", "x"]) {
      assert.equal(probe[k], undefined, `Object.prototype.${k} が汚れた`);
    }
  });

  it("correctIndex に true・\"1\"・null・{}・[1]・1e400・NaN（JSON では null になる）を送ると 400", async () => {
    const R2 = revOf("q1");
    for (const v of ["true", "\"1\"", "null", "{}", "[1]", "1e400", "-1e400", "-1", "0.5", "1.0000001", "10"]) {
      await expect400(`{"revision":"${R2}","correctIndex":${v}}`, "invalid_correct_index", `correctIndex ${v}`);
    }
    await expect400(JSON.stringify({ revision: R2, correctIndex: Number.NaN }), "invalid_correct_index", "NaN");
    assert.deepEqual(calls, [], "invalid_correct_index で DB を読んだ");
  });

  it("correctIndex の 1.0・1e0 は 1、-0 は 0 として受け付ける（JSON の数値として同じ値）", async () => {
    for (const v of ["1.0", "1e0"]) {
      const res = await patchRaw("q1", `{"revision":"${revOf("q1")}","correctIndex":${v}}`);
      assert.equal(res.status, 200, `${v} が通らない`);
      assert.equal(question("q1").correctIndex, 1, `${v} が 1 として保存されない`);
      // 次のために 0 に戻す（-0 で送る）
      const back = await patchRaw("q1", `{"revision":"${revOf("q1")}","correctIndex":-0}`);
      assert.equal(back.status, 200, "-0 が通らない");
      const body = (await back.json()) as { question: { correctIndex: number; revision: string } };
      assert.equal(body.question.correctIndex, 0, "-0 が 0 として返らない");
      assert.equal(body.question.revision, revOf("q1"), "-0 の保存後の revision が詳細と食い違う");
    }
    // 今が 0 の問題に -0 を送ると、変わっていないので no_changes
    const same = await patchRaw("q1", `{"revision":"${revOf("q1")}","correctIndex":-0}`);
    assert.equal(same.status, 400, "-0 と 0 を別の値とみなした");
    assert.equal((await same.json()).reason, "no_changes");
  });

  it("配列ではない JSON の値・配列・null・空の body は 400 invalid_json", async () => {
    const R2 = revOf("q1");
    for (const raw of ["\"文字列\"", "1", "true", "null", "[]", `[{"revision":"${R2}","correctIndex":1}]`, "", " ", "{\"revision\":", "\u0000"]) {
      await expect400(raw, "invalid_json", `body ${JSON.stringify(raw)}`);
    }
    assert.deepEqual(calls, [], "invalid_json で DB を読んだ");
  });

  it("revision：大文字の 16 進・63 字・65 字・前後の空白・配列は 400 invalid_revision（今の revision を大文字にしても 409 ではなく 400）", async () => {
    const cur = revOf("q1");
    for (const r of [cur.toUpperCase(), cur.slice(0, 63), `${cur}0`, ` ${cur}`, `${cur}\n`, [cur], { v: cur }, 0]) {
      await expect400(JSON.stringify({ revision: r, correctIndex: 1 }), "invalid_revision", `revision ${JSON.stringify(r).slice(0, 20)}`);
    }
    assert.deepEqual(calls, [], "invalid_revision で DB を読んだ");
  });

  it("問題文・選択肢が文字列でない（数値・配列・オブジェクト・null）なら 400", async () => {
    for (const q of [1, ["問"], { t: "問" }, null, true]) {
      await expect400(JSON.stringify({ revision: R, question: q }), "invalid_question", `question ${JSON.stringify(q)}`);
    }
    for (const o of [{ 0: "a", 1: "b", length: 2 }, "a,b", null, [["a"], ["b"]], [{ t: "a" }, { t: "b" }]]) {
      await expect400(JSON.stringify({ revision: R, options: o }), "invalid_options", `options ${JSON.stringify(o)}`);
    }
  });
});

describe("PATCH（追加）：Postgres が受け付けない文字", () => {
  // Postgres の text・jsonb は NUL（U+0000）を受け付けず、jsonb は対になっていないサロゲートも受け付けない
  // （PGlite で確認）。今の検証は見える文字が 1 つでもあれば通すため、本番では DB のエラーで 500 になる
  // （text の問題文の対になっていないサロゲートは U+FFFD に置き換わって保存され、応答の revision と食い違う）。
  // DB を読む前に 400 で断る（問題文は invalid_question、選択肢は invalid_options）。
  for (const [label, body, reason] of [
    ["問題文に NUL", { question: "問\u0000題" }, "invalid_question"],
    ["選択肢に NUL", { options: ["a\u0000", "b"] }, "invalid_options"],
    ["問題文に対になっていないサロゲート", { question: "問\uD800" }, "invalid_question"],
    ["選択肢に対になっていないサロゲート", { options: ["a\uDC00", "b"] }, "invalid_options"],
  ] as Array<[string, Row, string]>) {
    it(`${label}は 400 ${reason}（DB に送らない）`, async () => {
      const res = await patch("q1", { revision: revOf("q1"), ...body });
      assert.equal(res.status, 400, `${label} が 400 にならない（${res.status}）`);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason }, `${label} の理由が違う`);
      assert.deepEqual(writes(), [], `${label} を DB に送った`);
      assert.deepEqual(calls, [], `${label} で DB を読んだ`);
    });
  }
});

describe("競合（追加）：割り込んだ値を上書きせず、履歴を書かない", () => {
  it("revision の不一致：割り込んだ内容がそのまま残り、updateMany・履歴・受験件数を呼ばない", async () => {
    const stale = revOf("q1");
    const interrupted = { question: "別の講師の問題文", options: ["別A", "別B"], correctIndex: 1 };
    Object.assign(question("q1"), interrupted);
    const res = await patch("q1", { revision: stale, question: "自分の問題文", options: ["自A", "自B", "自C"], correctIndex: 2 });
    assert.equal(res.status, 409, "revision の不一致が 409 にならない");
    assert.deepEqual(await res.json(), { error: "Conflict", reason: "edit_conflict" });
    const q = question("q1");
    assert.deepEqual({ question: q.question, options: q.options, correctIndex: q.correctIndex }, interrupted, "割り込んだ値を上書きした");
    assert.deepEqual(calls.map((c) => c.method), ["$transaction", "quizQuestion.findUnique"], "409 のあとに DB を呼んだ");
    assert.deepEqual(db.revisions, [], "409 なのに履歴を書いた");
    assert.deepEqual(logs, [], "409 でログを出した");
  });

  it("updateMany が 0 件：割り込んだ 3 項目がそのまま残る（自分の変更を部分的にも書かない）", async () => {
    const interrupted = { question: "割り込み問", options: ["割A", "割B", "割C", "割D"], correctIndex: 3 };
    beforeUpdate = () => Object.assign(question("q1"), interrupted);
    const res = await patch("q1", { revision: revOf("q1"), question: "自分", options: ["自A", "自B"], correctIndex: 1 });
    assert.equal(res.status, 409, "割り込みが 409 にならない");
    const q = question("q1");
    assert.deepEqual({ question: q.question, options: q.options, correctIndex: q.correctIndex }, interrupted, "割り込んだ値を上書きした");
    assert.deepEqual(db.revisions, [], "履歴を書いた");
    assert.ok(!calls.some((c) => c.method === "quizAttempt.count"), "409 のあとに受験件数を数えた");
  });

  it("options が JSON の null の問題でも、割り込み（options を直した）なら 0 件で 409", async () => {
    beforeUpdate = () => {
      question("nq").options = ["割A", "割B"];
    };
    const res = await patch("nq", { revision: revOf("nq"), question: "直した" });
    assert.equal(res.status, 409, "JSON の null の行の割り込みが 409 にならない");
    assert.deepEqual([question("nq").question, question("nq").options], ["null の問", ["割A", "割B"]], "割り込みを上書きした");
    assert.deepEqual(db.revisions, [], "履歴を書いた");
  });

  it("2 人の講師が同じ revision で続けて送る：先は 200、後は 409 で、先の変更が残る", async () => {
    const r = revOf("q1");
    session = { user: { id: "ins_a", role: "INSTRUCTOR" } };
    assert.equal((await patch("q1", { revision: r, correctIndex: 1 })).status, 200, "先の講師が 200 にならない");
    session = { user: { id: "ins_b", role: "INSTRUCTOR" } };
    const late = await patch("q1", { revision: r, correctIndex: 2 });
    assert.equal(late.status, 409, "後の講師が 409 にならない");
    assert.equal(question("q1").correctIndex, 1, "後の講師が先の変更を上書きした");
    assert.deepEqual(db.revisions.map((x) => x.editorId), ["ins_a"], "履歴が先の講師の 1 行だけでない");
  });
});

describe("履歴（追加）：QuizQuestionRevision の内容", () => {
  it("changedFields の並びは body の項目の順によらず question → options → correctIndex", async () => {
    const raw = `{"correctIndex":1,"options":["新A","新B","新C"],"question":"新しい問","revision":"${revOf("q1")}"}`;
    const res = await patchRaw("q1", raw);
    assert.equal(res.status, 200, "200 にならない");
    assert.deepEqual(db.revisions[0]?.changedFields, ["question", "options", "correctIndex"], "changedFields の並びが固定でない");
    assert.deepEqual((await res.json()).changed, ["question", "options", "correctIndex"], "応答の changed の並びが固定でない");
  });

  it("editorId はセッションの講師（body や別の値ではない）", async () => {
    session = { user: { id: "ins_other_dummy", role: "INSTRUCTOR" } };
    assert.equal((await patch("q1", { revision: revOf("q1"), question: "直した" })).status, 200);
    assert.equal(db.revisions[0]?.editorId, "ins_other_dummy", "editorId がセッションの講師でない");
  });

  it("乱数の編集の列（シード固定）：200 のたびに履歴 1 行。changedFields は空でなく固定の順、before は直前・after は直後の内容（3 項目）", async () => {
    const next = rng(81_001);
    const pick = <T,>(xs: ReadonlyArray<T>) => xs[Math.floor(next() * xs.length)];
    const texts = ["問A", "問B", "問C"];
    const optionSets = [["a", "b"], ["a", "b", "c"], ["c", "b", "a"], ["x", "y", "z", "w"]];
    let ok = 0;
    let noChanges = 0;
    for (let i = 0; i < 200; i++) {
      const q = question("q1");
      const prev = { question: q.question, options: q.options, correctIndex: q.correctIndex };
      const body: Row = { revision: revOf("q1") };
      if (next() < 0.5) body.question = pick(texts);
      if (next() < 0.5) body.options = pick(optionSets);
      if (next() < 0.5) body.correctIndex = Math.floor(next() * 4);
      const revBefore = db.revisions.length;
      const res = await patch("q1", body);
      const json = (await res.json()) as Row;
      if (res.status === 200) {
        ok++;
        assert.equal(db.revisions.length, revBefore + 1, `#${i} 200 なのに履歴が 1 行増えない`);
        const rev = db.revisions[db.revisions.length - 1];
        const cf = rev.changedFields as string[];
        assert.ok(Array.isArray(cf) && cf.length > 0, `#${i} changedFields が空`);
        assert.deepEqual(cf, CHANGED.filter((f) => cf.includes(f)), `#${i} changedFields の並びが固定でない`);
        assert.deepEqual(rev.before, prev, `#${i} before が直前の内容でない`);
        const now = question("q1");
        assert.deepEqual(rev.after, { question: now.question, options: now.options, correctIndex: now.correctIndex }, `#${i} after が直後の内容でない`);
        for (const f of CHANGED) {
          const changed = JSON.stringify((rev.before as Row)[f]) !== JSON.stringify((rev.after as Row)[f]);
          assert.equal(cf.includes(f), changed, `#${i} changedFields の ${f} が実際の変化と食い違う`);
        }
        assert.equal(rev.editorId, "ins_1", `#${i} editorId が違う`);
      } else {
        assert.equal(res.status, 400, `#${i} 想定外の状態コード ${res.status}`);
        assert.ok(["no_changes", "invalid_correct_index"].includes(json.reason as string), `#${i} 想定外の reason ${String(json.reason)}`);
        if (json.reason === "no_changes") noChanges++;
        assert.equal(db.revisions.length, revBefore, `#${i} 400 なのに履歴を書いた`);
        const q2 = question("q1");
        assert.deepEqual({ question: q2.question, options: q2.options, correctIndex: q2.correctIndex }, prev, `#${i} 400 なのに書き換えた`);
      }
    }
    assert.ok(ok > 20 && noChanges > 5, `乱数の構成が偏っている（200: ${ok}、no_changes: ${noChanges}）`);
  });

  it("履歴の insert が失敗したら 500。成功のログは出さない", async () => {
    failOn.set("quizQuestionRevision.create", Object.assign(new Error("new row violates check constraint"), { name: "PrismaClientKnownRequestError", code: "P2010" }));
    const res = await patch("q1", { revision: revOf("q1"), question: "直した" });
    assert.equal(res.status, 500, "履歴の失敗が 500 にならない");
    assert.ok(!logs.some((l) => l.startsWith("[admin] quiz question updated")), "失敗したのに成功のログを出した");
  });
});
const CHANGED = ["question", "options", "correctIndex"];

describe("応答の許可リストと no-store（追加）", () => {
  it("詳細：すべてのクイズのすべての問題が 7 項目だけ", async () => {
    for (const quiz of db.quizzes) {
      const res = await detail(quiz.id as string);
      assert.equal(res.status, 200, `${String(quiz.id)} が 200 にならない`);
      const body = (await res.json()) as { questions: Row[] };
      for (const q of body.questions) {
        assert.deepEqual(Object.keys(q).sort(), Q_KEYS, `${String(quiz.id)}/${String(q.id)} の項目が許可リストと違う`);
      }
    }
  });

  it("DB の行に余計な列（メールアドレス・URL・内部の値）があっても、一覧・詳細・PATCH の応答に出ない", async () => {
    const leak = { email: "leak@example.com", videoUrl: "https://leak.example.com/v", password: "dummy-hash", secret: "LEAK_TOKEN" };
    for (const rows of [db.courses, db.lessons, db.quizzes, db.questions, db.attempts]) for (const r of rows) Object.assign(r, leak);
    const texts = [
      JSON.stringify(await (await LIST()).json()),
      JSON.stringify(await (await detail("mini1")).json()),
      JSON.stringify(await (await patch("q1", { revision: revOf("q1"), question: "直した" })).json()),
    ];
    texts.forEach((t, i) => {
      for (const s of ["leak@example.com", "leak.example.com", "dummy-hash", "LEAK_TOKEN", "email", "password", "videoUrl", "userId"]) {
        assert.ok(!t.includes(s), `応答 #${i} に ${s} が含まれる`);
      }
    });
  });

  it("一覧：問題文・選択肢・正解の値が含まれない（壊れたクイズ・コースなしを含む）", async () => {
    const text = JSON.stringify(await (await LIST()).json());
    for (const q of db.questions) {
      assert.ok(!text.includes(q.question as string), `一覧に問題文 ${String(q.id)} が含まれる`);
      for (const o of (Array.isArray(q.options) ? q.options : []) as string[]) {
        if (o.length > 2) assert.ok(!text.includes(o), `一覧に選択肢 ${o} が含まれる`);
      }
    }
    for (const s of ["correctIndex", "options", "revision", "valid", "\"questions\""]) assert.ok(!text.includes(s), `一覧に ${s} が含まれる`);
  });

  it("すべての状態コードの応答に Cache-Control: no-store", async () => {
    const results: Array<[string, Response]> = [];
    results.push(["一覧 200", await LIST()]);
    results.push(["詳細 200", await detail("mini1")]);
    results.push(["詳細 400", await detail("")]);
    results.push(["詳細 404", await detail("nope")]);
    results.push(["PATCH 400", await patchRaw("q1", "{")]);
    results.push(["PATCH 404", await patch("nope", { revision: "a".repeat(64), correctIndex: 1 })]);
    results.push(["PATCH 409", await patch("q1", { revision: "b".repeat(64), correctIndex: 1 })]);
    results.push(["PATCH 200", await patch("q1", { revision: revOf("q1"), correctIndex: 1 })]);
    failOn.set("quizQuestionRevision.create", Object.assign(new Error("x"), { name: "Error" }));
    results.push(["PATCH 500", await patch("q1", { revision: revOf("q1"), correctIndex: 2 })]);
    // 偽 $transaction はロールバックしないので、直前の 500 の updateMany（correctIndex 2）が残っている。0 に戻す変更で送る
    failOn.set("quizQuestion.updateMany", Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError", code: "P2025" }));
    results.push(["PATCH 404 (P2025)", await patch("q1", { revision: revOf("q1"), correctIndex: 0 })]);
    failOn.set("quiz.findUnique", Object.assign(new Error("x"), { name: "Error" }));
    results.push(["詳細 500", await detail("mini1")]);
    for (const [label, res] of results) {
      assert.equal(res.headers.get("Cache-Control"), "no-store", `${label}（${res.status}）に no-store がない`);
    }
    assert.deepEqual(
      results.map(([, r]) => r.status),
      [200, 200, 400, 404, 400, 404, 409, 200, 500, 404, 500],
      "状態コードの並びが想定と違う"
    );
  });
});

describe("ログ（追加）：id・本文・選択肢・メールアドレスを出さない", () => {
  const SENSITIVE = ["q1", "mini1", "ins_1", SECRET_TEXT, SECRET_OPTION, "leak@example.com", "直した問題文", "直した選択肢"];
  const assertClean = (label: string) => {
    const text = logs.join("\n");
    for (const s of SENSITIVE) assert.ok(!text.includes(s), `${label} のログに ${s} が含まれる：${text}`);
  };

  it("一覧・詳細の 200 はログを出さない", async () => {
    await LIST();
    await detail("mini1");
    assert.deepEqual(logs, [], "200 でログを出した");
  });

  it("PATCH の 400・404・409 はログを出さない", async () => {
    await patchRaw("q1", "{");
    await patch("q1", { revision: "a".repeat(64), question: "\u200B" });
    await patch("nope", { revision: "a".repeat(64), correctIndex: 1 });
    await patch("q1", { revision: "b".repeat(64), correctIndex: 1 });
    await patch("q1", { revision: revOf("q1"), correctIndex: 0 });
    assert.deepEqual(logs, [], "400 / 404 / 409 でログを出した");
  });

  it("DB のエラーの本文に id・本文・メールアドレスがあっても、ログはエラー名だけ（3 本とも）", async () => {
    const err = () => Object.assign(new Error(`failed q1 mini1 ins_1 leak@example.com ${SECRET_TEXT} ${SECRET_OPTION}`), { name: "PrismaClientUnknownRequestError", meta: { target: "leak@example.com" } });
    failOn.set("course.findMany", err());
    await LIST();
    failOn = new Map([["quiz.findUnique", err()]]);
    await detail("mini1");
    failOn = new Map([["quizQuestion.updateMany", err()]]);
    await patch("q1", { revision: revOf("q1"), question: "直した問題文", options: ["直した選択肢A", "直した選択肢B"], correctIndex: 1 });
    assert.deepEqual(logs, [
      "GET /api/admin/quizzes error: PrismaClientUnknownRequestError",
      "GET /api/admin/quizzes/[id] error: PrismaClientUnknownRequestError",
      "PATCH /api/admin/questions/[id] error: PrismaClientUnknownRequestError",
    ]);
    assertClean("DB のエラー");
  });

  it("PATCH の成功のログは、どの組み合わせでも固定文と項目の名前だけ", async () => {
    for (const body of [
      { question: "直した問題文" },
      { options: ["直した選択肢A", "直した選択肢B", "直した選択肢C"] },
      { correctIndex: 2 },
      { question: "直した問題文2", correctIndex: 1 },
    ]) {
      const res = await patch("q1", { revision: revOf("q1"), ...body });
      assert.equal(res.status, 200, `${JSON.stringify(body)} が 200 にならない`);
    }
    assert.deepEqual(logs, [
      "[admin] quiz question updated: question",
      "[admin] quiz question updated: options",
      "[admin] quiz question updated: correctIndex",
      "[admin] quiz question updated: question,correctIndex",
    ]);
    assertClean("成功");
  });
});

describe("一覧（追加）：並びと status", () => {
  it("同じ order のコースは id の順（COURSE_ORDER_BY）で、その中で修了テスト → ミニテスト", async () => {
    db.courses = [
      { id: "c_b", name: "B", order: 1, icon: "x", color: "#000000", description: null },
      { id: "c_a", name: "A", order: 1, icon: "x", color: "#000000", description: null },
    ];
    db.sections = [{ id: "s_b", courseId: "c_b", title: "S", order: 1 }, { id: "s_a", courseId: "c_a", title: "S", order: 1 }];
    db.lessons = [{ id: "l_b", sectionId: "s_b", title: "LB", order: 1 }, { id: "l_a", sectionId: "s_a", title: "LA", order: 1 }];
    db.quizzes = [
      { id: "m_b", title: "M", type: "MINI", courseId: null, lessonId: "l_b" },
      { id: "f_b", title: "F", type: "FINAL", courseId: "c_b", lessonId: null },
      { id: "m_a", title: "M", type: "MINI", courseId: null, lessonId: "l_a" },
      { id: "f_a", title: "F", type: "FINAL", courseId: "c_a", lessonId: null },
    ];
    db.questions = db.quizzes.map((q) => ({ id: `${String(q.id)}_q`, quizId: q.id, question: "問", options: ["x", "y"], correctIndex: 0, order: 1 }));
    const body = (await (await LIST()).json()) as { quizzes: Row[] };
    assert.deepEqual(body.quizzes.map((q) => [q.id, q.courseName]), [["f_a", "A"], ["m_a", "A"], ["f_b", "B"], ["m_b", "B"]]);
  });

  it("修了テストの courseId が存在しないコースを指すと、最後（コースなし）に courseId・courseName が null・no_course で並ぶ", async () => {
    db.quizzes.push({ id: "gone", title: "消えたコース", type: "FINAL", courseId: "c_gone", lessonId: null });
    db.questions.push({ id: "gq", quizId: "gone", question: "問", options: ["x", "y"], correctIndex: 0, order: 1 });
    const body = (await (await LIST()).json()) as { quizzes: Row[] };
    const last2 = body.quizzes.slice(-2);
    assert.deepEqual(last2.map((q) => [q.id, q.courseId, q.courseName, q.status]), [
      ["orphan", null, null, "no_course"],
      ["gone", null, null, "no_course"],
    ], "存在しないコースを指す修了テストがコースなしの並びにない");
    assert.ok(!JSON.stringify(body).includes("c_gone"), "存在しないコースの id を返した");
  });

  it("壊れた options（null・1 件・文字列・数値・オブジェクト・文字列以外の要素）や範囲外の正解は unavailable。コースなしでも unavailable を優先", async () => {
    const broken: unknown[] = [null, ["1つ"], "a,b", 1, { a: 1 }, [1, 2], ["a", null], []];
    db.quizzes = [];
    db.questions = [];
    broken.forEach((opt, i) => {
      db.quizzes.push({ id: `bk${i}`, title: `壊${i}`, type: "FINAL", courseId: "c1", lessonId: null });
      db.questions.push({ id: `bkq${i}`, quizId: `bk${i}`, question: "問", options: opt, correctIndex: 0, order: 1 });
    });
    db.quizzes.push({ id: "range", title: "範囲外", type: "FINAL", courseId: "c1", lessonId: null });
    db.questions.push({ id: "rq", quizId: "range", question: "問", options: ["x", "y"], correctIndex: 2, order: 1 });
    db.quizzes.push({ id: "empty", title: "空", type: "FINAL", courseId: "c1", lessonId: null });
    db.quizzes.push({ id: "orphan_broken", title: "孤立壊", type: "FINAL", courseId: null, lessonId: null });
    db.questions.push({ id: "obq", quizId: "orphan_broken", question: "問", options: null, correctIndex: 0, order: 1 });
    db.quizzes.push({ id: "orphan_mini_broken", title: "孤立ミニ壊", type: "MINI", courseId: null, lessonId: null });
    db.questions.push({ id: "omq", quizId: "orphan_mini_broken", question: "問", options: ["x"], correctIndex: 0, order: 1 });
    const res = await LIST();
    assert.equal(res.status, 200, "壊れたデータで 200 にならない");
    const body = (await res.json()) as { quizzes: Row[] };
    for (const q of body.quizzes) {
      assert.equal(q.status, "unavailable", `${String(q.id)} が unavailable でない（${String(q.status)}）`);
    }
    assert.equal(body.quizzes.find((q) => q.id === "empty")?.questionCount, 0);
    assert.deepEqual(body.quizzes.slice(-2).map((q) => [q.id, q.courseId]), [["orphan_broken", null], ["orphan_mini_broken", null]]);
  });

  it("DB の空文字・重複の選択肢は、受講生側（normalizeOptions）と同じく壊れたとはみなさない（ok・valid: true。PATCH では送れない）", async () => {
    db.quizzes = [{ id: "odd", title: "空文字と重複", type: "FINAL", courseId: "c1", lessonId: null }];
    db.questions = [{ id: "oddq", quizId: "odd", question: "問", options: ["a", "", "a"], correctIndex: 0, order: 1 }];
    const list = (await (await LIST()).json()) as { quizzes: Row[] };
    assert.equal(list.quizzes[0]?.status, "ok", "空文字・重複の選択肢の状態が受講生側の規則と違う");
    const d = (await (await detail("odd")).json()) as { questions: Row[] };
    assert.deepEqual([d.questions[0]?.options, d.questions[0]?.valid], [["a", "", "a"], true]);
    // 同じ値を送り直すと PATCH の検証で断られる（直すには空文字・重複を除いて送る）
    const res = await patch("oddq", { revision: revOf("oddq"), options: ["a", "", "a"] });
    assert.equal((await res.json()).reason, "invalid_options");
    const fixed = await patch("oddq", { revision: revOf("oddq"), options: ["a", "b"] });
    assert.equal(fixed.status, 200, "空文字・重複を除いた選択肢で直せない");
  });

  it("乱数の構成（シード固定）：DB の行の並びを入れ替えても応答は同じ。並びは独立に計算した順と一致する", async () => {
    for (const seed of [1, 2, 3, 81, 2026]) {
      const next = rng(seed);
      const nCourses = 2 + Math.floor(next() * 3);
      const courses: Row[] = Array.from({ length: nCourses }, (_, i) => ({ id: `c${i}`, name: `コース${i}`, order: Math.floor(next() * 2), icon: "x", color: "#000000", description: null }));
      const sections: Row[] = [];
      const lessons: Row[] = [];
      for (const c of courses) {
        const nS = 1 + Math.floor(next() * 2);
        for (let s = 0; s < nS; s++) {
          const sid = `${String(c.id)}s${s}`;
          sections.push({ id: sid, courseId: c.id, title: "S", order: Math.floor(next() * 2) });
          const nL = 1 + Math.floor(next() * 2);
          for (let l = 0; l < nL; l++) lessons.push({ id: `${sid}l${l}`, sectionId: sid, title: `L${l}`, order: Math.floor(next() * 2) });
        }
      }
      const quizzes: Row[] = [];
      const titles = ["あ", "い", "う"];
      for (let i = 0; i < 12; i++) {
        const kind = next();
        const title = titles[Math.floor(next() * titles.length)];
        if (kind < 0.35) quizzes.push({ id: `f${i}`, title, type: "FINAL", courseId: next() < 0.8 ? courses[Math.floor(next() * nCourses)].id : next() < 0.5 ? null : "c_missing", lessonId: null });
        else if (kind < 0.9) quizzes.push({ id: `m${i}`, title, type: "MINI", courseId: null, lessonId: lessons[Math.floor(next() * lessons.length)].id });
        else quizzes.push({ id: `m${i}`, title, type: "MINI", courseId: null, lessonId: null });
      }
      const questions: Row[] = quizzes.map((q) => ({ id: `${String(q.id)}q`, quizId: q.id, question: "問", options: ["x", "y"], correctIndex: 0, order: 1 }));

      // 独立に計算した期待の順
      const sortedCourses = [...courses].sort((a, b) => (a.order as number) - (b.order as number) || ((a.id as string) < (b.id as string) ? -1 : 1));
      const cmp = (a: unknown[], b: unknown[]) => {
        for (let i = 0; i < a.length; i++) {
          if (a[i] === b[i]) continue;
          return (a[i] as string | number) < (b[i] as string | number) ? -1 : 1;
        }
        return 0;
      };
      const keyOf = (q: Row): unknown[] => {
        if (q.type === "FINAL") {
          const ci = sortedCourses.findIndex((c) => c.id === q.courseId);
          return ci < 0 ? [nCourses, 0, 0, "", 0, "", q.title, q.id] : [ci, 0, 0, "", 0, "", q.title, q.id];
        }
        const l = lessons.find((x) => x.id === q.lessonId);
        if (!l) return [nCourses, 1, 0, "", 0, "", q.title, q.id];
        const s = sections.find((x) => x.id === l.sectionId) as Row;
        const ci = sortedCourses.findIndex((c) => c.id === s.courseId);
        return [ci, 1, s.order, s.id, l.order, l.id, q.title, q.id];
      };
      const expected = [...quizzes].sort((a, b) => cmp(keyOf(a), keyOf(b))).map((q) => q.id);

      let first: string | null = null;
      for (let t = 0; t < 5; t++) {
        db.courses = shuffled(courses, next);
        db.sections = shuffled(sections, next);
        db.lessons = shuffled(lessons, next);
        db.quizzes = shuffled(quizzes, next);
        db.questions = shuffled(questions, next);
        const body = (await (await LIST()).json()) as { quizzes: Row[] };
        assert.deepEqual(body.quizzes.map((q) => q.id), expected, `seed ${seed} / 試行 ${t}：並びが期待と違う`);
        const text = JSON.stringify(body);
        if (first === null) first = text;
        assert.equal(text, first, `seed ${seed} / 試行 ${t}：DB の行の並びで応答が変わった`);
      }
    }
  });
});

describe("body の大きさ（追加）：巨大な body でも 400 を返し、DB を読まない", () => {
  const R = "a".repeat(64);
  const cases: Array<[string, () => string, string]> = [
    ["4MB の問題文", () => JSON.stringify({ revision: R, question: "あ".repeat(4_000_000) }), "invalid_question"],
    ["4MB の見えない文字の問題文", () => JSON.stringify({ revision: R, question: "\u200B".repeat(4_000_000) }), "invalid_question"],
    ["400KB の選択肢 10 件", () => JSON.stringify({ revision: R, options: Array.from({ length: 10 }, (_, i) => String(i).repeat(400_000)) }), "invalid_options"],
    ["100 万件の選択肢", () => JSON.stringify({ revision: R, options: Array.from({ length: 1_000_000 }, (_, i) => `o${i}`) }), "invalid_options"],
    ["10 万個の未知の項目", () => JSON.stringify(Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i]))), "unknown_field"],
    ["10 万段の入れ子の配列", () => "[".repeat(100_000) + "]".repeat(100_000), "invalid_json"],
    ["10 万段の入れ子の問題文", () => `{"revision":"${R}","question":${"[".repeat(100_000)}${"]".repeat(100_000)}}`, "invalid_question"],
    ["途中で切れた 4MB の JSON", () => JSON.stringify({ revision: R, question: "あ".repeat(4_000_000) }).slice(0, -3), "invalid_json"],
  ];
  for (const [label, make, reason] of cases) {
    it(`${label}は 400 ${reason}`, async () => {
      const res = await patchRaw("q1", make());
      assert.equal(res.status, 400, `${label} が 400 にならない（${res.status}）`);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason }, `${label} の reason が違う`);
      assert.deepEqual(calls, [], `${label} で DB を読んだ`);
      assert.deepEqual(logs, [], `${label} でログを出した`);
    });
  }
});
