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
    ["content が見えない文字だけ", { content: "\u200B\u3164" }, "empty"],
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
    assert.equal(reread.inTx, true, "読み直しは回答の作成と同じトランザクションの中");
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

// ───────────── 追加の観点（#32 A-1 テスト担当） ─────────────

const postWithParams = (params: unknown, body: unknown, raw?: string) =>
  POST(
    new Request("https://nwa-lms.example.com/api/admin/comments/x/replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve(params as { id: string }) }
  );

describe("POST /api/admin/comments/[id]/replies：認可（追加）", () => {
  for (const [label, role] of [
    ["小文字の instructor", "instructor"],
    ["ADMIN", "ADMIN"],
    ["前後に空白のある INSTRUCTOR", " INSTRUCTOR "],
    ["空文字の role", ""],
  ] as Array<[string, string]>) {
    it(`${label} は 403 で、DB を読まず body も見ない`, async () => {
      session = { user: { id: ME, role } };
      const res = await post("q_stu", undefined, "{ not json");
      assert.equal(res.status, 403, `role=${JSON.stringify(role)}`);
      assert.deepEqual(await res.json(), { error: "Forbidden" });
      assert.equal(calls.length, 0, "DB を読まない");
    });
  }

  it("未ログインなら body が壊れていても 401（認証を先に見る）", async () => {
    session = null;
    const res = await post("q_stu", undefined, "{ not json");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(calls.length, 0, "DB を読まない");
  });

  it("受講生は自分の質問にもこの API では回答できない（403）", async () => {
    session = { user: { id: "stu_active", role: "STUDENT" } };
    const res = await post("q_stu", { content: "追記" });
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0, "DB を読まない");
    assert.equal(comments.length, 6, "コメントは増えない");
  });
});

describe("POST /api/admin/comments/[id]/replies：id（追加）", () => {
  for (const [label, id] of [
    ["配列", ["q_stu"]],
    ["数値", 1],
    ["undefined", undefined],
    ["null", null],
  ] as Array<[string, unknown]>) {
    it(`params.id が${label}なら 400 invalid_id で、DB を読まない`, async () => {
      const res = await postWithParams({ id }, { content: "回答" });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, "invalid_id");
      assert.equal(calls.length, 0, "DB を読まない");
    });
  }

  it("64 文字ちょうどの id は検証を通り、存在しなければ 404", async () => {
    const res = await post("a".repeat(64), { content: "回答" });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Question not found" });
    const first = calls[0];
    assert.ok(first && first.method === "comment.findUnique", "親を 1 回読む");
    assert.deepEqual(first.args.where, { id: "a".repeat(64) });
  });

  for (const id of ["q_stu%20", "q_stu/../q_stu", "q_stu\u0000", "Q_STU", " q_stu"]) {
    it(`id ${JSON.stringify(id)} はそのまま where に渡し、一致しないので 404（書き込まない）`, async () => {
      const res = await post(id, { content: "回答" });
      assert.equal(res.status, 404);
      assert.equal(writes().length, 0, "書き込まない");
      const first = calls[0];
      assert.ok(first, "親を読む");
      assert.deepEqual(first.args.where, { id }, "id を加工しない");
    });
  }
});

