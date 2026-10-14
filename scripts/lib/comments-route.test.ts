import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #32 GET /api/comments/[lessonId] と POST /api/comments（レッスンの質問タブ）。#46 で POST にロール・返信・ロック・連投の制限を追加。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数を記録し、where（等号と createdAt の gt）・orderBy・take・select（入れ子の user / replies を含む）を最低限だけ再現する）。
// POST の現在時刻は mock.timers で BASE に固定する（偽の create も createdAt に BASE を入れる）。
// NextAuth は installFakeAuth で差し替える。データはすべてダミー（example.com）。

type UserRow = { id: string; email: string; name: string; role: "STUDENT" | "INSTRUCTOR"; avatar: string | null; deactivatedAt: Date | null; password: string };
type CommentRow = { id: string; userId: string; lessonId: string; content: string; parentId: string | null; createdAt: Date };
type Call = { method: string; args: Record<string, unknown> };
type Select = Record<string, unknown>;
type CourseRow = { id: string; order: number; lessons: string[] };
type ProgressRow = { userId: string; lessonId: string; completed: boolean };

const STUDENT = "stu_active";
const LESSON = "lesson_1";
const OTHER_LESSON = "lesson_2";
const LOCKED_LESSON = "lesson_locked";
const DUMMY_EMAIL = "student@example.com";
const BASE = Date.parse("2026-10-06T12:00:00.000Z");

let session: FakeSession;
let calls: Call[];
let users: UserRow[];
let courses: CourseRow[];
let progress: ProgressRow[];
let comments: CommentRow[];
let failWith: unknown;
let GET: (req: Request, ctx: { params: Promise<{ lessonId: string }> }) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;

/** where の 1 項目。等号と、Date の gt だけ */
function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
    const c = cond as Record<string, unknown>;
    if (Object.keys(c).length === 1 && c.gt instanceof Date) return actual instanceof Date && actual.getTime() > c.gt.getTime();
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return actual === cond;
}

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

function projectUser(u: UserRow, select: Select | undefined): Record<string, unknown> {
  if (!select) return { ...u };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) if (v === true) out[k] = u[k as keyof UserRow];
  return out;
}

function projectComment(c: CommentRow, select: Select | undefined): Record<string, unknown> {
  if (!select) return { ...c };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    if (k === "user") {
      const u = users.find((x) => x.id === c.userId);
      assert.ok(u, "user がない");
      out.user = projectUser(u, (v as { select?: Select }).select);
      continue;
    }
    if (k === "replies") {
      const spec = v as { where?: Record<string, unknown>; select?: Select; orderBy?: unknown };
      const where = spec.where ?? {};
      const children = comments.filter((r) => r.parentId === c.id && Object.entries(where).every(([wk, wv]) => r[wk as keyof CommentRow] === wv));
      const rows = sortRows(children as unknown as Record<string, unknown>[], spec.orderBy);
      out.replies = (rows as unknown as CommentRow[]).map((r) => projectComment(r, spec.select));
      continue;
    }
    out[k] = c[k as keyof CommentRow];
  }
  return out;
}

