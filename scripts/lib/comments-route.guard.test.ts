import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { isCourseLocked } from "../../src/lib/course-lock";

// #46 POST /api/comments の制限（ロール・返信・ロック・連投）の境界と、拒否応答に余計な情報が出ないこと。
// comments-route.test.ts / comments-route.edge.test.ts の補強。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （comment.findMany の where は等号と createdAt の gt、orderBy は createdAt desc → id desc、take を再現）。
// failOn で指定したメソッドだけ例外を投げる。現在時刻は mock.timers で BASE に固定する。
// NextAuth は installFakeAuth で差し替える。データはすべてダミー（example.com）。
// 見えない文字・全角空白はソースに直接書かず、\u エスケープで書く。

type UserRow = { id: string; email: string; name: string; role: "STUDENT" | "INSTRUCTOR"; deactivatedAt: Date | null };
type CommentRow = { id: string; userId: string; lessonId: string; content: string; parentId: string | null; createdAt: Date };
type Call = { method: string; args: Record<string, unknown> };
type Select = Record<string, unknown>;
type CourseRow = { id: string; order: number; lessons: string[] };
type ProgressRow = { userId: string; lessonId: string; completed: boolean };

const STUDENT = "stu_active";
const OTHER_STUDENT = "stu_other";
const BASE = Date.parse("2026-10-06T12:00:00.000Z");
const SEC = 1000;
const HOUR = 60 * 60 * SEC;
const IDEOGRAPHIC_SPACE = "\u3000";
const NBSP = "\u00A0";
const ZWSP = "\u200B";

let session: FakeSession;
let calls: Call[];
let users: UserRow[];
let courses: CourseRow[];
let progress: ProgressRow[];
let comments: CommentRow[];
let failOn: string | null;
let failWith: unknown;
let POST: (req: Request) => Promise<Response>;

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
    const c = cond as Record<string, unknown>;
    if (Object.keys(c).length === 1 && c.gt instanceof Date) return actual instanceof Date && actual.getTime() > c.gt.getTime();
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return actual === cond;
}

function projectComment(c: CommentRow, select: Select | undefined): Record<string, unknown> {
  if (!select) return { ...c };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    if (k === "user") {
      const u = users.find((x) => x.id === c.userId);
      assert.ok(u, "user がない");
      const us = (v as { select: Select }).select;
      const pu: Record<string, unknown> = {};
      for (const [uk, uv] of Object.entries(us)) if (uv === true) pu[uk] = u[uk as keyof UserRow];
      out.user = pu;
      continue;
    }
    out[k] = c[k as keyof CommentRow];
  }
  return out;
}

function maybeFail(method: string) {
  if (failOn === method) throw failWith;
}

const fakePrisma = {
  comment: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "comment.findMany", args });
      maybeFail("comment.findMany");
      const where = (args.where ?? {}) as Record<string, unknown>;
      return comments
        .filter((r) => Object.entries(where).every(([k, v]) => matchValue(r[k as keyof CommentRow], v)))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .slice(0, typeof args.take === "number" ? args.take : undefined)
        .map((r) => projectComment(r, args.select as Select | undefined));
    },
    async findUnique(args: Record<string, unknown>) {
      calls.push({ method: "comment.findUnique", args });
      maybeFail("comment.findUnique");
      return null;
    },
    async create(args: Record<string, unknown>) {
      calls.push({ method: "comment.create", args });
      maybeFail("comment.create");
      const data = args.data as Omit<CommentRow, "id" | "createdAt">;
      const row: CommentRow = { id: `c_new_${comments.length}`, createdAt: new Date(BASE), ...data };
      comments.push(row);
      return projectComment(row, args.select as Select | undefined);
    },
  },
  lesson: {
    async findUnique(args: Record<string, unknown>) {
      calls.push({ method: "lesson.findUnique", args });
      maybeFail("lesson.findUnique");
      const id = (args.where as { id: string }).id;
      const course = courses.find((c) => c.lessons.includes(id));
      return course ? { section: { courseId: course.id } } : null;
    },
  },
  course: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "course.findMany", args });
      maybeFail("course.findMany");
      return [...courses]
        .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((c) => ({ id: c.id, sections: [{ lessons: c.lessons.map((id) => ({ id })) }] }));
    },
  },
  progress: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "progress.findMany", args });
      maybeFail("progress.findMany");
      const where = args.where as { userId: string; completed: boolean };
      return progress.filter((p) => p.userId === where.userId && p.completed === where.completed).map((p) => ({ lessonId: p.lessonId }));
    },
  },
};

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ POST } = await import("../../src/app/api/comments/route"));
});

