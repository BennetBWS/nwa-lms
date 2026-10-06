import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #32 GET /api/comments/[lessonId] と POST /api/comments の境界・異常系（comments-route.test.ts の補強）。
// DB・ネットワークなし。prisma は globalThis.prisma に置く小さな偽物で、
// - replies は Prisma のリレーションと同じく parentId だけでたどる（返信の lessonId は見ない）
// - failOn で指定したメソッドだけ例外を投げる
// NextAuth は installFakeAuth で差し替える。データはすべてダミー（example.com）。
// 見えない文字はソースに直接書かず、\u エスケープで書く。

type UserRow = { id: string; email: string; name: string; role: "STUDENT" | "INSTRUCTOR"; avatar: string | null; deactivatedAt: Date | null };
type CommentRow = { id: string; userId: string; lessonId: string; content: string; parentId: string | null; createdAt: Date };
type Call = { method: string; args: Record<string, unknown> };
type Select = Record<string, unknown>;

const STUDENT = "stu_active";
const OTHER_STUDENT = "stu_other";
const LESSON = "lesson_1";
const OTHER_LESSON = "lesson_2";
const BASE = Date.parse("2026-10-06T12:00:00.000Z");
const EMOJI = "\u{1F600}";
const COMBINING_ACUTE = "\u0301";
const ZWSP = "\u200B";

let session: FakeSession;
let calls: Call[];
let users: UserRow[];
let lessons: string[];
let comments: CommentRow[];
let failOn: string | null;
let failWith: unknown;
let GET: (req: Request, ctx: { params: Promise<{ lessonId: string }> }) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;

function projectComment(c: CommentRow, select: Select | undefined): Record<string, unknown> {
  if (!select) return { ...c };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    if (k === "user") {
      const u = users.find((x) => x.id === c.userId);
      assert.ok(u, "user がない");
      const us = (v as { select?: Select }).select;
      const pu: Record<string, unknown> = {};
      for (const [uk, uv] of Object.entries(us ?? {})) if (uv === true) pu[uk] = u[uk as keyof UserRow];
      out.user = us ? pu : { ...u };
      continue;
    }
    if (k === "replies") {
      const spec = v as { select?: Select };
      // Prisma のリレーションと同じく parentId だけでたどる。並びは createdAt 昇順
      out.replies = comments
        .filter((r) => r.parentId === c.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((r) => projectComment(r, spec.select));
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
        .filter((r) => Object.entries(where).every(([k, v]) => r[k as keyof CommentRow] === v))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, typeof args.take === "number" ? args.take : undefined)
        .map((r) => projectComment(r, args.select as Select | undefined));
    },
    async findUnique(args: Record<string, unknown>) {
      calls.push({ method: "comment.findUnique", args });
      maybeFail("comment.findUnique");
      const c = comments.find((x) => x.id === (args.where as { id: string }).id);
      return c ? projectComment(c, args.select as Select | undefined) : null;
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
      return lessons.includes(id) ? { id } : null;
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
  failOn = null;
  failWith = undefined;
  lessons = [LESSON, OTHER_LESSON];
  users = [
    { id: STUDENT, email: "student@example.com", name: "受講生エー", role: "STUDENT", avatar: "a.png", deactivatedAt: null },
    { id: OTHER_STUDENT, email: "other@example.com", name: "受講生シー", role: "STUDENT", avatar: "c.png", deactivatedAt: null },
    { id: "ins_1", email: "teacher@example.com", name: "講師ビー", role: "INSTRUCTOR", avatar: null, deactivatedAt: null },
  ];
  comments = [
    { id: "c1", userId: OTHER_STUDENT, lessonId: LESSON, content: "質問1", parentId: null, createdAt: at(30) },
    { id: "x1", userId: OTHER_STUDENT, lessonId: OTHER_LESSON, content: "別レッスンの質問", parentId: null, createdAt: at(10) },
    { id: "xr1", userId: "ins_1", lessonId: OTHER_LESSON, content: "別レッスンの回答", parentId: "x1", createdAt: at(5) },
  ];
});

