import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #32 A-1 POST /api/admin/comments/[id]/replies（講師の回答）。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数と「トランザクションの中か」を記録し、このルートが使う findUnique の where { id }・
// 入れ子の select（user / lesson.section.course / replies と orderBy）・create だけを再現する。知らない select は例外）。
// 偽の $transaction はコールバックを同じ偽物で呼ぶだけで、失敗時のロールバック（原子性）は再現しない。
// NextAuth は installFakeAuth で差し替える。データはすべてダミー（example.com）。

type Role = "STUDENT" | "INSTRUCTOR";
type UserRow = { id: string; email: string; name: string; role: Role; avatar: string | null; deactivatedAt: Date | null; password: string };
type CommentRow = { id: string; userId: string; lessonId: string; content: string; parentId: string | null; createdAt: Date };
type LessonRow = { id: string; title: string; courseId: string };
type CourseRow = { id: string; name: string };
type NotificationRow = { id: string; userId: string; title: string; message: string; read: boolean };
type Call = { method: string; args: Record<string, unknown>; inTx: boolean };
type Select = Record<string, unknown>;

const ME = "ins_1";
const DUMMY_EMAIL = "student@example.com";
const BASE = Date.parse("2026-10-09T12:00:00.000Z");

let session: FakeSession;
let calls: Call[];
let users: UserRow[];
let courses: CourseRow[];
let lessons: LessonRow[];
let comments: CommentRow[];
let notifications: NotificationRow[];
let inTx: boolean;
let failWith: unknown;
let failNotificationWith: unknown;
let POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

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

const fakePrisma = {
  comment: {
    async findUnique(args: Record<string, unknown>) {
      record("comment.findUnique", args);
      const where = args.where as Record<string, unknown>;
      assert.deepEqual(Object.keys(where), ["id"], `where: ${inspect(where)}`);
      const c = comments.find((x) => x.id === where.id);
      return c ? projectComment(c, args.select as Select) : null;
    },
    async create(args: Record<string, unknown>) {
      record("comment.create", args);
      const data = args.data as Omit<CommentRow, "id" | "createdAt">;
      const row: CommentRow = { id: `c_new_${comments.length}`, createdAt: new Date(BASE), ...data };
      comments.push(row);
      return projectComment(row, args.select as Select);
    },
  },
  notification: {
    async create(args: Record<string, unknown>) {
      record("notification.create", args);
      if (failNotificationWith !== undefined) throw failNotificationWith;
      const data = args.data as Omit<NotificationRow, "id" | "read">;
      const row: NotificationRow = { id: `n_new_${notifications.length}`, read: false, ...data };
      notifications.push(row);
      return pick(row, args.select as Select);
    },
  },
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

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ POST } = await import("../../src/app/api/admin/comments/[id]/replies/route"));
});

const at = (minutesAgo: number) => new Date(BASE - minutesAgo * 60_000);

beforeEach(() => {
  session = INSTRUCTOR_SESSION;
  calls = [];
  inTx = false;
  failWith = undefined;
  failNotificationWith = undefined;
  notifications = [];
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
    // #32 より前の POST で作られうる、別レッスンの返信（応答には含めない）
    { id: "r_other", userId: "ins_2", lessonId: "lesson_2", content: "別レッスンの返信", parentId: "q_stu", createdAt: at(100) },
    { id: "q_gone", userId: "stu_gone", lessonId: "lesson_2", content: "無効化された受講生の質問", parentId: null, createdAt: at(250) },
    { id: "q_me", userId: ME, lessonId: "lesson_1", content: "自分（講師）の質問", parentId: null, createdAt: at(240) },
    { id: "q_ins2", userId: "ins_2", lessonId: "lesson_1", content: "別の講師の質問", parentId: null, createdAt: at(230) },
  ];
});

