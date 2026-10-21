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
