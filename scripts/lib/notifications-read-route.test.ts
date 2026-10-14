import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #62 POST /api/notifications/read（通知ページで表示した未読を既読にする）。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数を記録し、where の完全一致と id の { in } だけを再現する）。
// NextAuth は installFakeAuth で差し替える。データはすべてダミー。

type NotificationRow = { id: string; userId: string; read: boolean };
type Call = { method: string; args: Record<string, unknown> };
type Where = Record<string, unknown>;

const USER = "stu_active";
const OTHER = "stu_other";
const DUMMY_EMAIL = "student@example.com";
const URL_READ = "http://localhost:3000/api/notifications/read";

let session: FakeSession;
let calls: Call[];
let notifications: NotificationRow[];
let failOn: string | undefined;
let failWith: unknown;
let POST: (request: Request) => Promise<Response>;

function matches(row: NotificationRow, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    const value = row[k as keyof NotificationRow];
    if (typeof v === "object" && v !== null && "in" in v) return (v as { in: unknown[] }).in.includes(value);
    return value === v;
  });
}

function record(method: string, args: Record<string, unknown>) {
  calls.push({ method, args });
  if (failOn === method) throw failWith;
}

const fakePrisma = {
  notification: {
    async updateMany(args: Record<string, unknown>) {
      record("notification.updateMany", args);
      const where = (args.where ?? {}) as Where;
      const data = args.data as Partial<NotificationRow>;
      let count = 0;
      notifications = notifications.map((r) => {
        if (!matches(r, where)) return r;
        count++;
        return { ...r, ...data };
      });
      return { count };
    },
    async count(args: Record<string, unknown>) {
      record("notification.count", args);
      return notifications.filter((r) => matches(r, (args.where ?? {}) as Where)).length;
    },
  },
};

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ POST } = await import("../../src/app/api/notifications/read/route"));
});

beforeEach(() => {
  session = STUDENT_SESSION;
  calls = [];
  failOn = undefined;
  failWith = undefined;
  notifications = [
    { id: "n1", userId: USER, read: true },
    { id: "n2", userId: USER, read: false },
    { id: "n3", userId: USER, read: false },
    { id: "n4", userId: USER, read: false },
    { id: "n9", userId: OTHER, read: false },
  ];
});

function post(body: unknown, raw = false): Promise<Response> {
  return POST(
    new Request(URL_READ, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    })
  );
}

function readOf(id: string): boolean | undefined {
  return notifications.find((n) => n.id === id)?.read;
}

describe("POST /api/notifications/read：認証", () => {
  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    const res = await post({ ids: ["n2"] });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(calls.length, 0, "401 なのに DB を触った");
    assert.equal(readOf("n2"), false);
  });

  it("user.id のないセッションも 401", async () => {
    session = { user: { role: "STUDENT" } };
    const res = await post({ ids: ["n2"] });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0, "401 なのに DB を触った");
  });
});

describe("POST /api/notifications/read：入力", () => {
  const cases: Array<[string, unknown, boolean, string]> = [
    ["JSON でない", "{not json", true, "invalid_body"],
    ["配列", ["n2"], false, "invalid_body"],
    ["null", null, false, "invalid_body"],
    ["ids がない", {}, false, "invalid_ids"],
    ["ids が string", { ids: "n2" }, false, "invalid_ids"],
    ["ids が 0 件", { ids: [] }, false, "invalid_ids"],
    ["ids が 51 件", { ids: Array.from({ length: 51 }, (_, i) => `x${i}`) }, false, "invalid_ids"],
    ["要素が string でない", { ids: ["n2", 3] }, false, "invalid_ids"],
    ["要素が空文字", { ids: [""] }, false, "invalid_ids"],
    ["要素が 65 文字", { ids: ["a".repeat(65)] }, false, "invalid_ids"],
  ];
  for (const [name, body, raw, reason] of cases) {
    it(`${name}は 400 ${reason} で、DB を触らない`, async () => {
      const res = await post(body, raw);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason });
      assert.equal(calls.length, 0, "400 なのに DB を触った");
    });
  }

  it("重複は 1 つにまとめて渡す（重複込みで 51 件でも、除いて 50 件以下なら通る）", async () => {
    const ids = [...Array.from({ length: 49 }, (_, i) => `x${i}`), "n2", "x0"];
    assert.equal(ids.length, 51);
    const res = await post({ ids });
    assert.equal(res.status, 200);
    const where = calls[0].args.where as { id: { in: string[] } };
    assert.equal(where.id.in.length, 50);
    assert.equal(new Set(where.id.in).size, 50);
  });

  it("body の userId は無視し、セッションの userId を使う", async () => {
    const res = await post({ ids: ["n9"], userId: OTHER });
    assert.equal(res.status, 200);
    assert.equal((calls[0].args.where as { userId: string }).userId, USER);
    assert.equal(readOf("n9"), false, "他人の通知が既読になった");
  });
});