describe("POST /api/admin/comments/[id]/replies：body（追加）", () => {
  for (const [label, raw, reason] of [
    ["空の body", "", "invalid_body"],
    ["JSON の文字列", JSON.stringify("回答"), "invalid_body"],
    ["JSON の数値", "1", "invalid_body"],
    ["JSON の true", "true", "invalid_body"],
    ["JSON の null", "null", "invalid_body"],
    ["配列（空）", "[]", "invalid_body"],
    ["content が空文字", JSON.stringify({ content: "" }), "empty"],
    ["content が null", JSON.stringify({ content: null }), "invalid_content"],
    ["content が配列", JSON.stringify({ content: ["回答"] }), "invalid_content"],
    ["content がオブジェクト", JSON.stringify({ content: { text: "回答" } }), "invalid_content"],
    ["content が true", JSON.stringify({ content: true }), "invalid_content"],
    ["content が全角空白だけ", JSON.stringify({ content: "\u3000\u3000" }), "empty"],
    ["content がゼロ幅文字だけ", JSON.stringify({ content: "\u200B\u200C\u200D\u2060\uFEFF" }), "empty"],
    ["content がハングルフィラーと空白だけ", JSON.stringify({ content: " \u3164 \u115F " }), "empty"],
    ["content が絵文字 2001 個", JSON.stringify({ content: "\u{1F600}".repeat(2001) }), "too_long"],
    ["content が 2000 文字＋見える 1 文字（前後空白あり）", JSON.stringify({ content: ` ${"あ".repeat(2000)}い ` }), "too_long"],
  ] as Array<[string, string, string]>) {
    it(`${label} は 400 ${reason} で、DB を読まない`, async () => {
      const res = await post("q_stu", undefined, raw);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason });
      assert.equal(calls.length, 0, "DB を読まない");
    });
  }

  for (const [label, content, stored] of [
    ["絵文字 2000 個（サロゲートペアは 1 文字）", "\u{1F600}".repeat(2000), "\u{1F600}".repeat(2000)],
    ["1999 文字＋絵文字 1 個", `${"あ".repeat(1999)}\u{1F600}`, `${"あ".repeat(1999)}\u{1F600}`],
    ["2000 文字の前後に空白（除いた後で数える）", `  \n${"あ".repeat(2000)}\t `, "あ".repeat(2000)],
    ["見えない文字＋見える文字", "\u200B回答", "\u200B回答"],
  ] as Array<[string, string, string]>) {
    it(`${label} は 201 で、前後の空白を除いた本文を保存する`, async () => {
      const res = await post("q_stu", { content });
      assert.equal(res.status, 201);
      const created = calls.find((c) => c.method === "comment.create");
      assert.ok(created, "comment.create が呼ばれる");
      assert.equal((created.args.data as { content: string }).content, stored);
    });
  }

  it("クライアントが送った id・createdAt・role・notify なども create に渡さない", async () => {
    const res = await post("q_gone", {
      content: "回答",
      id: "c_forged",
      createdAt: "2000-01-01T00:00:00.000Z",
      userId: "stu_gone",
      lessonId: "lesson_1",
      parentId: "q_stu",
      role: "STUDENT",
      notify: true,
    });
    assert.equal(res.status, 201);
    const created = calls.find((c) => c.method === "comment.create");
    assert.ok(created, "comment.create が呼ばれる");
    assert.deepEqual(created.args.data, { userId: ME, lessonId: "lesson_2", content: "回答", parentId: "q_gone" });
    assert.equal(notifications.length, 0, "notify: true を送っても無効化済みの受講生には通知しない");
  });
});