beforeEach(() => {
  session = STUDENT_SESSION;
  calls = [];
  failOn = null;
  failWith = undefined;
  // course_1（最初・ロックなし）→ course_2 → course_3
  courses = [
    { id: "course_1", order: 1, lessons: ["l1a", "l1b"] },
    { id: "course_2", order: 2, lessons: ["l2a", "l2b"] },
    { id: "course_3", order: 3, lessons: ["l3a"] },
  ];
  progress = [];
  users = [
    { id: STUDENT, email: "student@example.com", name: "受講生エー", role: "STUDENT", deactivatedAt: null },
    { id: OTHER_STUDENT, email: "other@example.com", name: "受講生シー", role: "STUDENT", deactivatedAt: null },
  ];
  // 他の受講生の投稿（拒否応答に漏れないことを確かめる）
  comments = [{ id: "o_secret", userId: OTHER_STUDENT, lessonId: "l1a", content: "他人の秘密の質問", parentId: null, createdAt: new Date(BASE - 2 * SEC) }];
});

afterEach(() => mock.restoreAll());

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
const ago = (ms: number) => new Date(BASE - ms);
const methods = () => calls.map((c) => c.method);
const writes = () => calls.filter((c) => c.method === "comment.create");

let seq = 0;
function addMine(createdAt: Date, content = `前の質問${seq}`) {
  comments.push({ id: `mine_${String(seq++).padStart(4, "0")}`, userId: STUDENT, lessonId: "l1b", content, parentId: null, createdAt });
}

/** 429 なら Retry-After ヘッダーと本文の retryAfterSeconds が一致することを確かめ、その秒数を返す */
async function retryAfterOf(res: Response): Promise<number> {
  assert.equal(res.status, 429, "429 ではない");
  const text = await res.text();
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ["error", "reason", "retryAfterSeconds"]);
  assert.equal(body.reason, "rate_limited");
  assert.ok(Number.isInteger(body.retryAfterSeconds) && body.retryAfterSeconds >= 1, `retryAfterSeconds が 1 以上の整数でない: ${text}`);
  assert.equal(res.headers.get("Retry-After"), String(body.retryAfterSeconds));
  return body.retryAfterSeconds;
}

// ───────────── 429 の境界 ─────────────

