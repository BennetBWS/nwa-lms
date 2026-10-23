import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { QUIZ_RATE_LIMITS } from "../../src/lib/quiz-rate-limit";

// #81 Q1 結合：講師が PATCH /api/admin/questions/[id] で問題を直したときの、受験中・受験済みの受講生への影響を
// 本番の route（受講生の GET /api/quizzes/[quizId]・submit、講師の GET /api/admin/quizzes/[id]・PATCH）を通しで確かめる。
// - 選択肢の文を変えると、古いトークンの submit は 409 quiz_changed（記録しない）。開き直せば送れる
// - 正解（correctIndex）だけを変えると、古いトークンのまま送れて、新しい正解で採点される（設計のリスク R1。検知しない）
// - 過去の受験記録は再採点しない（D2 a）
// 仕組みは quizzes-route.flow.test.ts と同じ（Date だけを mock.timers で固定、偽 prisma、installFakeAuth、ダミーの AUTH_SECRET）。
// 偽 $transaction はコールバックを呼ぶだけで、原子性は再現しない。DB・ネットワークなし。データはすべてダミー。

const DUMMY_AUTH_SECRET = "dummy-auth-secret-for-admin-quiz-flow-tests";
const BASE = Date.parse("2026-10-21T03:00:00.000Z");
const MINI = QUIZ_RATE_LIMITS.MINI;

type Row = Record<string, unknown>;
type Select = Record<string, unknown>;
type Call = { method: string; args: Row };

let session: FakeSession;
let calls: Call[];
let db: { courses: Row[]; sections: Row[]; lessons: Row[]; progress: Row[]; quizzes: Row[]; questions: Row[]; attempts: Row[]; revisions: Row[] };

let STUDENT_GET: (req: Request, ctx: { params: Promise<{ quizId: string }> }) => Promise<Response>;
let SUBMIT: (req: Request, ctx: { params: Promise<{ quizId: string }> }) => Promise<Response>;
let ADMIN_DETAIL: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let ADMIN_PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

// ───────────── 偽 prisma ─────────────

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

const COUNTS: Record<string, Record<string, (parent: Row) => number>> = {
  quiz: { attempts: (q) => db.attempts.filter((a) => a.quizId === q.id).length },
};