describe("POST /api/admin/comments/[id]/replies：他コース・ロック中コース", () => {
  beforeEach(() => {
    courses.push({ id: "course_8", name: "STEP8 ダミー（ロック中）" });
    lessons.push({ id: "lesson_8", title: "ダミーレッスン8", courseId: "course_8" });
    comments.push({ id: "q_locked", userId: "stu_active", lessonId: "lesson_8", content: "ロック中コースの質問本文", parentId: null, createdAt: at(50) });
  });

  it("講師は受講生が開放していないコースの質問にも回答でき、通知はそのコース名・レッスン名で質問者に作る", async () => {
    const res = await post("q_locked", { content: "回答本文ロック" });
    assert.equal(res.status, 201);
    assert.deepEqual(
      calls.map((c) => c.method),
      ["comment.findUnique", "$transaction", "comment.create", "notification.create", "comment.findUnique"],
      "進捗・受講状況など他のテーブルを読まない"
    );
    assert.equal(notifications.length, 1, "通知は 1 件");
    const n = notifications[0];
    assert.equal(n.userId, "stu_active", "通知の宛先は質問者");
    assert.equal(n.title, "質問に回答がありました");
    assert.equal(n.message, "STEP8 ダミー（ロック中） / ダミーレッスン8 の質問に講師が回答しました");
    for (const s of ["回答本文ロック", "ロック中コースの質問本文", "講師ビー", "teacher@example.com", ME]) {
      assert.ok(!JSON.stringify(n).includes(s), `通知に「${s}」を含めない`);
    }
    const body = await res.json();
    assert.deepEqual(body.thread.course, { id: "course_8", name: "STEP8 ダミー（ロック中）" });
    assert.deepEqual(body.thread.lesson, { id: "lesson_8", title: "ダミーレッスン8" });
    assert.equal(body.thread.answered, true);
  });

  it("別の講師（ins_2）が回答しても、通知の宛先は質問者で、回答者ではない", async () => {
    session = { user: { id: "ins_2", role: "INSTRUCTOR" } };
    const res = await post("q_locked", { content: "回答" });
    assert.equal(res.status, 201);
    assert.deepEqual(notifications.map((n) => n.userId), ["stu_active"]);
    const created = calls.find((c) => c.method === "comment.create");
    assert.ok(created, "comment.create が呼ばれる");
    assert.equal((created.args.data as { userId: string }).userId, "ins_2", "返信の userId はセッションの講師");
  });

  it("同じ質問に 2 回回答すると、通知も 2 件（回答ごとに 1 件）", async () => {
    assert.equal((await post("q_locked", { content: "1 回目" })).status, 201);
    assert.equal((await post("q_locked", { content: "2 回目" })).status, 201);
    assert.equal(notifications.length, 2);
    assert.ok(notifications.every((n) => n.userId === "stu_active"), "どちらも質問者宛て");
  });
});

describe("POST /api/admin/comments/[id]/replies：応答の最小化（追加）", () => {
  it("無効化された受講生の質問：author.name は null、回答は自分（mine: true）、内部の値を出さない", async () => {
    const text = await (await post("q_gone", { content: "回答" })).text();
    const t = JSON.parse(text).thread;
    assert.deepEqual(t.author, { name: null, isInstructor: false });
    assert.equal(t.answered, true);
    assert.equal(t.mine, false);
    assert.deepEqual(
      t.replies.map((r: { content: string; author: unknown; mine: boolean }) => [r.content, r.author, r.mine]),
      [["回答", { name: "講師ビー", isInstructor: true }, true]]
    );
    for (const s of ["受講生ゴーン", "gone@example.com", "stu_gone", "deactivatedAt", "hash-", "lesson_1\"", "lessonId"]) {
      assert.ok(!text.includes(s), `応答に「${s}」を含めない`);
    }
  });

  it("有効な受講生の質問：avatar のファイル名・パスワードのハッシュを出さない", async () => {
    const text = await (await post("q_stu", { content: "回答" })).text();
    for (const s of ["avatar-a.png", "hash-a", "hash-c", "password", "teacher@example.com"]) {
      assert.ok(!text.includes(s), `応答に「${s}」を含めない`);
    }
  });

  it("自分（講師）の質問に回答すると、親も mine: true", async () => {
    const t = (await (await post("q_me", { content: "回答" })).json()).thread;
    assert.equal(t.mine, true);
    assert.deepEqual(t.author, { name: "講師ビー", isInstructor: true });
    assert.equal(t.answered, true);
  });
});

