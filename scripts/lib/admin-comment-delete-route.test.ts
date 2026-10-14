import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #47 P1 DELETE /api/admin/comments/[id]（講師による質問・返信の削除）。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数と「トランザクションの中か」を記録し、このルートが使う findUnique の where { id }・
// 入れ子の select（user / lesson.section.course / replies と orderBy）・findMany の where { parentId: { in } }・
// deleteMany の where { id: { in } }・
// delete の where { id } だけを再現する。知らない select・where は例外。comment と $transaction 以外へのアクセスも記録する）。
// 偽の $transaction はコールバックを同じ偽物で呼ぶだけで、失敗時のロールバック（原子性）は再現しない。
// 実物の FK（ON DELETE SET NULL）は、delete のときに残った返信の parentId を null にして再現する。
// NextAuth は installFakeAuth で差し替える。データはすべてダミー（example.com）。

type Role = "STUDENT" | "INSTRUCTOR";
type UserRow = { id: string; email: string; name: string; role: Role; avatar: string | null; deactivatedAt: Date | null; password: string };
type CommentRow = { id: string; userId: string; lessonId: string; content: string; parentId: string | null; createdAt: Date };
type LessonRow = { id: string; title: string; courseId: string };
type CourseRow = { id: string; name: string };
type Call = { method: string; args: Record<string, unknown>; inTx: boolean };
type Select = Record<string, unknown>;

const ME = "ins_1";
const DUMMY_EMAIL = "student@example.com";
const BASE = Date.parse("2026-10-14T12:00:00.000Z");

let session: FakeSession;
let calls: Call[];
let otherAccess: string[];
let users: UserRow[];
let courses: CourseRow[];
let lessons: LessonRow[];
let comments: CommentRow[];
let inTx: boolean;
let failWith: unknown;
let DELETE: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

function sortRows<R extends Record<string, unknown>>(rows: R[], orderBy: unknown): R[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, "asc" | "desc">>;
  return [...rows].sort((a, b) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0];
      const av = a[k];
      const bv = b[k];
      const an = av instanceof Date ? av.getTime() : (av as string | number);
      const bn = bv instanceof Date ? bv.getTime() : (bv as string | number);
      if (an === bn) continue;
      const cmp = an < bn ? -1 : 1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

function pick(obj: Record<string, unknown>, select: Select): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v !== true) throw new Error(`fake prisma: unsupported select ${k}`);
    if (!(k in obj)) throw new Error(`fake prisma: unknown column ${k}`);
    out[k] = obj[k];
  }
  return out;
}

const userOf = (id: string) => {
  const u = users.find((x) => x.id === id);
  assert.ok(u, `user ${id} がない`);
  return u;
};

function projectLesson(lessonId: string, select: Select): Record<string, unknown> {
  const l = lessons.find((x) => x.id === lessonId);
  assert.ok(l, `lesson ${lessonId} がない`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (k === "section") {
      const course = (v as { select: { course: { select: Select } } }).select.course;
      assert.ok(course, `section の select: ${inspect(v)}`);
      const c = courses.find((x) => x.id === l.courseId);
      assert.ok(c, `course ${l.courseId} がない`);
      out.section = { course: pick(c, course.select) };
      continue;
    }
    out[k] = pick(l, { [k]: v })[k];
  }
  return out;
}

function projectComment(c: CommentRow, select: Select): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (k === "user") {
      out.user = pick(userOf(c.userId), (v as { select: Select }).select);
      continue;
    }
    if (k === "lesson") {
      out.lesson = projectLesson(c.lessonId, (v as { select: Select }).select);
      continue;
    }
    if (k === "replies") {
      const spec = v as { select: Select; orderBy?: unknown; where?: unknown };
      assert.equal(spec.where, undefined, "replies の where は使わない（toQuestionThreadView で絞る）");
      const rows = sortRows(comments.filter((r) => r.parentId === c.id) as unknown as Record<string, unknown>[], spec.orderBy);
      out.replies = (rows as unknown as CommentRow[]).map((r) => projectComment(r, spec.select));
      continue;
    }
    out[k] = pick(c, { [k]: v })[k];
  }
  return out;
}

function record(method: string, args: Record<string, unknown>) {
  calls.push({ method, args, inTx });
  if (failWith !== undefined) throw failWith;
}

function notFound(): Error {
  const err = new Error("No record was found for a delete.");
  err.name = "PrismaClientKnownRequestError";
  Object.assign(err, { code: "P2025" });
  return err;
}

const fakeComment = {
  async findUnique(args: Record<string, unknown>) {
    record("comment.findUnique", args);
    const where = args.where as Record<string, unknown>;
    assert.deepEqual(Object.keys(where), ["id"], `where: ${inspect(where)}`);
    const c = comments.find((x) => x.id === where.id);
    return c ? projectComment(c, args.select as Select) : null;
  },
  async findMany(args: Record<string, unknown>) {
    record("comment.findMany", args);
    const where = args.where as Record<string, unknown>;
    assert.deepEqual(Object.keys(where), ["parentId"], `findMany の where: ${inspect(where)}`);
    const cond = where.parentId as Record<string, unknown>;
    assert.deepEqual(Object.keys(cond), ["in"], `findMany の parentId: ${inspect(cond)}`);
    const parentIds = cond.in as string[];
    assert.ok(Array.isArray(parentIds) && parentIds.length > 0, "parentId の in は空でない配列");
    assert.deepEqual(args.select, { id: true }, "findMany は id だけを読む");
    return comments.filter((c) => c.parentId !== null && parentIds.includes(c.parentId)).map((c) => ({ id: c.id }));
  },
  async deleteMany(args: Record<string, unknown>) {
    record("comment.deleteMany", args);
    const where = args.where as Record<string, unknown>;
    assert.deepEqual(Object.keys(where), ["id"], `deleteMany の where: ${inspect(where)}`);
    const cond = where.id as Record<string, unknown>;
    assert.deepEqual(Object.keys(cond), ["in"], `deleteMany の id: ${inspect(cond)}`);
    const delIds = cond.in as string[];
    assert.ok(Array.isArray(delIds) && delIds.length > 0, "id の in は空でない配列");
    const removed = comments.filter((c) => delIds.includes(c.id)).map((c) => c.id);
    comments = comments.filter((c) => !delIds.includes(c.id));
    // 実物の FK（ON DELETE SET NULL）を再現する（消した行にさらに返信が付いていて、それが残る場合）
    for (const c of comments) if (c.parentId !== null && removed.includes(c.parentId)) c.parentId = null;
    return { count: removed.length };
  },
  async delete(args: Record<string, unknown>) {
    record("comment.delete", args);
    const where = args.where as Record<string, unknown>;
    assert.deepEqual(Object.keys(where), ["id"], `delete の where: ${inspect(where)}`);
    const row = comments.find((c) => c.id === where.id);
    if (!row) throw notFound();
    comments = comments.filter((c) => c.id !== row.id);
    // 実物の FK（ON DELETE SET NULL）を再現する
    for (const c of comments) if (c.parentId === row.id) c.parentId = null;
    return args.select ? pick(row, args.select as Select) : row;
  },
};