function matchWhere(row: Row, where: unknown): boolean {
  if (!where) return true;
  return Object.entries(where as Row).every(([k, v]) => {
    if (typeof v === "object" && v !== null) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === "equals") {
        const eq = (v as { equals: unknown }).equals;
        return eq === Prisma.JsonNull ? row[k] === null : JSON.stringify(row[k]) === JSON.stringify(eq);
      }
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
      const counted: Row = {};
      for (const ck of Object.keys((v as { select: Row }).select)) {
        const fn = COUNTS[model]?.[ck];
        if (!fn) throw new Error(`fake prisma: unsupported _count ${model}.${ck}`);
        counted[ck] = fn(row);
      }
      out._count = counted;
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

function findMany(model: string, method: string, rows: () => Row[]) {
  return async (args: Row = {}) => {
    calls.push({ method, args });
    const hit = sortRows(rows().filter((r) => matchWhere(r, args.where)), args.orderBy);
    const taken = typeof args.take === "number" ? hit.slice(0, args.take) : hit;
    return taken.map((r) => project(model, r, args.select as Select | undefined));
  };
}

function findUnique(model: string, method: string, rows: () => Row[]) {
  return async (args: Row) => {
    calls.push({ method, args });
    const r = rows().find((x) => x.id === (args.where as { id: string }).id);
    return r ? project(model, r, args.select as Select | undefined) : null;
  };
}

const fakePrisma: Row = {
  course: {
    findMany: findMany("course", "course.findMany", () => db.courses),
    findUnique: findUnique("course", "course.findUnique", () => db.courses),
  },
  progress: { findMany: findMany("progress", "progress.findMany", () => db.progress) },
  quiz: {
    findMany: findMany("quiz", "quiz.findMany", () => db.quizzes),
    findUnique: findUnique("quiz", "quiz.findUnique", () => db.quizzes),
  },
  quizQuestion: {
    findUnique: findUnique("question", "quizQuestion.findUnique", () => db.questions),
    async updateMany(args: Row) {
      calls.push({ method: "quizQuestion.updateMany", args });
      const hit = db.questions.filter((r) => matchWhere(r, args.where));
      for (const r of hit) Object.assign(r, args.data as Row);
      return { count: hit.length };
    },
  },
  quizQuestionRevision: {
    async create(args: Row) {
      calls.push({ method: "quizQuestionRevision.create", args });
      const row = { id: `rev_${db.revisions.length}`, createdAt: new Date(), ...(args.data as Row) };
      db.revisions.push(row);
      return { id: row.id };
    },
  },
  quizAttempt: {
    findMany: findMany("attempt", "quizAttempt.findMany", () => db.attempts),
    async count(args: Row) {
      calls.push({ method: "quizAttempt.count", args });
      return db.attempts.filter((a) => matchWhere(a, args.where)).length;
    },
    async create(args: Row) {
      calls.push({ method: "quizAttempt.create", args });
      const row: Row = { id: `att_${String(db.attempts.length).padStart(3, "0")}`, createdAt: new Date(), ...(args.data as Row) };
      db.attempts.push(row);
      return project("attempt", row, args.select as Select | undefined);
    },
  },
  async $transaction(fn: (tx: unknown) => Promise<unknown>) {
    calls.push({ method: "$transaction", args: {} });
    return fn(fakePrisma);
  },
};

before(async () => {
  process.env.AUTH_SECRET = DUMMY_AUTH_SECRET;
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ GET: STUDENT_GET } = await import("../../src/app/api/quizzes/[quizId]/route"));
  ({ POST: SUBMIT } = await import("../../src/app/api/quizzes/[quizId]/submit/route"));
  ({ GET: ADMIN_DETAIL } = await import("../../src/app/api/admin/quizzes/[id]/route"));
  ({ PATCH: ADMIN_PATCH } = await import("../../src/app/api/admin/questions/[id]/route"));
});

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: BASE });
  // 成功のログ（固定文）を黙らせる
  mock.method(console, "info", () => {});
  mock.method(globalThis, "fetch", async () => {
    throw new Error("network access is not allowed in tests");
  });
  session = STUDENT_SESSION;
  calls = [];
  db = {
    courses: [{ id: "c1", name: "STEP1 ダミー", order: 1, icon: "it", color: "#6366F1" }],
    sections: [{ id: "s1", courseId: "c1", title: "S1", order: 1 }],
    lessons: [{ id: "l1", sectionId: "s1", title: "ダミーレッスン1", order: 1 }],
    progress: [],
    quizzes: [{ id: "mini1", title: "ダミーミニ", type: "MINI", courseId: null, lessonId: "l1" }],
    questions: [
      { id: "q1", quizId: "mini1", question: "ダミー問1", options: ["文A", "文B", "文C", "文D"], correctIndex: 0, order: 1 },
      { id: "q2", quizId: "mini1", question: "ダミー問2", options: ["文E", "文F", "文G"], correctIndex: 2, order: 2 },
    ],
    attempts: [],
    revisions: [],
  };
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

// ───────────── 手順 ─────────────

type TakeView = { questions: Array<{ id: string; options: string[] }>; attemptToken: string };

const quizCtx = (quizId: string) => ({ params: Promise.resolve({ quizId }) });
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

/** 受講生として問題を開く（シャッフルされた選択肢とトークン） */
async function open(): Promise<TakeView> {
  session = STUDENT_SESSION;
  const res = await STUDENT_GET(new Request("https://nwa-lms.example.com/api/quizzes/mini1"), quizCtx("mini1"));
  assert.equal(res.status, 200, "受講生が問題を開けない");
  return (await res.json()) as TakeView;
}

/** 受講生として、選択肢の文で答えを選んで送る（表示位置は view の並びから探す） */
async function send(view: TakeView, texts: string[]): Promise<Response> {
  session = STUDENT_SESSION;
  const answers = view.questions.map((q, i) => {
    const at = q.options.indexOf(texts[i]);
    assert.ok(at >= 0, `表示された選択肢に「${texts[i]}」がない`);
    return at;
  });
  return SUBMIT(
    new Request("https://nwa-lms.example.com/api/quizzes/mini1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers, questionIds: view.questions.map((q) => q.id), attemptToken: view.attemptToken }),
    }),
    quizCtx("mini1")
  );
}

