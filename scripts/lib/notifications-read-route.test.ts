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