const ctx = (lessonId: string) => ({ params: Promise.resolve({ lessonId }) });
const get = (lessonId = LESSON) => GET(new Request(`https://nwa-lms.example.com/api/comments/${encodeURIComponent(lessonId)}`), ctx(lessonId));
const post = (body: unknown, raw?: string) =>
  POST(
    new Request("https://nwa-lms.example.com/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    })
  );
const writes = () => calls.filter((c) => c.method === "comment.create");

/** console の全出力（error / warn / log / info）を集める */
function captureConsole() {
  const spies = (["error", "warn", "log", "info"] as const).map((m) => mock.method(console, m, () => {}));
  return () => {
    const args = spies.flatMap((s) => s.mock.calls.flatMap((c) => c.arguments));
    for (const s of spies) s.mock.restore();
    return { count: args.length, text: args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ") };
  };
}

afterEach(() => mock.restoreAll());

// ───────────── GET ─────────────

describe("GET：他のレッスン・他の人の情報が混ざらない", () => {
  it("別レッスン（lesson_2）を読むと、そのレッスンの質問と返信だけ", async () => {
    const body = await (await get(OTHER_LESSON)).json();
    assert.deepEqual(body.map((c: { id: string }) => c.id), ["x1"]);
    assert.deepEqual(body[0].replies.map((r: { id: string }) => r.id), ["xr1"]);
    assert.doesNotMatch(JSON.stringify(body), /質問1/);
  });

  it("他の受講生の投稿は名前だけ（mine: false）。userId・メールアドレス・avatar は出ない", async () => {
    const text = await (await get()).text();
    const [c1] = JSON.parse(text);
    assert.deepEqual(c1.author, { name: "受講生シー", isInstructor: false });
    assert.equal(c1.mine, false);
    for (const k of [OTHER_STUDENT, "other@example\\.com", "c\\.png", "avatar", "email", "userId"]) assert.doesNotMatch(text, new RegExp(k), k);
  });

  it("mine はセッションの user.id で決まる（同じデータでも見る人で変わる）", async () => {
    session = { user: { id: OTHER_STUDENT, role: "STUDENT" } };
    assert.equal((await (await get()).json())[0].mine, true);
    session = STUDENT_SESSION;
    assert.equal((await (await get()).json())[0].mine, false);
    session = INSTRUCTOR_SESSION;
    assert.equal((await (await get()).json())[0].mine, false);
  });

  it("role が INSTRUCTOR 以外（未知の値）の投稿者は講師にしない", async () => {
    users.push({ id: "u_x", email: "x@example.com", name: "誰か", role: "ADMIN" as "STUDENT", avatar: null, deactivatedAt: null });
    comments.push({ id: "c9", userId: "u_x", lessonId: LESSON, content: "質問9", parentId: null, createdAt: at(1) });
    const body = await (await get()).json();
    assert.deepEqual(body.find((c: { id: string }) => c.id === "c9").author, { name: "誰か", isInstructor: false });
  });

  it("無効化された受講生は返信でも name: null、再有効化（deactivatedAt: null）されれば名前に戻る", async () => {
    comments.push({ id: "r1", userId: OTHER_STUDENT, lessonId: LESSON, content: "追記", parentId: "c1", createdAt: at(20) });
    users[1].deactivatedAt = at(60);
    let body = await (await get()).json();
    assert.equal(body[0].author.name, null);
    assert.equal(body[0].replies[0].author.name, null);
    assert.doesNotMatch(JSON.stringify(body), /受講生シー/);
    users[1].deactivatedAt = null;
    body = await (await get()).json();
    assert.equal(body[0].author.name, "受講生シー");
    assert.equal(body[0].replies[0].author.name, "受講生シー");
  });

  it("返信の返信（既存データ）は応答に含まれない", async () => {
    comments.push({ id: "r1", userId: "ins_1", lessonId: LESSON, content: "回答", parentId: "c1", createdAt: at(20) });
    comments.push({ id: "rr1", userId: STUDENT, lessonId: LESSON, content: "返信の返信", parentId: "r1", createdAt: at(10) });
    const text = await (await get()).text();
    assert.doesNotMatch(text, /rr1|返信の返信/);
    assert.equal("replies" in JSON.parse(text)[0].replies[0], false);
  });

  it(
    "親と別レッスンの lessonId を持つ返信（#32 以前の POST で作られうる既存データ）は含めない",
    { todo: "route は replies を parentId だけでたどるため、別レッスンの返信も親のレッスンに表示される（報告済み）" },
    async () => {
      comments.push({ id: "bad_r", userId: STUDENT, lessonId: OTHER_LESSON, content: "別レッスンとして投稿された返信", parentId: "c1", createdAt: at(20) });
      const text = await (await get()).text();
      assert.doesNotMatch(text, /bad_r/);
    }
  );
});

describe("GET：入力・ログ", () => {
  it("lessonId は Prisma の where にそのまま渡す（パス区切りや SQL らしい文字列も 64 文字以内なら 200 で空）", async () => {
    for (const id of ["../lesson_1", "' OR 1=1 --", "lesson_1%00"]) {
      calls = [];
      const res = await get(id);
      assert.equal(res.status, 200, id);
      assert.deepEqual(await res.json(), []);
      assert.deepEqual(calls[0].args.where, { lessonId: id, parentId: null });
    }
  });

  it("成功時は console に何も出さない", async () => {
    const done = captureConsole();
    await get();
    assert.equal(done().count, 0);
  });

  it("Error 以外（メールアドレスを含む文字列）が投げられても、ログに中身を出さない", async () => {
    failOn = "comment.findMany";
    failWith = "lookup failed for student@example.com";
    const done = captureConsole();
    const res = await get();
    const out = done();
    assert.equal(res.status, 500);
    assert.ok(out.count > 0);
    assert.doesNotMatch(out.text, /example\.com|lookup failed/);
  });
});

// ───────────── POST ─────────────

describe("POST：入力の検証経路", () => {
  for (const [label, raw] of [
    ["空の body", ""],
    ["JSON の文字列", '"質問"'],
    ["JSON の数値", "1"],
  ] as Array<[string, string]>) {
    it(`${label} は 400 で、DB を読まない`, async () => {
      const res = await post(undefined, raw);
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });
  }

  it("400 の応答は error と reason だけで、送った本文を返さない", async () => {
    const res = await post({ lessonId: LESSON, content: `秘密の本文${"あ".repeat(2001)}` });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["error", "reason"]);
    assert.doesNotMatch(text, /秘密の本文/);
  });

  it("parentId が null・なしなら親の検索をしない", async () => {
    for (const body of [{ lessonId: LESSON, content: "質問" }, { lessonId: LESSON, content: "質問", parentId: null }]) {
      calls = [];
      assert.equal((await post(body)).status, 201);
      assert.deepEqual(calls.map((c) => c.method), ["lesson.findUnique", "comment.create"]);
      assert.equal((calls[1].args.data as { parentId: unknown }).parentId, null);
    }
  });

  it("レッスンがなければ、parentId があっても親を読まずに 404", async () => {
    const res = await post({ lessonId: "lesson_missing", content: "返信", parentId: "c1" });
    assert.equal(res.status, 404);
    assert.deepEqual(calls.map((c) => c.method), ["lesson.findUnique"]);
  });

  it("lesson の検索は id だけを select する", async () => {
    await post({ lessonId: LESSON, content: "質問" });
    assert.deepEqual(calls[0].args, { where: { id: LESSON }, select: { id: true } });
  });

  it("別レッスンの返信（xr1）を parentId にしても 400（返信への返信・別レッスンの両方）", async () => {
    const res = await post({ lessonId: OTHER_LESSON, content: "返信", parentId: "xr1" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "invalid_parent_id");
    assert.equal(writes().length, 0);
  });

  it("他の受講生の質問への返信は、同じレッスンなら 201（作成者はセッションのユーザー）", async () => {
    const res = await post({ lessonId: LESSON, content: "返信", parentId: "c1" });
    assert.equal(res.status, 201);
    assert.deepEqual(writes()[0].args.data, { userId: STUDENT, lessonId: LESSON, content: "返信", parentId: "c1" });
    const body = await res.json();
    assert.equal(body.mine, true);
    assert.deepEqual(body.author, { name: "受講生エー", isInstructor: false });
  });

  it("body に userId・id・createdAt・user を入れても data は 4 項目だけ（userId はセッション由来）", async () => {
    const res = await post({
      lessonId: LESSON,
      content: "質問",
      userId: OTHER_STUDENT,
      id: "c_forged",
      createdAt: "2000-01-01T00:00:00.000Z",
      user: { connect: { id: OTHER_STUDENT } },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(writes()[0].args.data, { userId: STUDENT, lessonId: LESSON, content: "質問", parentId: null });
    const body = await res.json();
    assert.notEqual(body.id, "c_forged");
    assert.equal(body.createdAt, new Date(BASE).toISOString());
  });

  it("講師が投稿すると isInstructor: true・mine: true", async () => {
    session = INSTRUCTOR_SESSION;
    const res = await post({ lessonId: LESSON, content: "回答", parentId: "c1" });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.author, { name: "講師ビー", isInstructor: true });
    assert.equal(body.mine, true);
    assert.equal((writes()[0].args.data as { userId: string }).userId, "ins_1");
  });
});

describe("POST：文字数の境界（route 経由）", () => {
  const cases: Array<[string, string, number]> = [
    ["絵文字 2000 個（UTF-16 では 4000）", EMOJI.repeat(2000), 201],
    ["絵文字 2001 個", EMOJI.repeat(2001), 400],
    ["あ 1999 + 絵文字 1（UTF-16 では 2001）", `${"あ".repeat(1999)}${EMOJI}`, 201],
    ["結合文字を含む 2000 コードポイント", `e${COMBINING_ACUTE}`.repeat(1000), 201],
    ["結合文字を含む 2001 コードポイント", `${`e${COMBINING_ACUTE}`.repeat(1000)}x`, 400],
    ["中の CRLF は 2 文字（a 999 + CRLF + a 999 = 2000）", `${"a".repeat(999)}\r\n${"a".repeat(999)}`, 201],
    ["中の CRLF は 2 文字（a 1000 + CRLF + a 999 = 2001）", `${"a".repeat(1000)}\r\n${"a".repeat(999)}`, 400],
    ["前後の CRLF は除く（CRLF + a 2000 + CRLF）", `\r\n${"a".repeat(2000)}\r\n`, 201],
  ];
  for (const [label, content, status] of cases) {
    it(`${label} は ${status}`, async () => {
      const res = await post({ lessonId: LESSON, content });
      assert.equal(res.status, status);
      if (status === 201) {
        assert.equal((writes()[0].args.data as { content: string }).content, content.trim());
      } else {
        assert.equal((await res.json()).reason, "too_long");
        assert.equal(calls.length, 0);
      }
    });
  }
});

describe("POST：エラーとログ", () => {
  for (const method of ["lesson.findUnique", "comment.findUnique", "comment.create"]) {
    it(`${method} の例外は 500 で、ログに本文・メールアドレス・ユーザー ID を出さない`, async () => {
      failOn = method;
      const err = new Error(`failed for student@example.com ${STUDENT}`);
      Object.assign(err, { code: "P2003", meta: { target: "student@example.com" } });
      failWith = err;
      const done = captureConsole();
      const res = await post({ lessonId: LESSON, content: "ログに出したくない本文", parentId: method === "comment.findUnique" ? "c1" : undefined });
      const out = done();
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.equal(calls.at(-1)?.method, method);
      assert.ok(out.count > 0);
      for (const re of [/example\.com/, new RegExp(STUDENT), /ログに出したくない本文/, /failed for/]) assert.doesNotMatch(out.text, re);
    });
  }

  it("成功時・400・404 は console に何も出さない", async () => {
    const done = captureConsole();
    await post({ lessonId: LESSON, content: "質問" });
    await post({ lessonId: LESSON, content: "" });
    await post({ lessonId: "lesson_missing", content: "質問" });
    await post(undefined, "{ bad");
    assert.equal(done().count, 0);
  });

  it("未認証は 401 で、本文を読まない（壊れた JSON でも 401）", async () => {
    session = null;
    const res = await post(undefined, "{ bad");
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
});

describe("見えない文字", () => {
  it("このファイルのソースに見えない文字（ゼロ幅・双方向制御など）を直接書いていない", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(__filename, "utf8");
    assert.doesNotMatch(text, new RegExp("[\\u0300-\\u036F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u3164\\u00A0]", "u"));
    assert.ok(text.includes("\\u200B"));
    assert.equal(ZWSP.length, 1);
  });
});