/** 講師として詳細を読み、1 問を直す */
async function instructorEdit(questionId: string, change: Row): Promise<Row> {
  session = INSTRUCTOR_SESSION;
  const d = await ADMIN_DETAIL(new Request("http://localhost/api/admin/quizzes/mini1"), idCtx("mini1"));
  assert.equal(d.status, 200, "講師が詳細を読めない");
  const detail = (await d.json()) as { questions: Array<{ id: string; revision: string }> };
  const target = detail.questions.find((q) => q.id === questionId);
  assert.ok(target, `詳細に ${questionId} がない`);
  const res = await ADMIN_PATCH(
    new Request(`http://localhost/api/admin/questions/${questionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: target.revision, ...change }),
    }),
    idCtx(questionId)
  );
  assert.equal(res.status, 200, `講師の修正が 200 にならない（${res.status}）`);
  return (await res.json()) as Row;
}

const creates = () => calls.filter((c) => c.method === "quizAttempt.create");

// ───────────── 結合 ─────────────

describe("講師が問題を直したときの、受験中の受講生（#81 Q1 結合）", () => {
  it("選択肢の文を変えると、古いトークンの送信は 409 quiz_changed で記録しない。開き直せば新しい選択肢で送れる", async () => {
    const v1 = await open();
    const patched = await instructorEdit("q1", { options: ["文A", "文B（直した）", "文C", "文D"] });
    assert.equal(patched.inProgressInvalidated, true, "選択肢の変更で inProgressInvalidated が true でない");

    const stale = await send(v1, ["文A", "文G"]);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).reason, "quiz_changed");
    assert.equal(creates().length, 0, "409 なのに受験を記録した");

    const v2 = await open();
    assert.ok(v2.questions[0].options.includes("文B（直した）"), "開き直しても新しい選択肢が出ない");
    const ok = await send(v2, ["文A", "文G"]);
    assert.equal(ok.status, 200);
    assert.deepEqual([(await ok.json()).score, creates().length], [100, 1]);
  });

  it("選択肢の数を変えても、古いトークンの送信は 409 quiz_changed", async () => {
    const v1 = await open();
    await instructorEdit("q2", { options: ["文E", "文F", "文G", "文H"] });
    const stale = await send(v1, ["文A", "文G"]);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).reason, "quiz_changed");
  });

  it("正解だけを変えると、古いトークンのまま送れて、新しい正解で採点される（検知しない。設計の R1）", async () => {
    const v1 = await open();
    const patched = await instructorEdit("q1", { correctIndex: 1 });
    assert.deepEqual([patched.changed, patched.inProgressInvalidated], [["correctIndex"], false]);

    // 元の正解（文A）を選ぶと不正解、新しい正解（文B）を選ぶと正解
    const res = await send(v1, ["文A", "文G"]);
    assert.equal(res.status, 200, "正解だけの変更で古いトークンが 409 になった");
    const r = await res.json();
    assert.deepEqual([r.results, r.score, r.passed], [[false, true], 50, false]);

    mock.timers.tick(MINI.intervalMs);
    const res2 = await send(v1, ["文B", "文G"]);
    assert.equal(res2.status, 200);
    const r2 = await res2.json();
    assert.deepEqual([r2.results, r2.score, r2.passed], [[true, true], 100, true]);
  });

  it("問題文だけを変えても、古いトークンのまま送れる（検知しない。設計の R1）", async () => {
    const v1 = await open();
    await instructorEdit("q1", { question: "ダミー問1（直した）" });
    const res = await send(v1, ["文A", "文G"]);
    assert.equal(res.status, 200, "問題文だけの変更で古いトークンが 409 になった");
    assert.equal((await res.json()).score, 100);
  });
});

describe("講師が正解を直したときの、過去の受験記録（D2 a：再採点しない）", () => {
  it("受験記録の点数・合否・回答は変わらず、PATCH の応答の attemptCount は件数だけを返す", async () => {
    const v1 = await open();
    const first = await send(v1, ["文A", "文G"]);
    assert.equal(first.status, 200);
    const saved = JSON.parse(JSON.stringify(db.attempts));
    assert.equal(saved.length, 1, "受験を記録していない");
    assert.deepEqual([saved[0].score, saved[0].passed], [100, true]);

    const patched = await instructorEdit("q1", { correctIndex: 3 });
    assert.equal(patched.attemptCount, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(db.attempts)), saved, "PATCH で過去の受験記録が変わった");
    assert.ok(!calls.some((c) => c.method.startsWith("quizAttempt.") && !["quizAttempt.findMany", "quizAttempt.count", "quizAttempt.create"].includes(c.method)), "受験記録を書き換える呼び出しがある");

    // 履歴は 1 行（before の正解は 0、after は 3）
    assert.equal(db.revisions.length, 1, "履歴を 1 行書いていない");
    assert.deepEqual([(db.revisions[0].before as Row).correctIndex, (db.revisions[0].after as Row).correctIndex], [0, 3]);
  });
});

// ═════════════ tester による追加（#81 Q1） ═════════════

describe("講師が問題を直したときの、受験中の受講生（追加）", () => {
  const assertStale409 = async (res: Response, label: string) => {
    assert.equal(res.status, 409, `${label}：古いトークンの送信が 409 にならない（${res.status}）`);
    const body = (await res.json()) as Row;
    assert.equal(body.reason, "quiz_changed", `${label}：reason が quiz_changed でない`);
    for (const k of ["score", "results", "passed", "correctIndex"]) assert.ok(!(k in body), `${label}：409 の本文に ${k} がある`);
    assert.equal(creates().length, 0, `${label}：409 なのに受験を記録した`);
    assert.deepEqual(db.attempts, [], `${label}：受験記録が増えた`);
  };

  it("選択肢を減らした（4 → 3 件）あとの古いトークンは 409 quiz_changed で記録しない", async () => {
    const v1 = await open();
    await instructorEdit("q1", { options: ["文A", "文B", "文C"] });
    await assertStale409(await send(v1, ["文A", "文G"]), "選択肢を減らした");
  });

  it("選択肢の並べ替え（文は同じ、正解の位置を付け替え）でも、古いトークンは 409 quiz_changed で記録しない", async () => {
    const v1 = await open();
    const patched = await instructorEdit("q1", { options: ["文D", "文C", "文B", "文A"], correctIndex: 3 });
    assert.deepEqual([patched.changed, patched.inProgressInvalidated], [["options", "correctIndex"], true]);
    await assertStale409(await send(v1, ["文A", "文G"]), "並べ替え");
    // 開き直すと、正解は同じ文（文A）のまま
    const v2 = await open();
    const ok = await send(v2, ["文A", "文G"]);
    assert.equal(ok.status, 200, "開き直しても送れない");
    assert.equal((await ok.json()).score, 100, "並べ替えのあと、同じ文の正解で採点されない");
  });

  it("前後の空白だけが違う選択肢を送っても、保存は除いた値なので変わらず no_changes（受験中のトークンは有効なまま）", async () => {
    const v1 = await open();
    session = INSTRUCTOR_SESSION;
    const d = (await (await ADMIN_DETAIL(new Request("http://localhost/api/admin/quizzes/mini1"), idCtx("mini1"))).json()) as { questions: Array<{ id: string; revision: string }> };
    const rev = d.questions.find((q) => q.id === "q1")?.revision;
    const res = await ADMIN_PATCH(
      new Request("http://localhost/api/admin/questions/q1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: rev, options: [" 文A", "文B ", "\u3000文C", "文D\n"] }),
      }),
      idCtx("q1")
    );
    assert.equal(res.status, 400, "空白だけの違いで 400 no_changes にならない");
    assert.equal((await res.json()).reason, "no_changes");
    assert.deepEqual(db.revisions, [], "no_changes なのに履歴を書いた");
    const sent = await send(v1, ["文A", "文G"]);
    assert.equal(sent.status, 200, "no_changes のあとに古いトークンが 409 になった");
  });

  it("問題文と正解を同時に変えると、古いトークンのまま送れて、新しい正解で採点される", async () => {
    const v1 = await open();
    const patched = await instructorEdit("q2", { question: "ダミー問2（直した）", correctIndex: 0 });
    assert.deepEqual([patched.changed, patched.inProgressInvalidated], [["question", "correctIndex"], false]);
    const res = await send(v1, ["文A", "文E"]);
    assert.equal(res.status, 200, "問題文と正解の変更で古いトークンが 409 になった");
    const r = await res.json();
    assert.deepEqual([r.results, r.score], [[true, true], 100], "新しい正解で採点されていない");
    assert.deepEqual(db.attempts[0]?.answers, [0, 0], "回答が元の位置で保存されていない");
  });

  it("選択肢を変えても、過去の受験記録（点数・合否・回答）は変わらない", async () => {
    const v1 = await open();
    assert.equal((await send(v1, ["文B", "文G"])).status, 200);
    const saved = JSON.parse(JSON.stringify(db.attempts));
    await instructorEdit("q1", { options: ["新A", "新B"], correctIndex: 1 });
    await instructorEdit("q2", { question: "直した", options: ["新E", "新F", "新G", "新H"], correctIndex: 3 });
    assert.deepEqual(JSON.parse(JSON.stringify(db.attempts)), saved, "選択肢の変更で過去の受験記録が変わった");
    assert.equal(db.revisions.length, 2, "履歴が 2 行でない");
    assert.ok(!calls.some((c) => c.method.startsWith("quizAttempt.") && !["quizAttempt.findMany", "quizAttempt.count", "quizAttempt.create"].includes(c.method)), "受験記録を書き換える呼び出しがある");
  });
});