describe("POST /api/admin/comments/[id]/replies：エラー（追加）", () => {
  it("トランザクション内の comment.create が失敗したら 500・汎用本文、通知は作らず、ログはエラー名だけ", async () => {
    const orig = fakePrisma.comment.create;
    const m = mock.method(fakePrisma.comment, "create", async (args: Record<string, unknown>) => {
      calls.push({ method: "comment.create", args, inTx });
      throw piiError();
    });
    const done = captureLogs();
    try {
      const res = await post("q_stu", { content: "秘密の回答本文" });
      const out = done();
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.equal(calls.some((c) => c.method === "notification.create"), false, "通知を作らない");
      assert.equal(notifications.length, 0, "通知を作らない");
      assert.equal(out, "POST /api/admin/comments/[id]/replies error: Error", "ログはルート名とエラー名だけ");
      for (const s of ["秘密の回答本文", "example.com", "stu_active", "P2025", "lookup failed"]) {
        assert.ok(!out.includes(s), `ログに「${s}」を出さない`);
      }
    } finally {
      m.mock.restore();
      assert.equal(fakePrisma.comment.create, orig, "元に戻す");
    }
  });

  it("$transaction 自体が失敗しても 500、応答とログに本文・メールを出さない", async () => {
    const m = mock.method(fakePrisma, "$transaction", async () => {
      const err = new Error(`Transaction failed: 秘密の回答本文 ${DUMMY_EMAIL}`);
      err.name = "PrismaClientKnownRequestError";
      Object.assign(err, { code: "P2034" });
      throw err;
    });
    const done = captureLogs();
    try {
      const res = await post("q_stu", { content: "秘密の回答本文" });
      const out = done();
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.equal(text, JSON.stringify({ error: "Internal server error" }));
      assert.equal(out, "POST /api/admin/comments/[id]/replies error: PrismaClientKnownRequestError");
      for (const s of ["秘密の回答本文", "example.com", "P2034"]) assert.ok(!out.includes(s), `ログに「${s}」を出さない`);
    } finally {
      m.mock.restore();
    }
  });

  it("Error でない値（メールを含む文字列）が投げられてもログは型名だけ", async () => {
    const m = mock.method(fakePrisma, "$transaction", async () => {
      throw `failed for ${DUMMY_EMAIL}`;
    });
    const done = captureLogs();
    try {
      const res = await post("q_stu", { content: "回答" });
      const out = done();
      assert.equal(res.status, 500);
      assert.equal(out, "POST /api/admin/comments/[id]/replies error: string");
    } finally {
      m.mock.restore();
    }
  });

  it("親の読み込みで失敗したら 500 で、トランザクションを始めない", async () => {
    failWith = piiError();
    const done = captureLogs();
    const res = await post("q_stu", { content: "回答" });
    done();
    assert.equal(res.status, 500);
    assert.equal(calls.some((c) => c.method === "$transaction"), false, "トランザクションを始めない");
  });

  it("回答の作成後に親を読み直せなければ、トランザクションの中で例外を投げて 500・汎用本文（ログはエラー名だけ）", async () => {
    const origFind = fakePrisma.comment.findUnique;
    const origTx = fakePrisma.$transaction;
    let n = 0;
    const find = mock.method(fakePrisma.comment, "findUnique", async (args: Record<string, unknown>) => {
      n += 1;
      if (n === 1) return origFind.call(fakePrisma.comment, args);
      record("comment.findUnique", args);
      return null;
    });
    // 偽の $transaction はロールバックを再現しないので、コールバックが例外で終わる（実物ならロールバックされる）ことを確かめる
    let callbackRejected = false;
    const tx = mock.method(fakePrisma, "$transaction", async (fn: unknown) => {
      try {
        return await origTx.call(fakePrisma, fn);
      } catch (e) {
        callbackRejected = true;
        throw e;
      }
    });
    const done = captureLogs();
    try {
      const res = await post("q_stu", { content: "秘密の回答本文" });
      const out = done();
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.equal(callbackRejected, true, "トランザクションのコールバックが例外で終わる（回答と通知はロールバックされる）");
      const reread = calls.filter((c) => c.method === "comment.findUnique")[1];
      assert.ok(reread, "スレッドを読み直す");
      assert.equal(reread.inTx, true, "読み直しはトランザクションの中");
      assert.equal(out, "POST /api/admin/comments/[id]/replies error: Error", "ログはルート名とエラー名だけ");
      for (const s of ["秘密の回答本文", "example.com", "stu_active", "q_stu"]) {
        assert.ok(!out.includes(s), `ログに「${s}」を出さない`);
      }
    } finally {
      tx.mock.restore();
      find.mock.restore();
      assert.equal(fakePrisma.comment.findUnique, origFind, "元に戻す");
      assert.equal(fakePrisma.$transaction, origTx, "元に戻す");
    }
  });
});