describe("POST /api/comments：429 の境界（#46）", () => {
  it("直前の投稿から 29.999 秒なら 429（残り 1 ミリ秒を切り上げて 1 秒）", async () => {
    addMine(ago(29_999));
    assert.equal(await retryAfterOf(await post({ lessonId: "l1a", content: "質問" })), 1);
    assert.deepEqual(methods(), ["comment.findMany"]);
  });

  it("直前の投稿から 30.000 秒なら 201", async () => {
    addMine(ago(30_000));
    assert.equal((await post({ lessonId: "l1a", content: "質問" })).status, 201);
  });

  it("直前の投稿から 0 ミリ秒（同時刻）なら 429 で 30 秒", async () => {
    addMine(ago(0));
    assert.equal(await retryAfterOf(await post({ lessonId: "l1a", content: "質問" })), 30);
  });

  it("24 時間以内に 19 件なら 201、20 件目を足すと 429", async () => {
    for (let i = 0; i < 19; i++) addMine(ago(HOUR + i * SEC));
    assert.equal((await post({ lessonId: "l1a", content: "質問" })).status, 201);
    comments = comments.filter((c) => !c.id.startsWith("c_new_"));
    addMine(ago(2 * HOUR));
    // 20 件目（いちばん古い）は 2 時間前 → 残り 22 時間
    assert.equal(await retryAfterOf(await post({ lessonId: "l1a", content: "質問" })), 22 * 3600);
  });

  it("20 件のうちいちばん古い 1 件がちょうど 24 時間前なら数えない（201）", async () => {
    for (let i = 0; i < 19; i++) addMine(ago(HOUR + i * SEC));
    addMine(ago(24 * HOUR));
    assert.equal((await post({ lessonId: "l1a", content: "質問" })).status, 201);
    const q = calls.find((c) => c.method === "comment.findMany");
    assert.ok(q, "comment.findMany が呼ばれていない");
    assert.deepEqual((q.args.where as { createdAt: unknown }).createdAt, { gt: new Date(BASE - 24 * HOUR) });
  });

  it("いちばん古い 1 件が 24 時間前の 1 ミリ秒後なら 429 で、残り 1 ミリ秒を切り上げて 1 秒", async () => {
    for (let i = 0; i < 19; i++) addMine(ago(HOUR + i * SEC));
    addMine(ago(24 * HOUR - 1));
    assert.equal(await retryAfterOf(await post({ lessonId: "l1a", content: "質問" })), 1);
  });

  it("直前の投稿が未来の日時（時計のずれ）なら 429 で 30 秒（経過 0 秒として扱う）", async () => {
    addMine(new Date(BASE + 5 * SEC));
    assert.equal(await retryAfterOf(await post({ lessonId: "l1a", content: "質問" })), 30);
  });

  it("未来の日時の投稿で 20 件に達しても、Retry-After は 24 時間を超えない", async () => {
    for (let i = 0; i < 20; i++) addMine(new Date(BASE + HOUR + i * SEC));
    const s = await retryAfterOf(await post({ lessonId: "l1a", content: "質問" }));
    assert.ok(s <= 24 * 3600, `24 時間を超えている: ${s}`);
  });

  it("間隔と日上限の両方にかかるときは長い方（日上限）で、ヘッダーと本文が一致する", async () => {
    addMine(ago(5 * SEC));
    for (let i = 1; i < 20; i++) addMine(ago(i * HOUR));
    // 20 件目は 19 時間前 → 残り 5 時間（間隔の残り 25 秒より長い）
    assert.equal(await retryAfterOf(await post({ lessonId: "l1a", content: "質問" })), 5 * 3600);
  });

  it("両方にかかり、日上限の残りの方が短いときは間隔の残り", async () => {
    addMine(ago(5 * SEC));
    for (let i = 1; i < 20; i++) addMine(ago(24 * HOUR - 10 * SEC + i));
    // 日上限の残りは約 10 秒、間隔の残りは 25 秒
    assert.equal(await retryAfterOf(await post({ lessonId: "l1a", content: "質問" })), 25);
  });

  it("429 の本文に前回の本文・他人の投稿・userId を含めない", async () => {
    addMine(ago(5 * SEC), "前回の秘密の本文");
    const res = await post({ lessonId: "l1a", content: "質問" });
    const text = await res.clone().text();
    await retryAfterOf(res);
    for (const re of [/前回の秘密の本文/, /他人の秘密の質問/, new RegExp(STUDENT), new RegExp(OTHER_STUDENT), /example\.com/, /createdAt/]) {
      assert.doesNotMatch(text, re);
    }
  });
});

// ───────────── 409 の境界 ─────────────