const fakePrisma = {
  comment: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "comment.findMany", args });
      if (failWith !== undefined) throw failWith;
      const where = (args.where ?? {}) as Record<string, unknown>;
      let rows = comments.filter((r) => Object.entries(where).every(([k, v]) => matchValue(r[k as keyof CommentRow], v)));
      rows = sortRows(rows as unknown as Record<string, unknown>[], args.orderBy) as unknown as CommentRow[];
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      return rows.map((r) => projectComment(r, args.select as Select | undefined));
    },
    async findUnique(args: Record<string, unknown>) {
      calls.push({ method: "comment.findUnique", args });
      if (failWith !== undefined) throw failWith;
      const id = (args.where as { id: string }).id;
      const c = comments.find((x) => x.id === id);
      return c ? projectComment(c, args.select as Select | undefined) : null;
    },
    async create(args: Record<string, unknown>) {
      calls.push({ method: "comment.create", args });
      if (failWith !== undefined) throw failWith;
      const data = args.data as Omit<CommentRow, "id" | "createdAt">;
      const row: CommentRow = { id: `c_new_${comments.length}`, createdAt: new Date(BASE), ...data };
      comments.push(row);
      return projectComment(row, args.select as Select | undefined);
    },
  },
  lesson: {
    async findUnique(args: Record<string, unknown>) {
      calls.push({ method: "lesson.findUnique", args });
      if (failWith !== undefined) throw failWith;
      const id = (args.where as { id: string }).id;
      const course = courses.find((c) => c.lessons.includes(id));
      return course ? { section: { courseId: course.id } } : null;
    },
  },
  course: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "course.findMany", args });
      if (failWith !== undefined) throw failWith;
      return [...courses]
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ id: c.id, sections: [{ lessons: c.lessons.map((id) => ({ id })) }] }));
    },
  },
  progress: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "progress.findMany", args });
      if (failWith !== undefined) throw failWith;
      const where = args.where as { userId: string; completed: boolean };
      return progress.filter((p) => p.userId === where.userId && p.completed === where.completed).map((p) => ({ lessonId: p.lessonId }));
    },
  },
};

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ GET } = await import("../../src/app/api/comments/[lessonId]/route"));
  ({ POST } = await import("../../src/app/api/comments/route"));
});

const at = (minutesAgo: number) => new Date(BASE - minutesAgo * 60_000);

beforeEach(() => {
  session = STUDENT_SESSION;
  calls = [];
  failWith = undefined;
  // course_1 は最初のコース（ロックなし）。course_2 は course_1 を終えるまでロック
  courses = [
    { id: "course_1", order: 1, lessons: [LESSON, OTHER_LESSON] },
    { id: "course_2", order: 2, lessons: [LOCKED_LESSON] },
  ];
  progress = [];
  users = [
    { id: STUDENT, email: DUMMY_EMAIL, name: "受講生エー", role: "STUDENT", avatar: "avatar-a.png", deactivatedAt: null, password: "hash-a" },
    { id: "stu_gone", email: "gone@example.com", name: "受講生ゴーン", role: "STUDENT", avatar: null, deactivatedAt: new Date(BASE - 86_400_000), password: "hash-b" },
    { id: "ins_1", email: "teacher@example.com", name: "講師ビー", role: "INSTRUCTOR", avatar: null, deactivatedAt: null, password: "hash-c" },
  ];
  comments = [
    { id: "c1", userId: STUDENT, lessonId: LESSON, content: "質問1", parentId: null, createdAt: at(300) },
    { id: "c2", userId: "stu_gone", lessonId: LESSON, content: "質問2", parentId: null, createdAt: at(120) },
    // c3 と c4 は同時刻（id の降順で c4 が先）
    { id: "c3", userId: STUDENT, lessonId: LESSON, content: "質問3", parentId: null, createdAt: at(60) },
    { id: "c4", userId: "ins_1", lessonId: LESSON, content: "お知らせ的な質問4", parentId: null, createdAt: at(60) },
    // c1 への返信（古い順：r2 → r1。r3 と r4 は同時刻で id の昇順）
    { id: "r1", userId: "ins_1", lessonId: LESSON, content: "回答1", parentId: "c1", createdAt: at(200) },
    { id: "r2", userId: "stu_gone", lessonId: LESSON, content: "追記", parentId: "c1", createdAt: at(250) },
    { id: "r4", userId: STUDENT, lessonId: LESSON, content: "返信4", parentId: "c1", createdAt: at(100) },
    { id: "r3", userId: STUDENT, lessonId: LESSON, content: "返信3", parentId: "c1", createdAt: at(100) },
    // 別レッスン
    { id: "x1", userId: STUDENT, lessonId: OTHER_LESSON, content: "別レッスンの質問", parentId: null, createdAt: at(1) },
  ];
});

const ctx = (lessonId: string) => ({ params: Promise.resolve({ lessonId }) });
const get = (lessonId = LESSON) => GET(new Request(`https://nwa-lms.example.com/api/comments/${encodeURIComponent(lessonId)}`), ctx(lessonId));

