import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #62 GET /api/notifications/unread-count（サイドバーの未読バッジ）。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数を記録し、where の完全一致だけを再現する）。
// NextAuth は installFakeAuth で差し替える。データはすべてダミー。

type NotificationRow = { id: string; userId: string; read: boolean };
type Call = { method: string; args: Record<string, unknown> };

const USER = "stu_active";
const OTHER = "stu_other";
const DUMMY_EMAIL = "student@example.com";

let session: FakeSession;
let calls: Call[];
let notifications: NotificationRow[];
let failWith: unknown;
let GET: () => Promise<Response>;

function matches(row: NotificationRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => row[k as keyof NotificationRow] === v);
}

const fakePrisma = {
  notification: {
    async count(args: Record<string, unknown>) {
      calls.push({ method: "notification.count", args });
      if (failWith !== undefined) throw failWith;
      const where = (args.where ?? {}) as Record<string, unknown>;
      return notifications.filter((r) => matches(r, where)).length;
    },
  },
};

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ GET } = await import("../../src/app/api/notifications/unread-count/route"));
});

beforeEach(() => {
  session = STUDENT_SESSION;
  calls = [];
  failWith = undefined;
  notifications = [
    { id: "n1", userId: USER, read: true },
    { id: "n2", userId: USER, read: false },
    { id: "n3", userId: USER, read: false },
    { id: "n9", userId: OTHER, read: false },
    { id: "n8", userId: OTHER, read: false },
  ];
});

describe("GET /api/notifications/unread-count：認証", () => {
  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    const res = await GET();
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(calls.length, 0, "401 なのに DB を読んだ");
  });

  it("user.id のないセッションも 401", async () => {
    session = { user: { role: "STUDENT" } };
    const res = await GET();
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0, "401 なのに DB を読んだ");
  });
});

describe("GET /api/notifications/unread-count：件数", () => {
  it("自分の未読だけを数え、既読と他人宛ては数えない", async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { count: 2 });
    assert.equal(calls.length, 1, "count を 1 回だけ呼ぶ");
    assert.equal(calls[0].method, "notification.count");
    assert.deepEqual(calls[0].args, { where: { userId: USER, read: false } });
  });

  it("未読がなければ 0", async () => {
    notifications = notifications.map((n) => (n.userId === USER ? { ...n, read: true } : n));
    assert.deepEqual(await (await GET()).json(), { count: 0 });
  });

  it("50 件を超える未読でも正確な件数を返す（take をかけない）", async () => {
    notifications = Array.from({ length: 73 }, (_, i) => ({ id: `m${i}`, userId: USER, read: false }));
    const body = await (await GET()).json();
    assert.deepEqual(body, { count: 73 });
    assert.equal("take" in calls[0].args, false, "count に take が付いている");
  });

  it("ロールは問わない（講師は講師本人の件数）", async () => {
    session = INSTRUCTOR_SESSION;
    notifications.push({ id: "i1", userId: "ins_1", read: false });
    assert.deepEqual(await (await GET()).json(), { count: 1 });
    assert.deepEqual(calls[0].args, { where: { userId: "ins_1", read: false } });
  });
});

describe("GET /api/notifications/unread-count：エラー", () => {
  it("例外なら 500 で、ログにメールアドレス・ユーザー ID・メッセージを出さない", async () => {
    const err = new Error(`count failed for ${DUMMY_EMAIL} (${USER})`);
    Object.assign(err, { code: "P2025", meta: { email: DUMMY_EMAIL, userId: USER } });
    failWith = err;

    const logged = mock.method(console, "error", () => {});
    const res = await GET();
    const args = logged.mock.calls.flatMap((c) => c.arguments);
    logged.mock.restore();

    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.ok(args.length > 0, "500 のときにログが出ていない");
    const out = args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ");
    assert.doesNotMatch(out, /example\.com/);
    assert.doesNotMatch(out, new RegExp(USER));
    assert.doesNotMatch(out, /count failed/);
    assert.match(out, /Error/);
  });
});

// ───────────── 追加（tester、#62）：他人の通知が多い場合・引数・エラー ─────────────

describe("GET /api/notifications/unread-count：追加", () => {
  it("他人の未読が 60 件あっても、自分が 0 件なら 0", async () => {
    notifications = [
      { id: "n1", userId: USER, read: true },
      ...Array.from({ length: 60 }, (_, i) => ({ id: `o${i}`, userId: OTHER, read: false })),
    ];
    assert.deepEqual(await (await GET()).json(), { count: 0 });
  });

  it("自分の未読 51 件・既読 30 件・他人の未読 40 件なら 51", async () => {
    notifications = [
      ...Array.from({ length: 51 }, (_, i) => ({ id: `u${i}`, userId: USER, read: false })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, userId: USER, read: true })),
      ...Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, userId: OTHER, read: false })),
    ];
    assert.deepEqual(await (await GET()).json(), { count: 51 });
    assert.deepEqual(Object.keys(calls[0].args), ["where"], "count に where 以外（take / skip など）が付いている");
  });

  it("講師は、受講生に未読が多くても講師本人の件数（0 件）だけ", async () => {
    session = INSTRUCTOR_SESSION;
    assert.deepEqual(await (await GET()).json(), { count: 0 });
    assert.deepEqual(calls[0].args, { where: { userId: "ins_1", read: false } });
  });

  it("Error でない値（メールアドレス入りの文字列）が投げられても 500 で、ログと応答に出さない", async () => {
    failWith = `boom ${DUMMY_EMAIL} ${USER}`;
    const logged = mock.method(console, "error", () => {});
    const res = await GET();
    const args = logged.mock.calls.flatMap((c) => c.arguments);
    logged.mock.restore();
    assert.equal(res.status, 500);
    const text = await res.text();
    const out = args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ") + text;
    assert.doesNotMatch(out, /example\.com/);
    assert.doesNotMatch(out, new RegExp(USER));
    assert.doesNotMatch(out, /boom/);
  });
});