describe("POST /api/comments：409 の境界（#46）", () => {
  it("同じ本文で 59.999 秒なら 409、60.000 秒なら 201", async () => {
    addMine(ago(59_999), "同じ質問");
    assert.equal((await post({ lessonId: "l1a", content: "同じ質問" })).status, 409);
    comments = comments.filter((c) => !c.id.startsWith("mine_"));
    addMine(ago(60_000), "同じ質問");
    assert.equal((await post({ lessonId: "l1a", content: "同じ質問" })).status, 201);
  });

  for (const [label, sent] of [
    ["前後の半角空白・改行・タブ", ` \n\t同じ質問\t\n `],
    ["前後の全角空白", `${IDEOGRAPHIC_SPACE}同じ質問${IDEOGRAPHIC_SPACE}`],
    ["前後のノーブレークスペース", `${NBSP}同じ質問${NBSP}`],
    ["前後の CRLF", `\r\n同じ質問\r\n`],
  ] as Array<[string, string]>) {
    it(`${label}だけが違う本文は 409`, async () => {
      addMine(ago(40 * SEC), "同じ質問");
      const res = await post({ lessonId: "l1a", content: sent });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "Conflict", reason: "duplicate" });
      assert.equal(writes().length, 0);
    });
  }

  for (const [label, sent] of [
    ["文中の半角空白", "同じ 質問"],
    ["文中の全角空白", `同じ${IDEOGRAPHIC_SPACE}質問`],
    ["文中の改行", "同じ\n質問"],
    ["文中のゼロ幅スペース", `同じ${ZWSP}質問`],
    ["末尾のゼロ幅スペース（trim の対象外）", `同じ質問${ZWSP}`],
  ] as Array<[string, string]>) {
    it(`${label}が違う本文は重複にしない（40 秒後なら 201、10 秒後なら 409 ではなく 429）`, async () => {
      addMine(ago(40 * SEC), "同じ質問");
      assert.equal((await post({ lessonId: "l1a", content: sent })).status, 201);
      comments = comments.filter((c) => c.userId !== STUDENT);
      calls = [];
      addMine(ago(10 * SEC), "同じ質問");
      assert.equal(await retryAfterOf(await post({ lessonId: "l1a", content: sent })), 20);
    });
  }

  it("他の受講生の 1 秒前の同じ本文は重複にしない（自分の投稿は 40 秒前の別の本文）", async () => {
    addMine(ago(40 * SEC), "自分の別の質問");
    comments.push({ id: "o_same", userId: OTHER_STUDENT, lessonId: "l1a", content: "同じ質問", parentId: null, createdAt: ago(SEC) });
    assert.equal((await post({ lessonId: "l1a", content: "同じ質問" })).status, 201);
  });

  it("直前ではない過去の同じ本文（50 秒前）は重複にしない（直前は 40 秒前の別の本文）", async () => {
    addMine(ago(50 * SEC), "同じ質問");
    addMine(ago(40 * SEC), "別の質問");
    assert.equal((await post({ lessonId: "l1a", content: "同じ質問" })).status, 201);
  });

  it("直前ではない過去の同じ本文は、間隔にかかれば 429（409 ではない）", async () => {
    addMine(ago(50 * SEC), "同じ質問");
    addMine(ago(10 * SEC), "別の質問");
    assert.equal(await retryAfterOf(await post({ lessonId: "l1a", content: "同じ質問" })), 20);
  });

  it("重複は 429 より優先（間隔と日上限の両方にかかっていても 409）", async () => {
    addMine(ago(5 * SEC), "同じ質問");
    for (let i = 1; i < 20; i++) addMine(ago(i * HOUR));
    const res = await post({ lessonId: "l1a", content: "同じ質問" });
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("Retry-After"), null);
  });

  it("409 の本文は error と reason だけで、前回の本文・他人の投稿・userId を含まない", async () => {
    addMine(ago(5 * SEC), "前回の秘密の本文");
    const res = await post({ lessonId: "l1a", content: "前回の秘密の本文" });
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "Conflict", reason: "duplicate" });
    for (const re of [/前回の秘密の本文/, /他人の秘密の質問/, new RegExp(STUDENT), /createdAt/]) assert.doesNotMatch(text, re);
  });
});

// ───────────── 拒否応答の中身 ─────────────