const fakeBase = {
  comment: fakeComment,
  async $transaction(fn: unknown) {
    calls.push({ method: "$transaction", args: {}, inTx });
    assert.equal(typeof fn, "function", "$transaction はコールバック形式で呼ぶ");
    inTx = true;
    try {
      return await (fn as (tx: unknown) => Promise<unknown>)(fakePrisma);
    } finally {
      inTx = false;
    }
  },
};

// comment・$transaction 以外（notification など）へのアクセスを記録する
const fakePrisma: typeof fakeBase = new Proxy(fakeBase, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && !(prop in target) && prop !== "then") otherAccess.push(prop);
    return Reflect.get(target, prop, receiver);
  },
});

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ DELETE } = await import("../../src/app/api/admin/comments/[id]/route"));
});

const at = (minutesAgo: number) => new Date(BASE - minutesAgo * 60_000);

beforeEach(() => {
  session = INSTRUCTOR_SESSION;
  calls = [];
  otherAccess = [];
  inTx = false;
  failWith = undefined;
  users = [
    { id: "stu_active", email: DUMMY_EMAIL, name: "受講生エー", role: "STUDENT", avatar: "avatar-a.png", deactivatedAt: null, password: "hash-a" },
    { id: "stu_gone", email: "gone@example.com", name: "受講生ゴーン", role: "STUDENT", avatar: null, deactivatedAt: new Date(BASE - 86_400_000), password: "hash-b" },
    { id: ME, email: "teacher@example.com", name: "講師ビー", role: "INSTRUCTOR", avatar: null, deactivatedAt: null, password: "hash-c" },
    { id: "ins_2", email: "teacher2@example.com", name: "講師シー", role: "INSTRUCTOR", avatar: null, deactivatedAt: null, password: "hash-d" },
  ];
  courses = [{ id: "course_1", name: "STEP1 ダミーコース" }];
  lessons = [
    { id: "lesson_1", title: "ダミーレッスン1", courseId: "course_1" },
    { id: "lesson_2", title: "ダミーレッスン2", courseId: "course_1" },
  ];
  comments = [
    { id: "q_stu", userId: "stu_active", lessonId: "lesson_1", content: "受講生の質問", parentId: null, createdAt: at(300) },
    { id: "r_stu", userId: "stu_active", lessonId: "lesson_1", content: "受講生の追記", parentId: "q_stu", createdAt: at(200) },
    { id: "r_ins", userId: ME, lessonId: "lesson_1", content: "講師の回答", parentId: "q_stu", createdAt: at(150) },
    // #32 より前の POST で作られうる、別レッスンの返信（質問の削除で一緒に消す。応答の thread には含めない）
    { id: "r_other", userId: "ins_2", lessonId: "lesson_2", content: "別レッスンの返信", parentId: "q_stu", createdAt: at(100) },
    { id: "q_gone", userId: "stu_gone", lessonId: "lesson_2", content: "無効化された受講生の質問", parentId: null, createdAt: at(250) },
    { id: "r_gone", userId: ME, lessonId: "lesson_2", content: "無効化された受講生への回答", parentId: "q_gone", createdAt: at(240) },
    { id: "q_alone", userId: "stu_active", lessonId: "lesson_2", content: "返信のない質問", parentId: null, createdAt: at(230) },
  ];
});