function captureLogs() {
  const logged = mock.method(console, "error", () => {});
  return () => {
    const args = logged.mock.calls.flatMap((c) => c.arguments);
    logged.mock.restore();
    return args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ");
  };
}

function piiError() {
  const err = new Error(`lookup failed for ${DUMMY_EMAIL} (${STUDENT})`);
  Object.assign(err, { code: "P2025", meta: { email: DUMMY_EMAIL, userId: STUDENT } });
  return err;
}

// ───────────── GET ─────────────

describe("GET /api/comments/[lessonId]：認証・入力", () => {
  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    const res = await get();
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  it("user.id のないセッションも 401", async () => {
    session = { user: { role: "STUDENT" } };
    assert.equal((await get()).status, 401);
    assert.equal(calls.length, 0);
  });

  it("lessonId が空なら 400 で、DB を読まない", async () => {
    assert.equal((await get("")).status, 400);
    assert.equal(calls.length, 0);
  });

  it("lessonId が 65 文字なら 400、64 文字なら 200（空配列）", async () => {
    assert.equal((await get("a".repeat(65))).status, 400);
    assert.equal(calls.length, 0);
    const res = await get("a".repeat(64));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

describe("GET /api/comments/[lessonId]：応答", () => {
  it("select は必要な項目だけ（user は name・role・deactivatedAt）", async () => {
    await get();
    const userSelect = { select: { name: true, role: true, deactivatedAt: true } };
    const base = { id: true, content: true, createdAt: true, userId: true, user: userSelect };
    assert.deepEqual(calls[0].args.select, {
      ...base,
      replies: { where: { lessonId: LESSON }, select: base, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    });
    assert.deepEqual(calls[0].args.where, { lessonId: LESSON, parentId: null });
    assert.equal("include" in calls[0].args, false);
  });

  it("親は新しい順（同時刻は id の降順）で take 100、返信は古い順（同時刻は id の昇順）", async () => {
    const body = await (await get()).json();
    assert.deepEqual(calls[0].args.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
    assert.equal(calls[0].args.take, 100);
    assert.deepEqual(body.map((c: { id: string }) => c.id), ["c4", "c3", "c2", "c1"]);
    const c1 = body.find((c: { id: string }) => c.id === "c1");
    assert.deepEqual(c1.replies.map((r: { id: string }) => r.id), ["r2", "r1", "r3", "r4"]);
  });

  it("120 件あっても 100 件まで（新しい方から）", async () => {
    comments = Array.from({ length: 120 }, (_, i) => ({
      id: `m${String(i).padStart(3, "0")}`,
      userId: STUDENT,
      lessonId: LESSON,
      content: `質問${i}`,
      parentId: null,
      createdAt: at(i),
    }));
    const body = await (await get()).json();
    assert.equal(body.length, 100);
    assert.equal(body[0].id, "m000");
    assert.equal(body[99].id, "m099");
  });

  it("別レッスンの質問は含まない", async () => {
    const text = await (await get()).text();
    assert.doesNotMatch(text, /x1|別レッスンの質問/);
  });

  it("名前：受講生は登録名、講師は isInstructor、無効化された受講生は name: null。mine は自分の投稿だけ", async () => {
    const body = await (await get()).json();
    const byId = new Map<string, { author: unknown; mine: boolean }>(body.map((c: { id: string }) => [c.id, c]));
    assert.deepEqual(byId.get("c1")?.author, { name: "受講生エー", isInstructor: false });
    assert.deepEqual(byId.get("c2")?.author, { name: null, isInstructor: false });
    assert.deepEqual(byId.get("c4")?.author, { name: "講師ビー", isInstructor: true });
    assert.deepEqual(body.map((c: { id: string; mine: boolean }) => [c.id, c.mine]), [["c4", false], ["c3", true], ["c2", false], ["c1", true]]);
    const replies = body.find((c: { id: string }) => c.id === "c1").replies;
    assert.deepEqual(
      replies.map((r: { id: string; author: { name: string | null; isInstructor: boolean }; mine: boolean }) => [r.id, r.author.name, r.author.isInstructor, r.mine]),
      [["r2", null, false, false], ["r1", "講師ビー", true, false], ["r3", "受講生エー", false, true], ["r4", "受講生エー", false, true]]
    );
  });

  it("講師が見ると、講師の投稿が mine", async () => {
    session = INSTRUCTOR_SESSION;
    const body = await (await get()).json();
    assert.deepEqual(body.filter((c: { mine: boolean }) => c.mine).map((c: { id: string }) => c.id), ["c4"]);
  });

  it("応答の項目は id / content / createdAt / author / mine / replies だけで、userId・avatar・email・role・deactivatedAt を含まない", async () => {
    const text = await (await get()).text();
    for (const c of JSON.parse(text)) {
      assert.deepEqual(Object.keys(c).sort(), ["author", "content", "createdAt", "id", "mine", "replies"]);
      assert.deepEqual(Object.keys(c.author).sort(), ["isInstructor", "name"]);
      assert.equal(typeof c.createdAt, "string");
      for (const r of c.replies) assert.deepEqual(Object.keys(r).sort(), ["author", "content", "createdAt", "id", "mine"]);
    }
    for (const k of ["userId", "avatar", "email", "role", "deactivatedAt", "password", "example\\.com", STUDENT, "stu_gone", "ins_1", "受講生ゴーン", "INSTRUCTOR", "STUDENT"]) {
      assert.doesNotMatch(text, new RegExp(k), k);
    }
  });
});

describe("GET /api/comments/[lessonId]：エラー", () => {
  it("例外なら 500 で、ログにメールアドレス・ユーザー ID・メッセージを出さない", async () => {
    failWith = piiError();
    const done = captureLogs();
    const res = await get();
    const out = done();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.ok(out.length > 0);
    assert.doesNotMatch(out, /example\.com/);
    assert.doesNotMatch(out, new RegExp(STUDENT));
    assert.doesNotMatch(out, /lookup failed/);
    assert.doesNotMatch(out, /P2025/);
    assert.match(out, /Error/);
  });
});

// ───────────── POST ─────────────

const SEC = 1000;
const HOUR = 60 * 60 * SEC;
const ago = (ms: number) => new Date(BASE - ms);

const post = async (body: unknown, raw?: string) => {
  const req = new Request("https://nwa-lms.example.com/api/comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
  mock.timers.enable({ apis: ["Date"], now: BASE });
  try {
    return await POST(req);
  } finally {
    mock.timers.reset();
  }
};

const writes = () => calls.filter((c) => c.method === "comment.create");
const methods = () => calls.map((c) => c.method);

/** STUDENT の投稿を足す（連投の判定用。別レッスン・別本文） */
function addMine(n: number, at: (i: number) => Date, content: (i: number) => string = (i) => `前の質問${i}`) {
  for (let i = 0; i < n; i++) {
    comments.push({ id: `mine_${i}`, userId: STUDENT, lessonId: OTHER_LESSON, content: content(i), parentId: null, createdAt: at(i) });
  }
}

describe("POST /api/comments：認証・ロール（#46）", () => {
  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    const res = await post({ lessonId: LESSON, content: "質問" });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  it("講師は 403 forbidden_role で、本文を読まず DB も読まない（壊れた JSON でも 403）", async () => {
    session = INSTRUCTOR_SESSION;
    for (const res of [await post({ lessonId: LESSON, content: "回答", parentId: "c1" }), await post(undefined, "{ not json")]) {
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: "Forbidden", reason: "forbidden_role" });
    }
    assert.equal(calls.length, 0);
  });

  it("role のないセッションも 403 forbidden_role（受講生だけが投稿できる）", async () => {
    session = { user: { id: STUDENT } };
    const res = await post({ lessonId: LESSON, content: "質問" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).reason, "forbidden_role");
    assert.equal(calls.length, 0);
  });
});

describe("POST /api/comments：入力", () => {
  it("壊れた JSON は 400 で、DB を読まない", async () => {
    const res = await post(undefined, "{ not json");
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  for (const [label, body, reason] of [
    ["配列", [{ lessonId: LESSON, content: "質問" }], "invalid_body"],
    ["null", null, "invalid_body"],
    ["lessonId なし", { content: "質問" }, "invalid_lesson_id"],
    ["lessonId が空", { lessonId: "", content: "質問" }, "invalid_lesson_id"],
    ["lessonId が数値", { lessonId: 1, content: "質問" }, "invalid_lesson_id"],
    ["lessonId が 65 文字", { lessonId: "a".repeat(65), content: "質問" }, "invalid_lesson_id"],
    ["content なし", { lessonId: LESSON }, "invalid_content"],
    ["content が数値", { lessonId: LESSON, content: 1 }, "invalid_content"],
    ["content が空白だけ", { lessonId: LESSON, content: " \n\t " }, "empty"],
    ["content が見えない文字だけ", { lessonId: LESSON, content: "\u200B\u3164" }, "empty"],
    ["content が 2001 文字", { lessonId: LESSON, content: "あ".repeat(2001) }, "too_long"],
    ["parentId が空文字", { lessonId: LESSON, content: "質問", parentId: "" }, "invalid_parent_id"],
    ["parentId が数値", { lessonId: LESSON, content: "質問", parentId: 1 }, "invalid_parent_id"],
  ] as Array<[string, unknown, string]>) {
    it(`${label} は 400（${reason}）で、DB を読まない`, async () => {
      const res = await post(body);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, reason);
      assert.equal(calls.length, 0);
    });
  }

  it("レッスンが存在しなければ 404 で、書き込まない", async () => {
    const res = await post({ lessonId: "lesson_missing", content: "質問" });
    assert.equal(res.status, 404);
    assert.equal(writes().length, 0);
  });
});

describe("POST /api/comments：受講生の返信は禁止（#46）", () => {
  // 親が存在する・しない・別レッスン・返信、のどれでも同じ応答（他人の投稿の有無を漏らさない）で、DB を読まない
  for (const [label, parentId] of [
    ["自分の質問", "c1"],
    ["他の受講生の質問", "c2"],
    ["存在しない id", "c_missing"],
    ["別レッスンの質問", "x1"],
    ["返信", "r1"],
  ] as Array<[string, string]>) {
    it(`parentId が${label}なら 403 reply_not_allowed で、DB を読まない`, async () => {
      const res = await post({ lessonId: LESSON, content: "返信", parentId });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: "Forbidden", reason: "reply_not_allowed" });
      assert.equal(calls.length, 0);
    });
  }

  it("parentId が null なら親の質問として 201", async () => {
    const res = await post({ lessonId: LESSON, content: "質問", parentId: null });
    assert.equal(res.status, 201);
    assert.equal((writes()[0].args.data as { parentId: unknown }).parentId, null);
  });
});

describe("POST /api/comments：ロック中のコース（#46）", () => {
  it("ロック中のコースのレッスンは 403 course_locked で、書き込まない", async () => {
    const res = await post({ lessonId: LOCKED_LESSON, content: "質問" });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Forbidden", reason: "course_locked" });
    assert.equal(writes().length, 0);
  });

  it("前のコースを全部終えると 201", async () => {
    progress = [
      { userId: STUDENT, lessonId: LESSON, completed: true },
      { userId: STUDENT, lessonId: OTHER_LESSON, completed: true },
    ];
    const res = await post({ lessonId: LOCKED_LESSON, content: "質問" });
    assert.equal(res.status, 201);
    assert.equal((writes()[0].args.data as { lessonId: string }).lessonId, LOCKED_LESSON);
  });

  it("前のコースの完了が一部だけ・未完了（completed: false）・他の受講生の完了では解放されない", async () => {
    progress = [
      { userId: STUDENT, lessonId: LESSON, completed: true },
      { userId: STUDENT, lessonId: OTHER_LESSON, completed: false },
      { userId: "stu_gone", lessonId: OTHER_LESSON, completed: true },
    ];
    const res = await post({ lessonId: LOCKED_LESSON, content: "質問" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).reason, "course_locked");
  });

  it("進捗はセッションのユーザーで読む", async () => {
    await post({ lessonId: LESSON, content: "質問" });
    const p = calls.find((c) => c.method === "progress.findMany");
    assert.ok(p, "progress.findMany が呼ばれていない");
    assert.deepEqual(p.args.where, { userId: STUDENT, completed: true });
  });
});

describe("POST /api/comments：連投（#46）", () => {
  it("自分の直近 24 時間の投稿を新しい順に 20 件まで、本文と日時だけ読む", async () => {
    await post({ lessonId: LESSON, content: "質問" });
    const q = calls.find((c) => c.method === "comment.findMany");
    assert.ok(q, "comment.findMany が呼ばれていない");
    assert.deepEqual(q.args, {
      where: { userId: STUDENT, createdAt: { gt: new Date(BASE - 24 * HOUR) } },
      select: { content: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    });
  });

  it("直前の投稿から 10 秒なら 429（retryAfterSeconds と Retry-After は 20）で、レッスンを読まず書き込まない", async () => {
    addMine(1, () => ago(10 * SEC));
    const res = await post({ lessonId: LESSON, content: "質問" });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "20");
    assert.deepEqual(await res.json(), { error: "Too many requests", reason: "rate_limited", retryAfterSeconds: 20 });
    assert.deepEqual(methods(), ["comment.findMany"]);
  });

  it("直前の投稿からちょうど 30 秒なら 201", async () => {
    addMine(1, () => ago(30 * SEC));
    assert.equal((await post({ lessonId: LESSON, content: "質問" })).status, 201);
  });

  it("続けて 2 回送ると 2 回目は 429（1 回目の投稿で間隔を数える）", async () => {
    assert.equal((await post({ lessonId: LESSON, content: "質問A" })).status, 201);
    const res = await post({ lessonId: LESSON, content: "質問B" });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "30");
    assert.equal(writes().length, 1);
  });

  it("24 時間以内に 20 件なら 429（いちばん古い 1 件が期間外に出るまで）、19 件なら 201", async () => {
    // beforeEach のデータ（c1・c3・r3・r4・x1）は 24 時間以内の自分の投稿なので外す
    comments = comments.filter((c) => c.userId !== STUDENT);
    addMine(20, (i) => ago(HOUR + i * 60 * SEC));
    const res = await post({ lessonId: LESSON, content: "質問" });
    assert.equal(res.status, 429);
    // 20 件目は 1 時間 19 分前 → 残り 22 時間 41 分
    const expected = 24 * 3600 - (3600 + 19 * 60);
    assert.equal(res.headers.get("Retry-After"), String(expected));
    assert.equal((await res.json()).retryAfterSeconds, expected);
    assert.equal(writes().length, 0);

    comments = comments.filter((c) => c.id !== "mine_19");
    assert.equal((await post({ lessonId: LESSON, content: "質問" })).status, 201);
  });

  it("24 時間より前の投稿と、他の人の投稿は数えない", async () => {
    comments = comments.filter((c) => c.userId !== STUDENT);
    addMine(20, (i) => ago(24 * HOUR + i * SEC));
    for (let i = 0; i < 20; i++) {
      comments.push({ id: `other_${i}`, userId: "stu_gone", lessonId: LESSON, content: "質問", parentId: null, createdAt: ago(i * SEC) });
    }
    assert.equal((await post({ lessonId: LESSON, content: "質問" })).status, 201);
  });

  it("60 秒以内に直前と同じ本文（前後の空白を除く）なら 409 duplicate で、書き込まない", async () => {
    addMine(1, () => ago(40 * SEC), () => "同じ質問");
    const res = await post({ lessonId: LESSON, content: "  同じ質問\n" });
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "Conflict", reason: "duplicate" });
    assert.doesNotMatch(text, /同じ質問/);
    assert.deepEqual(methods(), ["comment.findMany"]);
  });

  it("同じ本文でも 60 秒たっていれば 201、別のレッスンでも 60 秒以内なら 409", async () => {
    addMine(1, () => ago(60 * SEC), () => "同じ質問");
    assert.equal((await post({ lessonId: LESSON, content: "同じ質問" })).status, 201);
    comments = comments.filter((c) => c.id !== "mine_0" && !c.id.startsWith("c_new_"));
    addMine(1, () => ago(59 * SEC), () => "同じ質問");
    assert.equal((await post({ lessonId: LOCKED_LESSON, content: "同じ質問" })).status, 409);
  });

  it("他の人の同じ本文は重複にしない", async () => {
    comments.push({ id: "o1", userId: "stu_gone", lessonId: LESSON, content: "同じ質問", parentId: null, createdAt: ago(SEC) });
    assert.equal((await post({ lessonId: LESSON, content: "同じ質問" })).status, 201);
  });
});

describe("POST /api/comments：判定の順（#46）", () => {
  it("連投の判定はレッスンの存在・ロックより先（429 のとき、存在しないレッスンでもロック中でも 429）", async () => {
    addMine(1, () => ago(SEC));
    for (const lessonId of ["lesson_missing", LOCKED_LESSON]) {
      calls = [];
      const res = await post({ lessonId, content: "質問" });
      assert.equal(res.status, 429, lessonId);
      assert.deepEqual(methods(), ["comment.findMany"], lessonId);
    }
  });

  it("返信の禁止は連投の判定より先（DB を読まない）", async () => {
    addMine(1, () => ago(SEC));
    const res = await post({ lessonId: LESSON, content: "返信", parentId: "c1" });
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it("入力検証は返信の禁止より先（不正な本文に parentId があっても 400）", async () => {
    const res = await post({ lessonId: LESSON, content: "", parentId: "c1" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "empty");
  });

  it("通るときの読み取りは、連投 → レッスン → コースと進捗 → 作成 の順", async () => {
    assert.equal((await post({ lessonId: LESSON, content: "質問" })).status, 201);
    assert.deepEqual(methods(), ["comment.findMany", "lesson.findUnique", "course.findMany", "progress.findMany", "comment.create"]);
  });
});

describe("POST /api/comments：作成", () => {
  it("201 で toCommentThreadView の形（replies は空、mine は true）", async () => {
    const res = await post({ lessonId: LESSON, content: "  1行目\n2行目  " });
    assert.equal(res.status, 201);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.deepEqual(body, {
      id: body.id,
      content: "1行目\n2行目",
      createdAt: new Date(BASE).toISOString(),
      author: { name: "受講生エー", isInstructor: false },
      mine: true,
      replies: [],
    });
    for (const k of ["userId", "avatar", "email", "role", "deactivatedAt", "example\\.com", STUDENT]) {
      assert.doesNotMatch(text, new RegExp(k), k);
    }
  });

  it("userId はセッションの値で、body の userId は使わない", async () => {
    const res = await post({ lessonId: LESSON, content: "質問", userId: "ins_1" });
    assert.equal(res.status, 201);
    const data = writes()[0].args.data as Record<string, unknown>;
    assert.deepEqual(data, { userId: STUDENT, lessonId: LESSON, content: "質問", parentId: null });
  });

  it("create の select も必要な項目だけ", async () => {
    await post({ lessonId: LESSON, content: "質問" });
    assert.deepEqual(writes()[0].args.select, {
      id: true,
      content: true,
      createdAt: true,
      userId: true,
      user: { select: { name: true, role: true, deactivatedAt: true } },
    });
  });

  it("2000 文字ちょうどは 201", async () => {
    const res = await post({ lessonId: LESSON, content: "あ".repeat(2000) });
    assert.equal(res.status, 201);
  });
});

describe("POST /api/comments：エラー", () => {
  it("例外なら 500 で、ログにメールアドレス・ユーザー ID・メッセージを出さない", async () => {
    failWith = piiError();
    const done = captureLogs();
    const res = await post({ lessonId: LESSON, content: "質問" });
    const out = done();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.ok(out.length > 0, "ログが出ていない");
    assert.doesNotMatch(out, /example\.com/);
    assert.doesNotMatch(out, new RegExp(STUDENT));
    assert.doesNotMatch(out, /lookup failed/);
    assert.match(out, /Error/);
  });
});