describe("POST /api/comments：拒否応答に余計な情報を含めない（#46）", () => {
  const forbidden = [/他人の秘密の質問/, new RegExp(STUDENT), new RegExp(OTHER_STUDENT), /example\.com/, /course_\d/, /受講生/];

  it("403 course_locked の本文は error と reason だけ（コース id・レッスン id を含まない）", async () => {
    const res = await post({ lessonId: "l2a", content: "質問" });
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "Forbidden", reason: "course_locked" });
    for (const re of [...forbidden, /l2a/]) assert.doesNotMatch(text, re);
  });

  it("404 の本文は error だけ（送ったレッスン id を返さない）", async () => {
    const res = await post({ lessonId: "lesson_missing", content: "質問" });
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "Lesson not found" });
    for (const re of [...forbidden, /lesson_missing/]) assert.doesNotMatch(text, re);
  });

  it("reply_not_allowed は親が存在する・しない・他人の投稿・別レッスンで、ステータス・ヘッダー・本文が完全に同じ", async () => {
    const seen: string[] = [];
    for (const [parentId, lessonId] of [["o_secret", "l1a"], ["c_missing", "l1a"], ["o_secret", "l3a"], ["c_missing", "lesson_missing"]]) {
      const res = await post({ lessonId, content: "返信", parentId });
      assert.equal(res.status, 403);
      seen.push(JSON.stringify({ text: await res.text(), ct: res.headers.get("content-type"), ra: res.headers.get("retry-after") }));
    }
    assert.equal(new Set(seen).size, 1, `応答が異なる: ${seen.join(" / ")}`);
    assert.equal(calls.length, 0);
  });

  it("403 forbidden_role の本文は error と reason だけ", async () => {
    session = { user: { id: "ins_1", role: "INSTRUCTOR" } };
    const text = await (await post({ lessonId: "l1a", content: "質問" })).text();
    assert.deepEqual(JSON.parse(text), { error: "Forbidden", reason: "forbidden_role" });
  });
});

// ───────────── ロールと判定の順 ─────────────

describe("POST /api/comments：ロール（#46）", () => {
  for (const role of ["student", "Student", "STUDENT ", "ADMIN", "INSTRUCTOR", "", "null"]) {
    it(`role が ${JSON.stringify(role)} なら 403 forbidden_role で、DB を読まない`, async () => {
      session = { user: { id: STUDENT, role } };
      const res = await post({ lessonId: "l1a", content: "質問" });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).reason, "forbidden_role");
      assert.equal(calls.length, 0);
    });
  }

  it("role が STUDENT でも user.id が空文字なら 401 で、DB を読まない", async () => {
    session = { user: { id: "", role: "STUDENT" } };
    assert.equal((await post({ lessonId: "l1a", content: "質問" })).status, 401);
    assert.equal(calls.length, 0);
  });

  it("ADMIN が壊れた JSON・parentId 付きで送っても 403 forbidden_role（入力より先）", async () => {
    session = { user: { id: STUDENT, role: "ADMIN" } };
    for (const res of [await post(undefined, "{ bad"), await post({ lessonId: "l1a", content: "返信", parentId: "o_secret" })]) {
      assert.equal(res.status, 403);
      assert.equal((await res.json()).reason, "forbidden_role");
    }
    assert.equal(calls.length, 0);
  });
});

describe("POST /api/comments：判定の順と読み取り（#46）", () => {
  it("ロック中の 403 では、連投 → レッスン → コースと進捗まで読み、書き込まない", async () => {
    const res = await post({ lessonId: "l2a", content: "質問" });
    assert.equal(res.status, 403);
    assert.deepEqual(methods(), ["comment.findMany", "lesson.findUnique", "course.findMany", "progress.findMany"]);
  });

  it("409 / 429 ではレッスン・コース・進捗を読まない", async () => {
    addMine(ago(5 * SEC), "同じ質問");
    assert.equal((await post({ lessonId: "l2a", content: "同じ質問" })).status, 409);
    assert.deepEqual(methods(), ["comment.findMany"]);
    calls = [];
    assert.equal((await post({ lessonId: "l2a", content: "別の質問" })).status, 429);
    assert.deepEqual(methods(), ["comment.findMany"]);
  });

  it("連投の読み取りはセッションの userId で、本文と日時だけ（他人の投稿は対象外）", async () => {
    await post({ lessonId: "l1a", content: "質問" });
    const q = calls.find((c) => c.method === "comment.findMany");
    assert.ok(q, "comment.findMany が呼ばれていない");
    assert.equal((q.args.where as { userId: string }).userId, STUDENT);
    assert.deepEqual(q.args.select, { content: true, createdAt: true });
  });
});