const del = (id: string) =>
  DELETE(new Request(`https://nwa-lms.example.com/api/admin/comments/${encodeURIComponent(id)}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });

const delWithParams = (params: unknown) =>
  DELETE(new Request("https://nwa-lms.example.com/api/admin/comments/x", { method: "DELETE" }), {
    params: Promise.resolve(params as { id: string }),
  });

const deletes = () => calls.filter((c) => c.method === "comment.delete" || c.method === "comment.deleteMany");
const ids = () => comments.map((c) => c.id);

function captureLogs() {
  const err = mock.method(console, "error", () => {});
  const info = mock.method(console, "info", () => {});
  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "warn", () => {});
  const text = (m: typeof err) =>
    m.mock.calls.flatMap((c) => c.arguments).map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ");
  return () => {
    const out = { error: text(err), info: text(info), other: `${text(log)} ${text(warn)}`.trim() };
    err.mock.restore();
    info.mock.restore();
    log.mock.restore();
    warn.mock.restore();
    return out;
  };
}

function piiError() {
  const err = new Error(`delete failed for ${DUMMY_EMAIL} (stu_active) 受講生の質問`);
  Object.assign(err, { code: "P2003", meta: { email: DUMMY_EMAIL, userId: "stu_active" } });
  return err;
}

describe("DELETE /api/admin/comments/[id]：認証・権限", () => {
  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    const res = await del("q_stu");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(calls.length, 0, "DB を読まない");
  });

  it("user.id のないセッションも 401", async () => {
    session = { user: { role: "INSTRUCTOR" } };
    assert.equal((await del("q_stu")).status, 401);
    assert.equal(calls.length, 0, "DB を読まない");
  });

  it("受講生は 403 で、DB を読まない（自分の質問でも消せない）", async () => {
    session = STUDENT_SESSION;
    const res = await del("q_stu");
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Forbidden" });
    assert.equal(calls.length, 0, "DB を読まない");
    assert.equal(comments.length, 7, "コメントは減らない");
  });

  for (const [label, role] of [
    ["role なし", undefined],
    ["小文字の instructor", "instructor"],
    ["ADMIN", "ADMIN"],
    ["前後に空白のある INSTRUCTOR", " INSTRUCTOR "],
    ["空文字の role", ""],
  ] as Array<[string, string | undefined]>) {
    it(`${label} は 403 で、DB を読まない`, async () => {
      session = { user: { id: "stu_active", role } };
      const res = await del("q_stu");
      assert.equal(res.status, 403, `role=${JSON.stringify(role)}`);
      assert.equal(calls.length, 0, "DB を読まない");
    });
  }

  it("無効な id でも、未ログインなら 401・受講生なら 403（認証を先に見る）", async () => {
    session = null;
    assert.equal((await del("")).status, 401);
    session = STUDENT_SESSION;
    assert.equal((await del("")).status, 403);
    assert.equal(calls.length, 0, "DB を読まない");
  });
});

describe("DELETE /api/admin/comments/[id]：入力", () => {
  it("id が空なら 400 invalid_id で、DB を読まない", async () => {
    const res = await del("");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_id" });
    assert.equal(calls.length, 0, "DB を読まない");
  });

  it("id が 65 文字なら 400 invalid_id", async () => {
    const res = await del("a".repeat(65));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "invalid_id");
    assert.equal(calls.length, 0, "DB を読まない");
  });

  for (const [label, id] of [
    ["配列", ["q_stu"]],
    ["数値", 1],
    ["undefined", undefined],
    ["null", null],
  ] as Array<[string, unknown]>) {
    it(`params.id が${label}なら 400 invalid_id で、DB を読まない`, async () => {
      const res = await delWithParams({ id });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, "invalid_id");
      assert.equal(calls.length, 0, "DB を読まない");
    });
  }

  it("64 文字ちょうどの id は検証を通り、存在しなければ 404 で、削除もトランザクションもしない", async () => {
    const res = await del("a".repeat(64));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Comment not found" });
    assert.deepEqual(calls.map((c) => c.method), ["comment.findUnique"]);
    assert.deepEqual(calls[0].args, { where: { id: "a".repeat(64) }, select: { id: true, parentId: true } }, "id と parentId だけを読む");
  });

  for (const id of ["q_stu%20", "Q_STU", " q_stu", "q_stu\u0000"]) {
    it(`id ${JSON.stringify(id)} は加工せずに where に渡し、一致しないので 404（何も消さない）`, async () => {
      const res = await del(id);
      assert.equal(res.status, 404);
      assert.equal(deletes().length, 0, "削除しない");
      assert.deepEqual(calls[0].args.where, { id }, "id を加工しない");
      assert.equal(comments.length, 7, "コメントは減らない");
    });
  }

  it("同じ質問を 2 回消すと、2 回目は 404（削除済み）", async () => {
    assert.equal((await del("q_stu")).status, 200);
    calls = [];
    const res = await del("q_stu");
    assert.equal(res.status, 404);
    assert.equal(deletes().length, 0, "2 回目は削除を呼ばない");
  });

  it("質問を消したあと、その返信の id を消そうとすると 404", async () => {
    assert.equal((await del("q_stu")).status, 200);
    assert.equal((await del("r_ins")).status, 404);
  });
});

describe("DELETE /api/admin/comments/[id]：質問の削除", () => {
  it("トランザクション内で子孫を findMany({ parentId: { in } }) で集め、deleteMany({ id: { in } }) してから、質問を delete({ id }) する", async () => {
    const res = await del("q_stu");
    assert.equal(res.status, 200);
    assert.deepEqual(
      calls.map((c) => [c.method, c.inTx]),
      [
        ["comment.findUnique", false],
        ["$transaction", false],
        ["comment.findMany", true],
        ["comment.findMany", true],
        ["comment.deleteMany", true],
        ["comment.delete", true],
      ]
    );
    assert.deepEqual(calls[2].args, { where: { parentId: { in: ["q_stu"] } }, select: { id: true } });
    assert.deepEqual(calls[3].args, { where: { parentId: { in: ["r_stu", "r_ins", "r_other"] } }, select: { id: true } }, "1 段下を問い合わせる");
    assert.deepEqual(calls[4].args, { where: { id: { in: ["r_stu", "r_ins", "r_other"] } } });
    assert.deepEqual((calls[5].args as { where: unknown }).where, { id: "q_stu" });
  });

  it("子孫の findMany・deleteMany の where に lessonId を入れない（別レッスンの lessonId を持つ古い返信も消す）", async () => {
    await del("q_stu");
    const dm = calls.find((c) => c.method === "comment.deleteMany");
    assert.ok(dm, "deleteMany を呼ぶ");
    const finds = calls.filter((c) => c.method === "comment.findMany");
    assert.ok(finds.length > 0, "findMany で子孫を集める");
    for (const c of [dm, ...finds]) {
      const where = c.args.where as Record<string, unknown>;
      assert.equal("lessonId" in where, false, `${c.method} の where: ${inspect(where)}`);
    }
    assert.equal(ids().includes("r_other"), false, "別レッスンの返信も消える");
  });

  it("質問と返信 3 件（別レッスンの返信を含む）が消え、ほかのスレッドは残る。返信が質問として残らない", async () => {
    const res = await del("q_stu");
    assert.deepEqual(await res.json(), { kind: "question", id: "q_stu", deletedReplies: 3 });
    assert.deepEqual(ids(), ["q_gone", "r_gone", "q_alone"]);
    assert.ok(
      comments.every((c) => c.parentId === null ? c.id.startsWith("q_") : true),
      "返信が parentId: null（質問）になっていない"
    );
  });

  it("返信のない質問は deletedReplies: 0", async () => {
    const res = await del("q_alone");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { kind: "question", id: "q_alone", deletedReplies: 0 });
    assert.equal(ids().includes("q_alone"), false, "質問が消える");
  });

  it("無効化された受講生の質問も消せる", async () => {
    const res = await del("q_gone");
    assert.deepEqual(await res.json(), { kind: "question", id: "q_gone", deletedReplies: 1 });
    assert.equal(ids().some((id) => id === "q_gone" || id === "r_gone"), false, "質問と回答が消える");
  });

  it("応答は kind・id・deletedReplies だけ（本文・名前・ユーザー ID を含めない）", async () => {
    const text = await (await del("q_stu")).text();
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["deletedReplies", "id", "kind"]);
    for (const s of ["受講生の質問", "受講生エー", "stu_active", "example.com", "lesson_1"]) {
      assert.ok(!text.includes(s), `応答に「${s}」を含めない`);
    }
  });

  it("トランザクションは 1 回だけで、スレッドの読み直しはしない", async () => {
    await del("q_stu");
    assert.equal(calls.filter((c) => c.method === "$transaction").length, 1, "トランザクションは 1 回");
    assert.equal(calls.filter((c) => c.method === "comment.findUnique").length, 1, "読むのは最初の 1 回だけ");
  });
});

describe("DELETE /api/admin/comments/[id]：返信の削除", () => {
  it("子孫のない返信は、トランザクション内で子を 1 回確かめてから、その 1 件だけを delete し、deleteMany は呼ばない", async () => {
    const res = await del("r_stu");
    assert.equal(res.status, 200);
    assert.deepEqual(
      calls.map((c) => [c.method, c.inTx]),
      [
        ["comment.findUnique", false],
        ["$transaction", false],
        ["comment.findMany", true],
        ["comment.delete", true],
        ["comment.findUnique", true],
        ["comment.findUnique", true],
      ]
    );
    assert.deepEqual(calls[2].args, { where: { parentId: { in: ["r_stu"] } }, select: { id: true } });
    assert.deepEqual((calls[3].args as { where: unknown }).where, { id: "r_stu" });
    assert.deepEqual(calls[4].args, { where: { id: "q_stu" }, select: { parentId: true } }, "親の parentId だけを読んで、根の質問か確かめる");
    assert.deepEqual(ids(), ["q_stu", "r_ins", "r_other", "q_gone", "r_gone", "q_alone"], "r_stu だけが消える");
  });

  it("読み直しは根の質問（直下の返信なら親）の id で、GET /api/comments と同じ select", async () => {
    await del("r_stu");
    const reread = calls.filter((c) => c.method === "comment.findUnique")[2];
    assert.ok(reread, "親を読み直す");
    assert.equal(reread.inTx, true, "読み直しは削除と同じトランザクションの中");
    assert.deepEqual(reread.args.where, { id: "q_stu" });
    const base = { id: true, content: true, createdAt: true, userId: true, user: { select: { name: true, role: true, deactivatedAt: true } } };
    assert.deepEqual(reread.args.select, {
      ...base,
      lesson: { select: { id: true, title: true, section: { select: { course: { select: { id: true, name: true } } } } } },
      replies: { select: { ...base, lessonId: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    });
  });

  it("200 { kind: \"reply\", id, thread }：削除後のスレッド（同じレッスンの返信だけ、古い順）", async () => {
    const body = await (await del("r_stu")).json();
    assert.deepEqual(Object.keys(body).sort(), ["id", "kind", "thread"]);
    assert.equal(body.kind, "reply");
    assert.equal(body.id, "r_stu");
    const t = body.thread;
    assert.equal(t.id, "q_stu");
    assert.equal(t.content, "受講生の質問");
    assert.deepEqual(t.author, { name: "受講生エー", isInstructor: false });
    assert.equal(t.mine, false);
    assert.equal(t.answered, true, "講師の回答が残っているので回答済み");
    assert.equal(t.replyCount, 1);
    assert.deepEqual(t.lesson, { id: "lesson_1", title: "ダミーレッスン1" });
    assert.deepEqual(t.course, { id: "course_1", name: "STEP1 ダミーコース" });
    assert.deepEqual(
      t.replies.map((r: { content: string; author: unknown; mine: boolean }) => [r.content, r.author, r.mine]),
      [["講師の回答", { name: "講師ビー", isInstructor: true }, true]]
    );
  });

  it("講師の回答を消すと answered: false に戻る", async () => {
    const t = (await (await del("r_ins")).json()).thread;
    assert.equal(t.answered, false);
    assert.equal(t.replyCount, 1);
    assert.equal(t.lastReplyAt, at(200).toISOString());
  });

  it("最後の返信を消すと replyCount: 0・lastReplyAt: null・answered: false", async () => {
    const t = (await (await del("r_gone")).json()).thread;
    assert.deepEqual([t.replyCount, t.lastReplyAt, t.answered, t.replies.length], [0, null, false, 0]);
    assert.deepEqual(t.author, { name: null, isInstructor: false }, "無効化された受講生は匿名のまま");
    assert.equal(ids().includes("q_gone"), true, "親の質問は残る");
  });

  it("別レッスンの lessonId を持つ古い返信も id 指定で消せ、応答の thread には出さない", async () => {
    const res = await del("r_other");
    assert.equal(res.status, 200);
    assert.equal(ids().includes("r_other"), false, "消える");
    const text = await res.text();
    assert.ok(!text.includes("別レッスンの返信"), "応答に別レッスンの返信を出さない");
  });

  it("応答に userId・email・avatar・role・deactivatedAt・ユーザー ID・lessonId を含めない", async () => {
    const text = await (await del("r_stu")).text();
    const t = JSON.parse(text).thread;
    assert.deepEqual(Object.keys(t).sort(), ["answered", "author", "content", "course", "createdAt", "id", "lastReplyAt", "lesson", "mine", "replies", "replyCount"]);
    for (const r of t.replies) assert.deepEqual(Object.keys(r).sort(), ["author", "content", "createdAt", "id", "mine"]);
    for (const k of ["userId", "email", "avatar", "role", "deactivatedAt", "password", "hash-", "example\\.com", "stu_active", "stu_gone", "ins_1", "ins_2", "INSTRUCTOR", "STUDENT", "lessonId", "受講生の追記"]) {
      assert.doesNotMatch(text, new RegExp(k), k);
    }
  });

  it("別の講師が消しても mine はその講師から見た値（自分の回答ではないので false）", async () => {
    session = { user: { id: "ins_2", role: "INSTRUCTOR" } };
    const t = (await (await del("r_stu")).json()).thread;
    assert.deepEqual(t.replies.map((r: { mine: boolean }) => r.mine), [false]);
  });
});

describe("DELETE /api/admin/comments/[id]：通知とほかのテーブル", () => {
  for (const id of ["q_stu", "r_ins", "q_alone"]) {
    it(`${id} を消しても、通知など comment 以外のテーブルに触れない`, async () => {
      const res = await del(id);
      assert.equal(res.status, 200);
      assert.deepEqual(otherAccess, [], `comment・$transaction 以外へのアクセス: ${inspect(otherAccess)}`);
      assert.ok(calls.every((c) => c.method === "$transaction" || c.method.startsWith("comment.")), "comment だけを使う");
    });
  }
});

describe("DELETE /api/admin/comments/[id]：ログ", () => {
  it("質問を消したら固定文「[admin] question deleted」だけを info に出す", async () => {
    const done = captureLogs();
    const res = await del("q_stu");
    const out = done();
    assert.equal(res.status, 200);
    assert.equal(out.info, "[admin] question deleted");
    assert.equal(out.error, "", "error は出さない");
    assert.equal(out.other, "", "log / warn は出さない");
  });

  it("返信を消したら固定文「[admin] reply deleted」だけを info に出す", async () => {
    const done = captureLogs();
    const res = await del("r_ins");
    const out = done();
    assert.equal(res.status, 200);
    assert.equal(out.info, "[admin] reply deleted");
    assert.equal(out.error, "", "error は出さない");
  });

  for (const [label, run] of [
    ["401", () => { session = null; return del("q_stu"); }],
    ["403", () => { session = STUDENT_SESSION; return del("q_stu"); }],
    ["400", () => del("")],
    ["404", () => del("q_missing")],
  ] as Array<[string, () => Promise<Response>]>) {
    it(`${label} のときは成功のログを出さない`, async () => {
      const done = captureLogs();
      await run();
      const out = done();
      assert.equal(out.info, "", "info を出さない");
    });
  }
});

describe("DELETE /api/admin/comments/[id]：エラー", () => {
  it("最初の読み込みで失敗したら 500・汎用本文で、トランザクションを始めない。ログはルート名とエラー名だけ", async () => {
    failWith = piiError();
    const done = captureLogs();
    const res = await del("q_stu");
    const out = done();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.equal(calls.some((c) => c.method === "$transaction"), false, "トランザクションを始めない");
    assert.equal(out.error, "DELETE /api/admin/comments/[id] error: Error");
    assert.equal(out.info, "", "成功のログを出さない");
    for (const s of ["example.com", "stu_active", "delete failed", "P2003", "受講生の質問", "q_stu"]) {
      assert.ok(!out.error.includes(s), `ログに「${s}」を出さない`);
    }
  });

  it("質問の delete が失敗したら 500（子孫の deleteMany のあと、同じトランザクションの中で失敗する）", async () => {
    const m = mock.method(fakeComment, "delete", async (args: Record<string, unknown>) => {
      calls.push({ method: "comment.delete", args, inTx });
      throw piiError();
    });
    let callbackRejected = false;
    const origTx = fakeBase.$transaction;
    const tx = mock.method(fakeBase, "$transaction", async (fn: unknown) => {
      try {
        return await origTx.call(fakeBase, fn);
      } catch (e) {
        callbackRejected = true;
        throw e;
      }
    });
    const done = captureLogs();
    try {
      const res = await del("q_stu");
      const out = done();
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.equal(callbackRejected, true, "コールバックが例外で終わる（実物なら返信の削除もロールバックされる）");
      assert.deepEqual(
        calls.filter((c) => c.method !== "$transaction").map((c) => [c.method, c.inTx]),
        [["comment.findUnique", false], ["comment.findMany", true], ["comment.findMany", true], ["comment.deleteMany", true], ["comment.delete", true]]
      );
      assert.equal(out.error, "DELETE /api/admin/comments/[id] error: Error");
      assert.equal(out.info, "", "成功のログを出さない");
    } finally {
      tx.mock.restore();
      m.mock.restore();
    }
  });

  it("返信の削除後に親を読み直せなければ、トランザクションの中で例外を投げて 500（ログはエラー名だけ）", async () => {
    const origFind = fakeComment.findUnique;
    let n = 0;
    const find = mock.method(fakeComment, "findUnique", async (args: Record<string, unknown>) => {
      n += 1;
      if (n === 1) return origFind.call(fakeComment, args);
      record("comment.findUnique", args);
      return null;
    });
    let callbackRejected = false;
    const origTx = fakeBase.$transaction;
    const tx = mock.method(fakeBase, "$transaction", async (fn: unknown) => {
      try {
        return await origTx.call(fakeBase, fn);
      } catch (e) {
        callbackRejected = true;
        throw e;
      }
    });
    const done = captureLogs();
    try {
      const res = await del("r_stu");
      const out = done();
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.equal(callbackRejected, true, "コールバックが例外で終わる（実物なら返信の削除はロールバックされる）");
      const reread = calls.filter((c) => c.method === "comment.findUnique")[1];
      assert.ok(reread && reread.inTx, "読み直しはトランザクションの中");
      assert.equal(out.error, "DELETE /api/admin/comments/[id] error: Error");
      assert.equal(out.info, "", "成功のログを出さない");
      for (const s of ["r_stu", "q_stu", "受講生の追記"]) assert.ok(!out.error.includes(s), `ログに「${s}」を出さない`);
    } finally {
      tx.mock.restore();
      find.mock.restore();
    }
  });

  /** 最初の findUnique の直後に、別の講師が removeIds を消したことにする */
  function deletedRightAfterRead(removeIds: string[]) {
    const origFind = fakeComment.findUnique;
    let n = 0;
    return mock.method(fakeComment, "findUnique", async (args: Record<string, unknown>) => {
      n += 1;
      const row = await origFind.call(fakeComment, args);
      if (n === 1) comments = comments.filter((c) => !removeIds.includes(c.id));
      return row;
    });
  }

  it("確認と削除の間に返信が消された（delete が P2025）場合は 404 Comment not found で、ログを出さない", async () => {
    const find = deletedRightAfterRead(["r_stu"]);
    const done = captureLogs();
    try {
      const res = await del("r_stu");
      const out = done();
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "Comment not found" });
      assert.deepEqual(
        calls.filter((c) => c.method !== "$transaction").map((c) => [c.method, c.inTx]),
        [["comment.findUnique", false], ["comment.findMany", true], ["comment.delete", true]],
        "delete で失敗し、親の読み直しまで進まない"
      );
      assert.deepEqual(out, { error: "", info: "", other: "" }, "成功のログもエラーのログも出さない");
    } finally {
      find.mock.restore();
    }
    assert.equal((await del("r_stu")).status, 404, "再試行しても 404");
  });

  it("確認と削除の間に質問ごと消された（子孫は 0 件で deleteMany を呼ばず、delete が P2025）場合は 404 で、ログを出さない", async () => {
    const find = deletedRightAfterRead(["q_stu", "r_stu", "r_ins", "r_other"]);
    const done = captureLogs();
    try {
      const res = await del("q_stu");
      const out = done();
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "Comment not found" });
      assert.deepEqual(
        calls.filter((c) => c.method !== "$transaction").map((c) => [c.method, c.inTx]),
        [["comment.findUnique", false], ["comment.findMany", true], ["comment.delete", true]]
      );
      assert.deepEqual(out, { error: "", info: "", other: "" }, "成功のログもエラーのログも出さない");
      assert.deepEqual(ids(), ["q_gone", "r_gone", "q_alone"], "ほかのスレッドは残る");
    } finally {
      find.mock.restore();
    }
  });

  it("P2025 以外の Prisma のエラー（P2003）は 404 にせず 500", async () => {
    const m = mock.method(fakeComment, "delete", async (args: Record<string, unknown>) => {
      calls.push({ method: "comment.delete", args, inTx });
      throw piiError();
    });
    const done = captureLogs();
    try {
      const res = await del("r_stu");
      const out = done();
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.equal(out.error, "DELETE /api/admin/comments/[id] error: Error");
    } finally {
      m.mock.restore();
    }
  });

  it("親の読み直しの失敗（code なしの Error）は 404 にせず 500 のまま", async () => {
    // 読み直しの失敗は route 内で code なしの Error を投げる。P2025 の 404 と混ざらないことを確かめる
    const origFind = fakeComment.findUnique;
    let n = 0;
    const find = mock.method(fakeComment, "findUnique", async (args: Record<string, unknown>) => {
      n += 1;
      if (n === 1) return origFind.call(fakeComment, args);
      record("comment.findUnique", args);
      return null;
    });
    const done = captureLogs();
    try {
      const res = await del("r_stu");
      done();
      assert.equal(res.status, 500);
    } finally {
      find.mock.restore();
    }
  });

  it("$transaction 自体が失敗しても 500、応答とログに本文・メールを出さない", async () => {
    const m = mock.method(fakeBase, "$transaction", async () => {
      const err = new Error(`Transaction failed: 受講生の質問 ${DUMMY_EMAIL}`);
      err.name = "PrismaClientKnownRequestError";
      Object.assign(err, { code: "P2034" });
      throw err;
    });
    const done = captureLogs();
    try {
      const res = await del("q_stu");
      const out = done();
      assert.equal(res.status, 500);
      assert.equal(await res.text(), JSON.stringify({ error: "Internal server error" }));
      assert.equal(out.error, "DELETE /api/admin/comments/[id] error: PrismaClientKnownRequestError");
    } finally {
      m.mock.restore();
    }
  });

  it("Error でない値（メールを含む文字列）が投げられてもログは型名だけ", async () => {
    const m = mock.method(fakeBase, "$transaction", async () => {
      throw `failed for ${DUMMY_EMAIL}`;
    });
    const done = captureLogs();
    try {
      const res = await del("q_stu");
      const out = done();
      assert.equal(res.status, 500);
      assert.equal(out.error, "DELETE /api/admin/comments/[id] error: string");
    } finally {
      m.mock.restore();
    }
  });
});

// ───────────── tester による追加（#47 P1） ─────────────

const snapshot = (pred: (c: CommentRow) => boolean) =>
  comments.filter(pred).map((c) => ({ ...c, createdAt: c.createdAt.toISOString() }));

describe("DELETE /api/admin/comments/[id]：ほかのスレッドへの影響（追加）", () => {
  it("質問を消しても、ほかのスレッドの行（parentId・本文・lessonId）は 1 か所も変わらない", async () => {
    const other = (c: CommentRow) => !["q_stu", "r_stu", "r_ins", "r_other"].includes(c.id);
    const before = snapshot(other);
    assert.equal((await del("q_stu")).status, 200);
    assert.deepEqual(snapshot(other), before, "q_gone・r_gone・q_alone は変わらない");
  });

  it("返信を消しても、同じスレッドのほかの返信とほかのスレッドは変わらない", async () => {
    const other = (c: CommentRow) => c.id !== "r_ins";
    const before = snapshot(other);
    assert.equal((await del("r_ins")).status, 200);
    assert.deepEqual(snapshot(other), before, "r_ins 以外は変わらない");
  });

  it("質問を消したあと、parentId が null の行は元からの質問だけ", async () => {
    await del("q_stu");
    assert.deepEqual(
      comments.filter((c) => c.parentId === null).map((c) => c.id),
      ["q_gone", "q_alone"],
      "返信が質問として浮き上がらない"
    );
  });
});

describe("DELETE /api/admin/comments/[id]：返信の削除後のスレッド（追加）", () => {
  for (const id of ["r_stu", "r_ins"]) {
    it(`${id} を消した応答に、別レッスンの返信（本文・投稿者）は含まれず、replyCount にも数えない`, async () => {
      const res = await del(id);
      assert.equal(res.status, 200);
      const text = await res.text();
      for (const s of ["別レッスンの返信", "講師シー", "lesson_2", "ダミーレッスン2", "r_other"]) {
        assert.ok(!text.includes(s), `応答に「${s}」を含めない`);
      }
      const t = JSON.parse(text).thread;
      assert.equal(t.replyCount, 1, "同じレッスンの返信 1 件だけを数える");
      assert.equal(t.replies.length, 1, "replies も 1 件");
    });
  }

  it("講師の回答を消すと、別レッスンにある別の講師の返信が残っていても answered: false", async () => {
    const t = (await (await del("r_ins")).json()).thread;
    assert.equal(t.answered, false, "別レッスンの講師の返信 r_other では回答済みにしない");
    assert.equal(ids().includes("r_other"), true, "r_other は消さない");
  });

  it("無効化済みの受講生の返信が残るスレッドで別の返信を消しても、その受講生は匿名のまま", async () => {
    comments.push({ id: "r_gone_stu", userId: "stu_gone", lessonId: "lesson_1", content: "無効化された受講生の追記", parentId: "q_stu", createdAt: at(120) });
    const res = await del("r_stu");
    assert.equal(res.status, 200);
    const text = await res.text();
    const t = JSON.parse(text).thread;
    const gone = t.replies.find((r: { content: string }) => r.content === "無効化された受講生の追記");
    assert.ok(gone, "無効化済みの受講生の返信は残る");
    assert.deepEqual(gone.author, { name: null, isInstructor: false }, "名前を出さない");
    assert.ok(!text.includes("受講生ゴーン"), "応答に無効化済みの受講生の名前を含めない");
    assert.ok(!text.includes("gone@example.com"), "応答にメールを含めない");
  });

  it("無効化済みの受講生の質問で講師の回答を消すと answered: false・匿名のまま、名前・メールを出さない", async () => {
    const text = await (await del("r_gone")).text();
    const t = JSON.parse(text).thread;
    assert.equal(t.answered, false);
    assert.deepEqual(t.author, { name: null, isInstructor: false });
    for (const s of ["受講生ゴーン", "gone@example.com", "stu_gone", "deactivatedAt"]) {
      assert.ok(!text.includes(s), `応答に「${s}」を含めない`);
    }
  });

  it("受講生の古い返信を消した講師から見て、残った自分の回答は mine: true・質問は mine: false", async () => {
    const t = (await (await del("r_stu")).json()).thread;
    assert.equal(t.mine, false);
    assert.deepEqual(t.replies.map((r: { mine: boolean }) => r.mine), [true]);
  });
});

describe("DELETE /api/admin/comments/[id]：入力の境界（追加）", () => {
  it("body と query の id は使わない（パスの id だけを消す）。body を読まない", async () => {
    const req = new Request("https://nwa-lms.example.com/api/admin/comments/r_stu?id=q_gone", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "q_gone", parentId: "q_gone" }),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "r_stu" }) });
    assert.equal(res.status, 200);
    assert.equal(req.bodyUsed, false, "body を読まない");
    assert.deepEqual(ids(), ["q_stu", "r_ins", "r_other", "q_gone", "r_gone", "q_alone"], "r_stu だけが消える");
  });

  for (const [label, id, status] of [
    ["空白だけ", "   ", 404],
    ["64 文字の全角", "あ".repeat(64), 404],
    ["65 文字の全角", "あ".repeat(65), 400],
    ["32 個の絵文字（UTF-16 で 64）", "\u{1F600}".repeat(32), 404],
    ["33 個の絵文字（UTF-16 で 66）", "\u{1F600}".repeat(33), 400],
    ["パーセントエンコードのまま（%71 は q）", "%71_stu", 404],
    ["先頭にゼロ幅スペース", "\u200Bq_stu", 404],
    ["末尾に改行", "q_stu\n", 404],
  ] as Array<[string, string, number]>) {
    it(`id が${label}なら ${status}（何も消さない）`, async () => {
      const res = await del(id);
      assert.equal(res.status, status, `id=${JSON.stringify(id)}`);
      if (status === 400) {
        assert.equal((await res.json()).reason, "invalid_id");
        assert.equal(calls.length, 0, "DB を読まない");
      } else {
        assert.deepEqual(calls.map((c) => c.method), ["comment.findUnique"], "読むだけ");
        assert.deepEqual(calls[0].args.where, { id }, "id を加工しない");
      }
      assert.equal(comments.length, 7, "コメントは減らない");
    });
  }

  it("params がオブジェクト（{ id: { not: \"\" } }）でも 400 で、where に渡さない", async () => {
    const res = await delWithParams({ id: { not: "" } });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0, "DB を読まない");
  });

  it("403 の受講生が他人の質問・返信を指定しても DB を読まない（存在の有無も漏らさない）", async () => {
    session = STUDENT_SESSION;
    const a = await del("q_gone");
    const b = await del("q_missing");
    assert.deepEqual([a.status, b.status], [403, 403]);
    assert.deepEqual(await a.json(), await b.json(), "存在する id と存在しない id で応答が同じ");
    assert.equal(calls.length, 0, "DB を読まない");
  });
});

describe("DELETE /api/admin/comments/[id]：エラーとログ（追加）", () => {
  it("最初の findUnique が P2025 を投げても 404 で、ログを出さない", async () => {
    const m = mock.method(fakeComment, "findUnique", async (args: Record<string, unknown>) => {
      calls.push({ method: "comment.findUnique", args, inTx });
      throw notFound();
    });
    const done = captureLogs();
    try {
      const res = await del("q_stu");
      const out = done();
      assert.equal(res.status, 404);
      assert.deepEqual(out, { error: "", info: "", other: "" }, "ログを出さない");
      assert.equal(calls.some((c) => c.method === "$transaction"), false, "トランザクションを始めない");
    } finally {
      m.mock.restore();
    }
  });

  it("質問の deleteMany が P2003（PrismaClientKnownRequestError）なら 500。ログはルート名とエラー名だけで、code・本文を出さない", async () => {
    const m = mock.method(fakeComment, "deleteMany", async (args: Record<string, unknown>) => {
      calls.push({ method: "comment.deleteMany", args, inTx });
      const err = new Error(`Foreign key constraint failed: ${DUMMY_EMAIL} 受講生の質問`);
      err.name = "PrismaClientKnownRequestError";
      Object.assign(err, { code: "P2003", meta: { field_name: "Comment_parentId_fkey" } });
      throw err;
    });
    const err = mock.method(console, "error", () => {});
    const info = mock.method(console, "info", () => {});
    try {
      const res = await del("q_stu");
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.equal(err.mock.callCount(), 1, "console.error は 1 回");
      assert.deepEqual(err.mock.calls[0].arguments, ["DELETE /api/admin/comments/[id] error:", "PrismaClientKnownRequestError"]);
      assert.equal(info.mock.callCount(), 0, "成功のログを出さない");
      assert.equal(calls.some((c) => c.method === "comment.delete"), false, "質問の delete まで進まない");
    } finally {
      err.mock.restore();
      info.mock.restore();
      m.mock.restore();
    }
  });

  it("P2034（書き込みの競合）は 404 にせず 500", async () => {
    const m = mock.method(fakeComment, "delete", async (args: Record<string, unknown>) => {
      calls.push({ method: "comment.delete", args, inTx });
      const e = new Error("Transaction failed due to a write conflict");
      e.name = "PrismaClientKnownRequestError";
      Object.assign(e, { code: "P2034" });
      throw e;
    });
    const done = captureLogs();
    try {
      const res = await del("r_stu");
      const out = done();
      assert.equal(res.status, 500);
      assert.equal(out.error, "DELETE /api/admin/comments/[id] error: PrismaClientKnownRequestError");
      assert.equal(out.info, "", "成功のログを出さない");
    } finally {
      m.mock.restore();
    }
  });

  for (const [label, value, name] of [
    ["null", null, "object"],
    ["undefined", undefined, "undefined"],
    ["数値", 42, "number"],
    ["code が P2003 のただのオブジェクト", { code: "P2003", message: `x ${DUMMY_EMAIL}` }, "object"],
  ] as Array<[string, unknown, string]>) {
    it(`Error でない値（${label}）が投げられても 500 で、ログは型名だけ`, async () => {
      const m = mock.method(fakeBase, "$transaction", async () => {
        throw value;
      });
      const done = captureLogs();
      try {
        const res = await del("q_stu");
        const out = done();
        assert.equal(res.status, 500);
        assert.equal(out.error, `DELETE /api/admin/comments/[id] error: ${name}`);
        assert.ok(!out.error.includes("example.com"), "ログにメールを出さない");
      } finally {
        m.mock.restore();
      }
    });
  }

  it("500 の応答本文は固定で、エラーの本文・code を含めない", async () => {
    failWith = piiError();
    const done = captureLogs();
    const text = await (await del("r_stu")).text();
    done();
    assert.equal(text, JSON.stringify({ error: "Internal server error" }));
  });
});

// 返信への返信（#32 より前の POST /api/comments は parentId を検証していなかったので、本番に存在しうる）。
// 実物の FK は ON DELETE SET NULL なので、中間の返信だけを消すと孫の返信が parentId: null（質問）として残る。
// 削除 API は子孫を parentId の in で 1 段ずつ集め、先に消す（深さの上限 MAX_REPLY_DEPTH = 10、循環でも止まる）。
describe("DELETE /api/admin/comments/[id]：返信への返信（孫）がある場合", () => {
  const addNested = () =>
    comments.push({ id: "r_nested", userId: "stu_active", lessonId: "lesson_1", content: "返信への返信", parentId: "r_stu", createdAt: at(180) });

  it("質問を消すと、孫の返信も消え、質問として残らない", async () => {
    addNested();
    const res = await del("q_stu");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { kind: "question", id: "q_stu", deletedReplies: 4 }, "deletedReplies は子孫の総数");
    assert.equal(ids().includes("r_nested"), false, "孫の返信も消える");
    assert.deepEqual(comments.filter((c) => c.parentId === null).map((c) => c.id), ["q_gone", "q_alone"], "質問として浮き上がらない");
    const dm = calls.find((c) => c.method === "comment.deleteMany");
    assert.ok(dm && dm.inTx, "子孫の deleteMany はトランザクションの中");
    assert.deepEqual(dm.args.where, { id: { in: ["r_stu", "r_ins", "r_other", "r_nested"] } }, "子と孫をまとめて消す");
    const order = calls.map((c) => c.method);
    assert.ok(order.indexOf("comment.deleteMany") < order.indexOf("comment.delete"), "子孫を消してから質問を消す");
  });

  it("子を持つ返信を消しても、その子が質問として残らない（子も消え、ほかの返信は残る）", async () => {
    addNested();
    const res = await del("r_stu");
    assert.equal(res.status, 200);
    assert.ok(
      !comments.some((c) => c.id === "r_nested" && c.parentId === null),
      "r_nested が質問（parentId: null）になっていない"
    );
    assert.deepEqual(ids(), ["q_stu", "r_ins", "r_other", "q_gone", "r_gone", "q_alone"], "r_stu と r_nested だけが消える");
    const dm = calls.find((c) => c.method === "comment.deleteMany");
    assert.ok(dm && dm.inTx, "子孫の deleteMany はトランザクションの中");
    assert.deepEqual(dm.args.where, { id: { in: ["r_nested"] } });
    const order = calls.map((c) => c.method);
    assert.ok(order.indexOf("comment.deleteMany") < order.indexOf("comment.delete"), "子孫を消してから返信を消す");
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["id", "kind", "thread"], "返信の応答の形は今までどおり");
    assert.deepEqual(body.thread.replies.map((r: { id: string }) => r.id), ["r_ins"], "スレッドは削除後の直下の返信");
  });
});

describe("DELETE /api/admin/comments/[id]：子孫の深さの上限・循環", () => {
  /** parentId から順に、depth 段の返信の鎖を作る（id は `${prefix}1`…） */
  function addChain(parentId: string, depth: number, prefix = "deep_") {
    let parent = parentId;
    for (let i = 1; i <= depth; i++) {
      const id = `${prefix}${i}`;
      comments.push({ id, userId: "stu_active", lessonId: "lesson_1", content: `深さ ${i} の返信`, parentId: parent, createdAt: at(100 - i) });
      parent = id;
    }
  }

  it("質問の下に 10 段（上限ちょうど）の返信があれば、すべて消して 200", async () => {
    addChain("q_alone", 10);
    const res = await del("q_alone");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { kind: "question", id: "q_alone", deletedReplies: 10 });
    assert.equal(ids().some((id) => id.startsWith("deep_") || id === "q_alone"), false, "鎖と質問がすべて消える");
    assert.equal(calls.filter((c) => c.method === "comment.findMany").length, 11, "10 段 + 子がないことの確認 1 回");
  });

  it("質問の下に 11 段の返信があれば 500 で、何も消さない（ログはルート名とエラー名だけ）", async () => {
    addChain("q_alone", 11);
    const before = ids();
    const done = captureLogs();
    const res = await del("q_alone");
    const out = done();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.equal(deletes().length, 0, "deleteMany・delete を呼ばない（実物でもトランザクションはロールバックされる）");
    assert.deepEqual(ids(), before, "コメントは減らない");
    assert.ok(calls.filter((c) => c.method === "comment.findMany").every((c) => c.inTx), "子孫の収集はトランザクションの中");
    assert.equal(out.error, "DELETE /api/admin/comments/[id] error: ReplyTreeTooDeepError");
    assert.equal(out.info, "", "成功のログを出さない");
    assert.ok(!out.error.includes("deep_") && !out.error.includes("q_alone"), "ログに id を出さない");
  });

  it("返信の下に 10 段の返信があれば、返信と子孫を消して 200", async () => {
    addChain("r_stu", 10);
    const res = await del("r_stu");
    assert.equal(res.status, 200);
    assert.equal(ids().some((id) => id.startsWith("deep_") || id === "r_stu"), false, "鎖と返信がすべて消える");
    assert.equal(comments.filter((c) => c.parentId === null).length, 3, "質問として浮き上がる行がない");
  });

  it("返信の下に 11 段の返信があれば 500 で、何も消さない", async () => {
    addChain("r_stu", 11);
    const before = ids();
    const done = captureLogs();
    const res = await del("r_stu");
    const out = done();
    assert.equal(res.status, 500);
    assert.equal(deletes().length, 0, "deleteMany・delete を呼ばない");
    assert.deepEqual(ids(), before, "コメントは減らない");
    assert.equal(out.error, "DELETE /api/admin/comments/[id] error: ReplyTreeTooDeepError");
  });

  it("枝分かれした子孫も、段ごとにまとめて集める（深さで数え、件数では数えない）", async () => {
    for (let i = 0; i < 15; i++) {
      comments.push({ id: `wide_${i}`, userId: "stu_active", lessonId: "lesson_1", content: "横に並ぶ返信", parentId: "q_alone", createdAt: at(50 - i) });
    }
    const res = await del("q_alone");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { kind: "question", id: "q_alone", deletedReplies: 15 });
    assert.equal(calls.filter((c) => c.method === "comment.findMany").length, 2, "1 段目と、子がないことの確認だけ");
  });

  it("parentId が互いを指す返信（循環）を消しても止まり、500 で終わる（親を読み直せない）", async () => {
    comments.push(
      { id: "cyc_a", userId: "stu_active", lessonId: "lesson_1", content: "循環 A", parentId: "cyc_b", createdAt: at(40) },
      { id: "cyc_b", userId: "stu_active", lessonId: "lesson_1", content: "循環 B", parentId: "cyc_a", createdAt: at(39) }
    );
    const done = captureLogs();
    const res = await del("cyc_a");
    const out = done();
    assert.equal(res.status, 500);
    assert.equal(calls.filter((c) => c.method === "comment.findMany").length, 2, "一度見た id で止まる");
    const dm = calls.find((c) => c.method === "comment.deleteMany");
    assert.ok(dm, "子孫を消そうとする");
    assert.deepEqual(dm.args.where, { id: { in: ["cyc_b"] } }, "対象自身は子孫に数えない");
    assert.equal(out.error, "DELETE /api/admin/comments/[id] error: Error");
    assert.ok(!out.error.includes("cyc_"), "ログに id を出さない");
  });

  it("自分自身を親に持つ返信（自己参照）を消しても止まる", async () => {
    comments.push({ id: "self", userId: "stu_active", lessonId: "lesson_1", content: "自己参照", parentId: "self", createdAt: at(30) });
    const done = captureLogs();
    const res = await del("self");
    done();
    assert.equal(res.status, 500, "親（自分）を読み直せないので 500");
    assert.equal(calls.filter((c) => c.method === "comment.findMany").length, 1, "1 回で止まる");
    assert.equal(calls.some((c) => c.method === "comment.deleteMany"), false, "子孫はない");
  });
});