// ───────────── #86 本文の NUL・対になっていないサロゲート ─────────────

describe("POST /api/admin/comments/[id]/replies：本文に NUL・対になっていないサロゲートがあれば 400 invalid_characters（#86）", () => {
  // body の JSON の中では \u エスケープの形で送る（ソースの文字列はバックスラッシュ u。生の文字は入れない）
  const RAW: Array<[string, string]> = [
    ["\\u0000", '{"content":"回答\\u0000です"}'],
    ["\\ud800（上位だけ）", '{"content":"回答\\ud800です"}'],
    ["\\udc00（下位だけ）", '{"content":"回答\\udc00です"}'],
    ["\\ude00\\ud83d（逆順）", '{"content":"回答\\ude00\\ud83dです"}'],
    ["\\u0000 だけ", '{"content":"\\u0000"}'],
    ["上限超え + \\ud800", `{"content":"${"あ".repeat(2001)}\\ud800"}`],
  ];
  for (const [label, raw] of RAW) {
    it(`${label}：400 で、DB に一度も触れない（質問を読まず、回答も通知も作らない）`, async () => {
      assert.ok(!raw.includes("\u0000") && !/[\uD800-\uDFFF]/.test(raw), `ソースの JSON に生の文字が入っている：${label}`);
      const before = comments.length;
      const res = await post("q_stu", undefined, raw);
      assert.equal(res.status, 400, label);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_characters" }, label);
      assert.equal(calls.length, 0, `DB に触れた：${calls.map((c) => c.method).join(",")}`);
      assert.equal(comments.length, before, "保存していない");
      assert.equal(notifications.length, 0, "通知を作った");
    });
  }

  it("JSON.stringify で送った場合（対になっていないサロゲートは \\u エスケープになる）も 400", async () => {
    for (const content of ["回答\u0000です", "回答\uD800です", "回答\uDC00です"]) {
      const res = await post("q_stu", { content });
      assert.equal(res.status, 400, JSON.stringify(content));
      assert.equal((await res.json()).reason, "invalid_characters", JSON.stringify(content));
    }
    assert.equal(calls.length, 0, "DB に触れた");
  });

  it("受講生は本文より先に 403（判定の順は変えない）", async () => {
    session = STUDENT_SESSION;
    const res = await post("q_stu", undefined, '{"content":"\\u0000"}');
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0, "DB に触れた");
  });

  it("正しいサロゲートペア（\\ud83d\\ude00）は 201 で、本文をそのまま保存する", async () => {
    const res = await post("q_stu", undefined, '{"content":"回答\\ud83d\\ude00です"}');
    assert.equal(res.status, 201);
    const created = calls.filter((c) => c.method === "comment.create");
    assert.equal(created.length, 1, "保存していない");
    assert.equal((created[0].args.data as { content: string }).content, "回答\u{1F600}です");
  });
});

// ───────────── #86 テスト担当の追加：文字・位置・空白・送り方の組み合わせと、理由の優先順位 ─────────────
// 見えない文字はソースに直接書かず、\u エスケープで書く

/** [ラベル, 実際の文字, JSON の中でのエスケープの形] */
const BAD_CHARS_86: Array<[string, string, string]> = [
  ["NUL", "\u0000", "\\u0000"],
  ["上位サロゲートだけ（D800）", "\uD800", "\\ud800"],
  ["上位サロゲートだけ（DBFF・大文字のエスケープ）", "\uDBFF", "\\uDBFF"],
  ["下位サロゲートだけ（DC00）", "\uDC00", "\\udc00"],
  ["下位サロゲートだけ（DFFF・大文字のエスケープ）", "\uDFFF", "\\uDFFF"],
  ["逆順のサロゲート", "\uDE00\uD83D", "\\ude00\\ud83d"],
  ["上位が 2 つ続いてから下位", "\uD83D😀", "\\ud83d\\ud83d\\ude00"],
];
const PLACEHOLDER_86 = "@@BAD@@";
const POSITIONS_86: Array<[string, (x: string) => string]> = [
  ["先頭", (x) => `${x}回答です`],
  ["末尾", (x) => `回答です${x}`],
  ["途中", (x) => `回答${x}です`],
  ["それだけ", (x) => x],
];
const WRAPS_86: Array<[string, (s: string) => string]> = [
  ["空白なし", (s) => s],
  ["前後に空白・改行・全角空白", (s) => ` \n\u3000${s}\t\u00A0 `],
  ["前後に見えない文字（ZWSP）", (s) => `\u200B${s}\u200B`],
];
const hasRawUnsafe86 = (s: string) => s.includes("\u0000") || /[\uD800-\uDFFF]/.test(s);