describe("POST /api/notifications/read：既読化", () => {
  it("updateMany の where は id の in・セッションの userId・read: false で、data は read: true", async () => {
    await post({ ids: ["n2", "n3"] });
    assert.equal(calls[0].method, "notification.updateMany");
    assert.deepEqual(calls[0].args, {
      where: { id: { in: ["n2", "n3"] }, userId: USER, read: false },
      data: { read: true },
    });
  });

  it("続けて本人の未読件数を数える", async () => {
    await post({ ids: ["n2"] });
    assert.equal(calls.length, 2, "updateMany と count の 2 回だけ");
    assert.equal(calls[1].method, "notification.count");
    assert.deepEqual(calls[1].args, { where: { userId: USER, read: false } });
  });

  it("指定した未読を既読にし、updated と更新後の unreadCount を返す", async () => {
    const res = await post({ ids: ["n2", "n3"] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { updated: 2, unreadCount: 1 });
    assert.equal(readOf("n2"), true);
    assert.equal(readOf("n3"), true);
    assert.equal(readOf("n4"), false, "指定していない未読まで既読になった");
  });

  it("他人の id は更新されず、404 も返さない（updated が 0）", async () => {
    const res = await post({ ids: ["n9"] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { updated: 0, unreadCount: 3 });
    assert.equal(readOf("n9"), false, "他人の通知が既読になった");
  });

  it("自分と他人の id が混ざっていても、自分の分だけ更新する", async () => {
    const res = await post({ ids: ["n2", "n9"] });
    assert.deepEqual(await res.json(), { updated: 1, unreadCount: 2 });
    assert.equal(readOf("n9"), false, "他人の通知が既読になった");
  });

  it("存在しない id は updated に入らない", async () => {
    const res = await post({ ids: ["nope"] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { updated: 0, unreadCount: 3 });
  });

  it("既読の id は updated に入らない（冪等。2 回目は 0）", async () => {
    assert.deepEqual(await (await post({ ids: ["n1", "n2"] })).json(), { updated: 1, unreadCount: 2 });
    assert.deepEqual(await (await post({ ids: ["n1", "n2"] })).json(), { updated: 0, unreadCount: 2 });
  });

  it("ロールは問わない（講師は講師本人の通知だけ）", async () => {
    session = INSTRUCTOR_SESSION;
    notifications.push({ id: "i1", userId: "ins_1", read: false });
    const res = await post({ ids: ["i1", "n2"] });
    assert.deepEqual(await res.json(), { updated: 1, unreadCount: 0 });
    assert.equal((calls[0].args.where as { userId: string }).userId, "ins_1");
    assert.equal(readOf("n2"), false, "受講生の通知が既読になった");
  });

  it("応答は updated と unreadCount だけで、userId や id を含まない", async () => {
    const text = await (await post({ ids: ["n2"] })).text();
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["unreadCount", "updated"]);
    assert.doesNotMatch(text, new RegExp(USER));
  });
});

describe("POST /api/notifications/read：エラー", () => {
  for (const method of ["notification.updateMany", "notification.count"]) {
    it(`${method} の例外なら 500 で、ログにメールアドレス・ユーザー ID・メッセージを出さない`, async () => {
      const err = new Error(`update failed for ${DUMMY_EMAIL} (${USER})`);
      Object.assign(err, { code: "P2025", meta: { email: DUMMY_EMAIL, userId: USER } });
      failOn = method;
      failWith = err;

      const logged = mock.method(console, "error", () => {});
      const res = await post({ ids: ["n2"] });
      const args = logged.mock.calls.flatMap((c) => c.arguments);
      logged.mock.restore();

      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.ok(args.length > 0, "500 のときにログが出ていない");
      const out = args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ");
      assert.doesNotMatch(out, /example\.com/);
      assert.doesNotMatch(out, new RegExp(USER));
      assert.doesNotMatch(out, /update failed/);
      assert.match(out, /Error/);
    });
  }
});

// ───────────── 追加（tester、#62）：境界・混在・冪等・特殊な id ─────────────

function snapshot(): string {
  return JSON.stringify([...notifications].sort((a, b) => a.id.localeCompare(b.id)));
}

describe("POST /api/notifications/read：追加の入力", () => {
  const invalidBody: Array<[string, string]> = [
    ["空の body", ""],
    ["JSON の null", "null"],
    ["JSON の数値", "1"],
    ["JSON の文字列", "\"n2\""],
    ["JSON の true", "true"],
    ["JSON の配列（ids の入れ子）", "[{\"ids\":[\"n2\"]}]"],
  ];
  for (const [name, raw] of invalidBody) {
    it(`${name}は 400 invalid_body で、DB を触らない`, async () => {
      const res = await post(raw, true);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_body" });
      assert.equal(calls.length, 0, "400 なのに DB を触った");
    });
  }

  it("all: true だけでは 400 invalid_ids で、何も既読にしない", async () => {
    const before = snapshot();
    const res = await post({ all: true });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_ids" });
    assert.equal(calls.length, 0, "400 なのに DB を触った");
    assert.equal(snapshot(), before, "通知が変わった");
  });

  it("ids と一緒の all: true・userId は無視し、指定した id だけ既読にする", async () => {
    const res = await post({ ids: ["n2"], all: true, userId: OTHER });
    assert.deepEqual(await res.json(), { updated: 1, unreadCount: 2 });
    assert.deepEqual(calls[0].args, { where: { id: { in: ["n2"] }, userId: USER, read: false }, data: { read: true } });
    assert.equal(readOf("n3"), false, "all: true で全件既読になった");
    assert.equal(readOf("n9"), false, "他人の通知が既読になった");
  });

  it("未認証なら不正な body でも 401（認証を先に見る）", async () => {
    session = null;
    const res = await post("{not json", true);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0, "401 なのに DB を触った");
  });

  it("ids が 1 件・50 件なら DB まで届く", async () => {
    assert.equal((await post({ ids: ["n2"] })).status, 200);
    calls = [];
    const fifty = Array.from({ length: 50 }, (_, i) => `x${i}`);
    assert.equal((await post({ ids: fifty })).status, 200);
    assert.deepEqual((calls[0].args.where as { id: { in: string[] } }).id.in, fifty);
  });

  it("64 文字の id は DB まで届き、65 文字は 400", async () => {
    const id64 = "a".repeat(64);
    notifications.push({ id: id64, userId: USER, read: false });
    assert.deepEqual(await (await post({ ids: [id64] })).json(), { updated: 1, unreadCount: 3 });
    calls = [];
    const res = await post({ ids: [id64, "b".repeat(65)] });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0, "400 なのに DB を触った");
  });

  it("重複込み 51 件以上でも、重複を除いて 51 件なら 400", async () => {
    const ids = [...Array.from({ length: 51 }, (_, i) => `x${i}`), "x0", "x1"];
    const res = await post({ ids });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_ids" });
    assert.equal(calls.length, 0, "400 なのに DB を触った");
  });

  it("同じ id が 10 万個なら 1 件にまとめて 200", async () => {
    const res = await post({ ids: Array(100_000).fill("n2") });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { updated: 1, unreadCount: 2 });
    assert.deepEqual((calls[0].args.where as { id: { in: string[] } }).id.in, ["n2"]);
  });

  it("見えない文字だけの id は 200 で、何も既読にしない", async () => {
    const before = snapshot();
    const res = await post({ ids: ["\u200B", "\u3000", "\uFEFF"] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { updated: 0, unreadCount: 3 });
    assert.equal(snapshot(), before, "通知が変わった");
  });

  it("__proto__・constructor という id でも落ちず、本人のその id だけ既読にする", async () => {
    notifications.push({ id: "__proto__", userId: USER, read: false });
    notifications.push({ id: "constructor", userId: OTHER, read: false });
    const res = await post({ ids: ["__proto__", "constructor"] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { updated: 1, unreadCount: 3 });
    assert.equal(readOf("__proto__"), true);
    assert.equal(readOf("constructor"), false, "他人の通知が既読になった");
  });
});

describe("POST /api/notifications/read：混在と冪等", () => {
  it("自分の未読・自分の既読・他人の未読・存在しない id・重複の混在で updated と unreadCount が正しく、2 回目は同じ状態", async () => {
    notifications.push({ id: "n10", userId: OTHER, read: true });
    const body = { ids: ["n2", "n1", "n9", "nope", "n2", "n3", "n10", "n9"] };

    const first = await (await post(body)).json();
    assert.deepEqual(first, { updated: 2, unreadCount: 1 });
    assert.equal(readOf("n2"), true);
    assert.equal(readOf("n3"), true);
    assert.equal(readOf("n4"), false, "指定していない未読まで既読になった");
    assert.equal(readOf("n9"), false, "他人の通知が既読になった");
    assert.equal(readOf("n10"), true, "他人の既読が変わった");
    assert.deepEqual((calls[0].args.where as { id: { in: string[] } }).id.in, ["n2", "n1", "n9", "nope", "n3", "n10"]);
    const after = snapshot();

    calls = [];
    const second = await (await post(body)).json();
    assert.deepEqual(second, { updated: 0, unreadCount: 1 }, "2 回目の結果が冪等でない");
    assert.equal(snapshot(), after, "2 回目で通知が変わった");
  });

  it("他人の id だけを繰り返し送っても、他人の通知も本人の件数も変わらない", async () => {
    const before = snapshot();
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await (await post({ ids: ["n9"] })).json(), { updated: 0, unreadCount: 3 });
    }
    assert.equal(snapshot(), before, "通知が変わった");
  });

  it("他人（OTHER）のセッションでは、受講生 USER の通知を既読にできない", async () => {
    session = { user: { id: OTHER, role: "STUDENT" } };
    const res = await post({ ids: ["n2", "n3", "n4", "n9"] });
    assert.deepEqual(await res.json(), { updated: 1, unreadCount: 0 });
    for (const id of ["n2", "n3", "n4"]) assert.equal(readOf(id), false, `${id} が他人のセッションで既読になった`);
  });
});

describe("POST /api/notifications/read：追加のエラー", () => {
  it("Error でない値（メールアドレス入りの文字列）が投げられても 500 で、ログに出さない", async () => {
    failOn = "notification.updateMany";
    failWith = `boom ${DUMMY_EMAIL} ${USER}`;
    const logged = mock.method(console, "error", () => {});
    const res = await post({ ids: ["n2"] });
    const args = logged.mock.calls.flatMap((c) => c.arguments);
    logged.mock.restore();

    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    const out = args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ");
    assert.doesNotMatch(out, /example\.com/);
    assert.doesNotMatch(out, new RegExp(USER));
    assert.doesNotMatch(out, /boom/);
  });

  it("500 の応答本文にメッセージ・ユーザー ID を含めない", async () => {
    failOn = "notification.count";
    failWith = new Error(`count failed for ${DUMMY_EMAIL} (${USER})`);
    const logged = mock.method(console, "error", () => {});
    const text = await (await post({ ids: ["n2"] })).text();
    logged.mock.restore();
    assert.doesNotMatch(text, /example\.com|count failed/);
    assert.doesNotMatch(text, new RegExp(USER));
  });
});