// ───────────── ロック ─────────────

describe("POST /api/comments：ロック（#46）", () => {
  it("前のコースの一部だけ完了なら次のコースは 403、全部完了なら 201", async () => {
    progress = [{ userId: STUDENT, lessonId: "l1a", completed: true }];
    assert.equal((await post({ lessonId: "l2a", content: "質問" })).status, 403);
    progress.push({ userId: STUDENT, lessonId: "l1b", completed: true });
    assert.equal((await post({ lessonId: "l2a", content: "質問" })).status, 201);
  });

  it("completed: false の進捗と、他の受講生の完了では解放されない", async () => {
    progress = [
      { userId: STUDENT, lessonId: "l1a", completed: false },
      { userId: STUDENT, lessonId: "l1b", completed: false },
      { userId: OTHER_STUDENT, lessonId: "l1a", completed: true },
      { userId: OTHER_STUDENT, lessonId: "l1b", completed: true },
    ];
    const res = await post({ lessonId: "l2a", content: "質問" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).reason, "course_locked");
  });

  it("前のコースが未完了でも、そのコースのレッスンを 1 件でも完了していれば同じコースの別レッスンに投稿できる", async () => {
    progress = [{ userId: STUDENT, lessonId: "l2b", completed: true }];
    assert.equal((await post({ lessonId: "l2a", content: "質問" })).status, 201);
  });

  it("2 つ前のコースを終えていなくても、直前のコースを全部終えていれば解放", async () => {
    progress = [
      { userId: STUDENT, lessonId: "l2a", completed: true },
      { userId: STUDENT, lessonId: "l2b", completed: true },
    ];
    assert.equal((await post({ lessonId: "l3a", content: "質問" })).status, 201);
  });

  it("レッスン 0 件のコースの次のコースは、未着手ならロック（course-lock の定義どおり）", async () => {
    courses = [
      { id: "course_1", order: 1, lessons: ["l1a"] },
      { id: "course_empty", order: 2, lessons: [] },
      { id: "course_3", order: 3, lessons: ["l3a"] },
    ];
    progress = [{ userId: STUDENT, lessonId: "l1a", completed: true }];
    assert.equal(isCourseLocked({ completedLessons: 0, totalLessons: 0 }, { completedLessons: 0, totalLessons: 1 }), true);
    assert.equal((await post({ lessonId: "l3a", content: "質問" })).status, 403);
  });

  it("最初のコースは何も完了していなくても 201", async () => {
    assert.equal((await post({ lessonId: "l1b", content: "質問" })).status, 201);
  });
});

// ───────────── 例外とログ ─────────────

describe("POST /api/comments：クエリの例外（#46）", () => {
  class PrismaClientKnownRequestError extends Error {
    code = "P2024";
    meta = { target: "student@example.com" };
    constructor(message: string) {
      super(message);
      this.name = "PrismaClientKnownRequestError";
    }
  }

  for (const method of ["comment.findMany", "lesson.findUnique", "course.findMany", "progress.findMany", "comment.create"]) {
    it(`${method} の例外は 500 で、ログはエラー名だけ（本文・メッセージ・code・meta を出さない）`, async () => {
      failOn = method;
      failWith = new PrismaClientKnownRequestError(`timeout for ${STUDENT} student@example.com`);
      const logged = mock.method(console, "error", () => {});
      const res = await post({ lessonId: "l1a", content: "ログに出したくない本文" });
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.ok(calls.some((c) => c.method === method), `${method} が呼ばれていない`);
      assert.deepEqual(logged.mock.calls.map((c) => c.arguments), [["POST /api/comments error:", "PrismaClientKnownRequestError"]]);
    });
  }

  it("Error 以外（文字列）が投げられてもログは型名だけ", async () => {
    failOn = "comment.create";
    failWith = `failed ${STUDENT}`;
    const logged = mock.method(console, "error", () => {});
    assert.equal((await post({ lessonId: "l1a", content: "質問" })).status, 500);
    assert.deepEqual(logged.mock.calls.map((c) => c.arguments), [["POST /api/comments error:", "string"]]);
  });
});