describe("POST /api/admin/comments/[id]/replies：#86 の文字 × 位置 × 前後の空白 × 送り方で 400 invalid_characters、DB に触れない", () => {
  for (const [label, ch, esc] of BAD_CHARS_86) {
    for (const form of ["エスケープの形", "JSON.stringify"] as const) {
      it(`${label}：${form}で送る`, async () => {
        for (const [pos, place] of POSITIONS_86) {
          for (const [wrapLabel, wrap] of WRAPS_86) {
            const where = `${label}/${pos}/${wrapLabel}`;
            let res: Response;
            if (form === "エスケープの形") {
              const raw = JSON.stringify({ content: wrap(place(PLACEHOLDER_86)) }).replace(PLACEHOLDER_86, esc);
              assert.ok(!hasRawUnsafe86(raw), `送る JSON に生の文字が入っている：${where}`);
              res = await post("q_stu", undefined, raw);
            } else {
              res = await post("q_stu", { content: wrap(place(ch)) });
            }
            assert.equal(res.status, 400, where);
            assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_characters" }, where);
          }
        }
        assert.equal(calls.length, 0, `DB に触れた：${calls.map((c) => c.method).join(",")}`);
        assert.equal(comments.length, 6, "保存した");
        assert.equal(notifications.length, 0, "通知を作った");
      });
    }
  }
});

describe("POST /api/admin/comments/[id]/replies：#86 の判定の優先順位", () => {
  const BAD_RAW = '{"content":"回答\\u0000です"}';

  it("未ログインは 401（本文より先。DB に触れない）", async () => {
    session = null;
    const res = await post("q_stu", undefined, BAD_RAW);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0, "DB に触れた");
  });

  it("講師以外は 403（本文より先。DB に触れない）", async () => {
    for (const s of [STUDENT_SESSION, { user: { id: "x", role: "ADMIN" } }, { user: { id: "x" } }] as FakeSession[]) {
      session = s;
      const res = await post("q_stu", undefined, BAD_RAW);
      assert.equal(res.status, 403, JSON.stringify(s));
    }
    assert.equal(calls.length, 0, "DB に触れた");
  });

  it("URL の id が不正なら invalid_id が invalid_characters より先", async () => {
    for (const id of ["", "x".repeat(65)]) {
      const res = await post(id, undefined, BAD_RAW);
      assert.equal(res.status, 400, `id の長さ ${id.length}`);
      assert.equal((await res.json()).reason, "invalid_id", `id の長さ ${id.length}`);
    }
    assert.equal(calls.length, 0, "DB に触れた");
  });

  it("body が object でなければ invalid_body、content が string でなければ invalid_content（どちらも invalid_characters より先）", async () => {
    for (const [body, reason] of [
      [["\u0000"], "invalid_body"],
      ["\uD800", "invalid_body"],
      [null, "invalid_body"],
      [{ content: ["\u0000"] }, "invalid_content"],
      [{ content: { a: "\uDC00" } }, "invalid_content"],
      [{ content: 0 }, "invalid_content"],
    ] as Array<[unknown, string]>) {
      const res = await post("q_stu", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).reason, reason, JSON.stringify(body));
    }
    assert.equal(calls.length, 0, "DB に触れた");
  });

  it("invalid_characters は empty・too_long より先", async () => {
    const long = "あ".repeat(2001);
    for (const content of ["  \u0000  ", "\u200B\uDC00\u200B", "\u3000\uD800", `${long}\u0000`, `\uDFFF${long}`]) {
      const res = await post("q_stu", { content });
      assert.equal(res.status, 400, `長さ ${content.length}`);
      assert.equal((await res.json()).reason, "invalid_characters", `長さ ${content.length}`);
    }
    assert.equal(calls.length, 0, "DB に触れた");
  });

  it("400 invalid_characters は 404（質問がない）・400 not_a_question より先（質問を読まない）", async () => {
    for (const [id, status, reason] of [
      ["q_nope", 404, undefined],
      ["r_stu", 400, "not_a_question"],
    ] as Array<[string, number, string | undefined]>) {
      const ctl = await post(id, { content: "対照の回答" });
      assert.equal(ctl.status, status, `前提：正しい本文なら ${status}（${id}）`);
      assert.equal((await ctl.json()).reason, reason, `前提の reason（${id}）`);
      calls = [];
      const res = await post(id, { content: "回答\uD800" });
      assert.equal(res.status, 400, id);
      assert.equal((await res.json()).reason, "invalid_characters", id);
      assert.equal(calls.length, 0, `DB に触れた（${id}）`);
    }
  });
});