const post = (id: string, body: unknown, raw?: string) =>
  POST(
    new Request(`https://nwa-lms.example.com/api/admin/comments/${encodeURIComponent(id)}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );

const writes = () => calls.filter((c) => c.method === "comment.create" || c.method === "notification.create");

function captureLogs() {
  const logged = mock.method(console, "error", () => {});
  return () => {
    const args = logged.mock.calls.flatMap((c) => c.arguments);
    logged.mock.restore();
    return args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ");
  };
}

function piiError() {
  const err = new Error(`lookup failed for ${DUMMY_EMAIL} (stu_active)`);
  Object.assign(err, { code: "P2025", meta: { email: DUMMY_EMAIL, userId: "stu_active" } });
  return err;
}

describe("POST /api/admin/comments/[id]/replies：認証・権限", () => {
  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    const res = await post("q_stu", { content: "回答" });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0, "DB を読まない");
  });

  it("user.id のないセッションも 401", async () => {
    session = { user: { role: "INSTRUCTOR" } };
    assert.equal((await post("q_stu", { content: "回答" })).status, 401);
    assert.equal(calls.length, 0, "DB を読まない");
  });

  it("受講生は 403 で、DB を読まない", async () => {
    session = STUDENT_SESSION;
    const res = await post("q_stu", { content: "回答" });
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0, "DB を読まない");
  });

  it("role のないセッションも 403", async () => {
    session = { user: { id: ME } };
    assert.equal((await post("q_stu", { content: "回答" })).status, 403);
    assert.equal(calls.length, 0, "DB を読まない");
  });
});

describe("POST /api/admin/comments/[id]/replies：入力", () => {
  it("id が空なら 400 invalid_id で、DB を読まない", async () => {
    const res = await post("", { content: "回答" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "invalid_id");
    assert.equal(calls.length, 0, "DB を読まない");
  });

  it("id が 65 文字なら 400 invalid_id", async () => {
    const res = await post("a".repeat(65), { content: "回答" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "invalid_id");
    assert.equal(calls.length, 0, "DB を読まない");
  });

  it("壊れた JSON は 400 invalid_body で、DB を読まない", async () => {
    const res = await post("q_stu", undefined, "{ not json");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "invalid_body");
    assert.equal(calls.length, 0, "DB を読まない");
  });

  for (const [label, body, reason] of [
    ["配列", [{ content: "回答" }], "invalid_body"],
    ["null", null, "invalid_body"],
    ["content なし", {}, "invalid_content"],
    ["content が数値", { content: 1 }, "invalid_content"],
    ["content が空白だけ", { content: " \n\t " }, "empty"],
    ["content が見えない文字だけ", { content: "​ㅤ" }, "empty"],
    ["content が 2001 文字", { content: "あ".repeat(2001) }, "too_long"],
  ] as Array<[string, unknown, string]>) {
    it(`${label} は 400（${reason}）で、DB を読まない`, async () => {
      const res = await post("q_stu", body);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, reason);
      assert.equal(calls.length, 0, "DB を読まない");
    });
  }

  it("質問が存在しなければ 404 で、書き込まない", async () => {
    const res = await post("q_missing", { content: "回答" });
    assert.equal(res.status, 404);
    assert.equal(writes().length, 0, "書き込まない");
    assert.equal(calls.some((c) => c.method === "$transaction"), false, "トランザクションを始めない");
  });

  it("返信に回答しようとすると 400 not_a_question で、書き込まない", async () => {
    const res = await post("r_stu", { content: "回答" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "not_a_question");
    assert.equal(writes().length, 0, "書き込まない");
  });
});

describe("POST /api/admin/comments/[id]/replies：作成と通知", () => {
  it("201：返信は親と同じ lessonId・セッションの userId で作り、body の userId / lessonId / parentId は使わない", async () => {
    const res = await post("q_stu", { content: "  回答です\n2行目  ", userId: "stu_active", lessonId: "lesson_2", parentId: "q_gone" });
    assert.equal(res.status, 201);
    const created = calls.find((c) => c.method === "comment.create");
    assert.ok(created, "comment.create が呼ばれる");
    assert.deepEqual(created.args.data, { userId: ME, lessonId: "lesson_1", content: "回答です\n2行目", parentId: "q_stu" });
    assert.deepEqual(created.args.select, { id: true }, "create は id だけを読む");
  });

  it("親の取得は必要な項目だけ（email・avatar・name を読まない）", async () => {
    await post("q_stu", { content: "回答" });
    assert.deepEqual(calls[0].method, "comment.findUnique");
    assert.deepEqual(calls[0].args.select, {
      id: true,
      parentId: true,
      lessonId: true,
      userId: true,
      user: { select: { role: true, deactivatedAt: true } },
      lesson: { select: { title: true, section: { select: { course: { select: { name: true } } } } } },
    });
  });

  it("有効な受講生の質問なら、同じトランザクションで通知を作る（文面は固定、講師名と本文を入れない）", async () => {
    const res = await post("q_stu", { content: "秘密の回答本文" });
    assert.equal(res.status, 201);
    const created = calls.filter((c) => c.method === "comment.create" || c.method === "notification.create");
    assert.deepEqual(created.map((c) => [c.method, c.inTx]), [["comment.create", true], ["notification.create", true]]);
    assert.equal(calls.filter((c) => c.method === "$transaction").length, 1, "トランザクションは 1 回");
    assert.deepEqual(notifications.map(({ userId, title, message, read }) => ({ userId, title, message, read })), [
      { userId: "stu_active", title: "質問に回答がありました", message: "STEP1 ダミーコース / ダミーレッスン1 の質問に講師が回答しました", read: false },
    ]);
    const text = JSON.stringify(notifications);
    for (const s of ["講師ビー", "秘密の回答本文", "受講生の質問"]) assert.ok(!text.includes(s), `通知に「${s}」を含めない`);
  });

  for (const [label, id] of [
    ["無効化された受講生の質問", "q_gone"],
    ["自分（回答者本人）の質問", "q_me"],
    ["別の講師の質問", "q_ins2"],
  ] as Array<[string, string]>) {
    it(`${label}には回答できるが、通知は作らない`, async () => {
      const res = await post(id, { content: "回答" });
      assert.equal(res.status, 201);
      assert.equal(calls.filter((c) => c.method === "comment.create" && c.inTx).length, 1, "返信はトランザクションの中で 1 件作る");
      assert.equal(calls.some((c) => c.method === "notification.create"), false, "通知を作らない");
      assert.equal(notifications.length, 0, "通知を作らない");
    });
  }

  it("無効化された受講生の質問のスレッドは author.name: null（匿名）で返す", async () => {
    const body = await (await post("q_gone", { content: "回答" })).json();
    assert.deepEqual(body.thread.author, { name: null, isInstructor: false });
    assert.equal(body.thread.answered, true);
  });

  it("2000 文字ちょうどは 201", async () => {
    assert.equal((await post("q_stu", { content: "あ".repeat(2000) })).status, 201);
  });
});

describe("POST /api/admin/comments/[id]/replies：応答", () => {
  it("201 { thread }：回答後のスレッド（answered: true、同じレッスンの返信だけ、古い順）", async () => {
    const res = await post("q_stu", { content: "回答です" });
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ["thread"]);
    const t = body.thread;
    assert.equal(t.id, "q_stu");
    assert.equal(t.content, "受講生の質問");
    assert.deepEqual(t.author, { name: "受講生エー", isInstructor: false });
    assert.equal(t.mine, false);
    assert.equal(t.answered, true);
    assert.deepEqual(t.lesson, { id: "lesson_1", title: "ダミーレッスン1" });
    assert.deepEqual(t.course, { id: "course_1", name: "STEP1 ダミーコース" });
    assert.equal(t.replyCount, 2);
    assert.equal(t.lastReplyAt, new Date(BASE).toISOString());
    assert.deepEqual(
      t.replies.map((r: { content: string; author: unknown; mine: boolean }) => [r.content, r.author, r.mine]),
      [
        ["受講生の追記", { name: "受講生エー", isInstructor: false }, false],
        ["回答です", { name: "講師ビー", isInstructor: true }, true],
      ]
    );
  });

  it("読み直しの select は GET /api/comments と同じ項目だけ", async () => {
    await post("q_stu", { content: "回答" });
    const reread = calls.filter((c) => c.method === "comment.findUnique")[1];
    assert.ok(reread, "スレッドを読み直す");
    assert.equal(reread.inTx, false, "読み直しはトランザクションの後");
    const base = { id: true, content: true, createdAt: true, userId: true, user: { select: { name: true, role: true, deactivatedAt: true } } };
    assert.deepEqual(reread.args.select, {
      ...base,
      lesson: { select: { id: true, title: true, section: { select: { course: { select: { id: true, name: true } } } } } },
      replies: { select: { ...base, lessonId: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    });
  });

  it("応答に userId・email・avatar・role・deactivatedAt・ユーザー ID を含めない", async () => {
    const text = await (await post("q_stu", { content: "回答" })).text();
    const t = JSON.parse(text).thread;
    assert.deepEqual(Object.keys(t).sort(), ["answered", "author", "content", "course", "createdAt", "id", "lastReplyAt", "lesson", "mine", "replies", "replyCount"]);
    for (const r of t.replies) assert.deepEqual(Object.keys(r).sort(), ["author", "content", "createdAt", "id", "mine"]);
    for (const k of ["userId", "email", "avatar", "role", "deactivatedAt", "password", "example\\.com", "stu_active", "stu_gone", "ins_1", "ins_2", "INSTRUCTOR", "STUDENT", "lessonId", "別レッスンの返信"]) {
      assert.doesNotMatch(text, new RegExp(k), k);
    }
  });
});

describe("POST /api/admin/comments/[id]/replies：エラー", () => {
  it("例外なら 500 で、ログにメールアドレス・ユーザー ID・メッセージ・コードを出さない", async () => {
    failWith = piiError();
    const done = captureLogs();
    const res = await post("q_stu", { content: "回答" });
    const out = done();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.ok(out.length > 0, "ログを出す");
    for (const re of [/example\.com/, /stu_active/, /lookup failed/, /P2025/]) assert.doesNotMatch(out, re);
    assert.match(out, /Error/);
  });

  it("通知の作成に失敗したら 500（トランザクションの中で失敗する）", async () => {
    failNotificationWith = piiError();
    const done = captureLogs();
    const res = await post("q_stu", { content: "回答" });
    const out = done();
    assert.equal(res.status, 500);
    const failed = calls.find((c) => c.method === "notification.create");
    assert.ok(failed && failed.inTx, "通知はトランザクションの中で作る");
    assert.doesNotMatch(out, /example\.com|stu_active|P2025/);
  });
});