describe("見えない文字", () => {
  it("このファイルのソースに見えない文字・全角空白を直接書いていない", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(__filename, "utf8");
    assert.doesNotMatch(text, new RegExp("[\\u00A0\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u3000\\uFEFF]", "u"));
  });
});

// ───────────── #86 本文の NUL・対になっていないサロゲート ─────────────

describe("POST /api/comments：本文に NUL・対になっていないサロゲートがあれば 400 invalid_characters（#86）", () => {
  // body の JSON の中では \u エスケープの形で送る（ソースの文字列はバックスラッシュ u。生の文字は入れない）
  const RAW: Array<[string, string]> = [
    ["\\u0000", '{"lessonId":"l1a","content":"質問\\u0000です"}'],
    ["\\ud800（上位だけ）", '{"lessonId":"l1a","content":"質問\\ud800です"}'],
    ["\\udc00（下位だけ）", '{"lessonId":"l1a","content":"質問\\udc00です"}'],
    ["\\ude00\\ud83d（逆順）", '{"lessonId":"l1a","content":"質問\\ude00\\ud83dです"}'],
    ["\\u0000 だけ", '{"lessonId":"l1a","content":"\\u0000"}'],
    ["上限超え + \\u0000", `{"lessonId":"l1a","content":"${"あ".repeat(2001)}\\u0000"}`],
    ["parentId 付き + \\ud800（reply_not_allowed より先）", '{"lessonId":"l1a","content":"質問\\ud800","parentId":"o_secret"}'],
  ];
  for (const [label, raw] of RAW) {
    it(`${label}：400 で、DB に一度も触れない（create もレート制限の読み込みもしない）`, async () => {
      assert.ok(!raw.includes("\u0000") && !/[\uD800-\uDFFF]/.test(raw), `ソースの JSON に生の文字が入っている：${label}`);
      const before = comments.length;
      const res = await post(undefined, raw);
      assert.equal(res.status, 400, label);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_characters" }, label);
      assert.deepEqual(methods(), [], `DB を読んだ・書いた：${methods().join(",")}`);
      assert.equal(comments.length, before, "保存していない");
    });
  }

  it("JSON.stringify で送った場合（対になっていないサロゲートは \\u エスケープになる）も 400", async () => {
    for (const content of ["質問\u0000です", "質問\uD800です", "質問\uDC00です"]) {
      const res = await post({ lessonId: "l1a", content });
      assert.equal(res.status, 400, JSON.stringify(content));
      assert.equal((await res.json()).reason, "invalid_characters", JSON.stringify(content));
    }
    assert.deepEqual(methods(), [], "DB に触れた");
  });

  it("講師は本文より先に 403 forbidden_role（判定の順は変えない）", async () => {
    session = { user: { id: "ins_1", role: "INSTRUCTOR" } };
    const res = await post(undefined, '{"lessonId":"l1a","content":"\\u0000"}');
    assert.equal(res.status, 403);
    assert.equal((await res.json()).reason, "forbidden_role");
    assert.deepEqual(methods(), [], "DB に触れた");
  });

  it("正しいサロゲートペア（\\ud83d\\ude00）は 201 で、本文をそのまま保存する", async () => {
    const res = await post(undefined, '{"lessonId":"l1a","content":"質問\\ud83d\\ude00です"}');
    assert.equal(res.status, 201);
    assert.equal(writes().length, 1, "保存していない");
    assert.equal((writes()[0].args.data as { content: string }).content, "質問\u{1F600}です");
  });
});