describe("POST /api/admin/comments/[id]/replies：#86 正しい文字は 201 で本文をそのまま保存する", () => {
  const GOOD: Array<[string, string]> = [
    ["絵文字（サロゲートペア）", "回答\u{1F600}です"],
    ["絵文字だけ", "\u{1F600}"],
    ["結合文字（e + U+0301）", "cafe\u0301 の回答"],
    ["濁点の結合文字（か + U+3099）", "か\u3099の回答"],
    ["ZWJ の家族の絵文字", "家族 \u{1F468}\u200D\u{1F469}\u200D\u{1F467}"],
    ["異体字セレクタ付きのハート", "❤\uFE0F ありがとう"],
    ["国旗（地域指示子のペア）", "\u{1F1EF}\u{1F1F5} の回答"],
    ["肌の色の修飾子", "\u{1F44D}\u{1F3FD}"],
    ["面外の漢字（U+20BB7）", "\u{20BB7}野家"],
    ["U+FFFD と U+FFFF", "置換\uFFFD\uFFFF"],
  ];
  for (const [label, content] of GOOD) {
    it(label, async () => {
      const res = await post("q_stu", { content });
      assert.equal(res.status, 201, label);
      const created = calls.filter((c) => c.method === "comment.create");
      assert.equal(created.length, 1, "保存していない");
      assert.equal((created[0].args.data as { content: string }).content, content, `保存した本文が変わった：${label}`);
      const body = (await res.json()) as { thread: { replies: Array<{ content: string }> } };
      assert.ok(
        body.thread.replies.some((r) => r.content === content),
        `応答のスレッドに本文がそのまま入っていない：${label}`,
      );
      assert.equal(notifications.length, 1, "通知を作っていない");
    });
  }

  it("前後の空白は除いて保存し、中の正しい絵文字は変えない", async () => {
    const res = await post("q_stu", { content: ` \n\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\n ` });
    assert.equal(res.status, 201);
    const created = calls.filter((c) => c.method === "comment.create");
    assert.equal((created[0].args.data as { content: string }).content, "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}");
  });
});

describe("POST /api/admin/comments/[id]/replies：#86 エスケープせずに生の文字を body に入れた場合（参考）", () => {
  it("生の対になっていないサロゲートは UTF-8 にする時点で U+FFFD に置き換わり、201 で U+FFFD を保存する", async () => {
    const res = await post("q_stu", undefined, `{"content":"回答${"\uD800"}です"}`);
    assert.equal(res.status, 201);
    const created = calls.filter((c) => c.method === "comment.create");
    assert.equal((created[0].args.data as { content: string }).content, "回答\uFFFDです");
  });

  it("生の NUL は JSON として不正なので 400 invalid_body（DB に触れない）", async () => {
    const res = await post("q_stu", undefined, `{"content":"回答${"\u0000"}です"}`);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_body" });
    assert.equal(calls.length, 0, "DB に触れた");
  });
});
