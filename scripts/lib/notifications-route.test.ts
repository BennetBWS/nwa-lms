import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { installFakeAuth, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #32 GET /api/notifications（通知ページ）。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数を記録し、where の userId・orderBy・take・select を最低限だけ再現する）。
// NextAuth は installFakeAuth で差し替える。データはすべてダミー。

type NotificationRow = { id: string; userId: string; title: string; message: string; read: boolean; createdAt: Date };
type Call = { method: string; args: Record<string, unknown> };

const USER = "stu_active";
const OTHER = "stu_other";
const DUMMY_EMAIL = "student@example.com";

let session: FakeSession;
let calls: Call[];
let notifications: NotificationRow[];
let failWith: unknown;
let GET: () => Promise<Response>;

function pick(row: Record<string, unknown>, select: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) if (v === true) out[k] = row[k];
  return out;
}

function sortRows(rows: NotificationRow[], orderBy: unknown): NotificationRow[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, "asc" | "desc">>;
  return [...rows].sort((a, b) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0];
      const av = a[k as keyof NotificationRow];
      const bv = b[k as keyof NotificationRow];
      const an = av instanceof Date ? av.getTime() : av;
      const bn = bv instanceof Date ? bv.getTime() : bv;
      if (an === bn) continue;
      const cmp = an < bn ? -1 : 1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

const fakePrisma = {
  notification: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "notification.findMany", args });
      if (failWith !== undefined) throw failWith;
      const where = (args.where ?? {}) as Record<string, unknown>;
      let rows = notifications.filter((r) => Object.entries(where).every(([k, v]) => r[k as keyof NotificationRow] === v));
      rows = sortRows(rows, args.orderBy);
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      return rows.map((r) => pick(r, args.select as Record<string, unknown> | undefined));
    },
  },
};

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ GET } = await import("../../src/app/api/notifications/route"));
});

const BASE = Date.parse("2026-09-29T12:00:00.000Z");

beforeEach(() => {
  session = STUDENT_SESSION;
  calls = [];
  failWith = undefined;
  notifications = [
    { id: "n1", userId: USER, title: "お知らせ1", message: "本文1", read: true, createdAt: new Date(BASE - 3 * 3600_000) },
    { id: "n2", userId: USER, title: "お知らせ2", message: "本文2", read: false, createdAt: new Date(BASE - 3600_000) },
    // n3 と n4 は同時刻（id の降順で n4 が先）
    { id: "n3", userId: USER, title: "お知らせ3", message: "本文3", read: false, createdAt: new Date(BASE - 2 * 3600_000) },
    { id: "n4", userId: USER, title: "お知らせ4", message: "本文4", read: true, createdAt: new Date(BASE - 2 * 3600_000) },
    { id: "n9", userId: OTHER, title: "他人宛て", message: "他人の本文", read: false, createdAt: new Date(BASE) },
  ];
});

describe("GET /api/notifications：認証", () => {
  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    const res = await GET();
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  it("user.id のないセッションも 401", async () => {
    session = { user: { role: "STUDENT" } };
    const res = await GET();
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
});

describe("GET /api/notifications：レスポンス", () => {
  it("自分の通知だけを返し、他人宛ては含まない", async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.deepEqual(body.map((n: { id: string }) => n.id).sort(), ["n1", "n2", "n3", "n4"]);
    assert.equal((calls[0].args.where as { userId?: string }).userId, USER);
  });

  it("select は id / title / message / read / createdAt の 5 項目で、userId を返さない", async () => {
    const res = await GET();
    const text = await res.text();
    assert.deepEqual(calls[0].args.select, { id: true, title: true, message: true, read: true, createdAt: true });
    for (const n of JSON.parse(text)) {
      assert.deepEqual(Object.keys(n).sort(), ["createdAt", "id", "message", "read", "title"]);
    }
    assert.doesNotMatch(text, /userId/);
    assert.doesNotMatch(text, new RegExp(USER));
  });

  it("createdAt の新しい順、同時刻は id の降順", async () => {
    const body = await (await GET()).json();
    assert.deepEqual(calls[0].args.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
    assert.deepEqual(
      body.map((n: { id: string }) => n.id),
      ["n2", "n4", "n3", "n1"]
    );
  });

  it("60 件あっても 50 件まで（新しい方から）", async () => {
    notifications = Array.from({ length: 60 }, (_, i) => ({
      id: `m${String(i).padStart(2, "0")}`,
      userId: USER,
      title: `お知らせ${i}`,
      message: `本文${i}`,
      read: false,
      createdAt: new Date(BASE - i * 60_000),
    }));
    const body = await (await GET()).json();
    assert.equal(calls[0].args.take, 50);
    assert.equal(body.length, 50);
    assert.equal(body[0].id, "m00");
    assert.equal(body[49].id, "m49");
  });
});

describe("GET /api/notifications：エラー", () => {
  it("例外なら 500 で、ログにメールアドレス・ユーザー ID・メッセージを出さない", async () => {
    const err = new Error(`lookup failed for ${DUMMY_EMAIL} (${USER})`);
    Object.assign(err, { code: "P2025", meta: { email: DUMMY_EMAIL, userId: USER } });
    failWith = err;

    const logged = mock.method(console, "error", () => {});
    const res = await GET();
    const args = logged.mock.calls.flatMap((c) => c.arguments);
    logged.mock.restore();

    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.equal(args.length > 0, true);
    const out = args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ");
    assert.doesNotMatch(out, /example\.com/);
    assert.doesNotMatch(out, new RegExp(USER));
    assert.doesNotMatch(out, /lookup failed/);
    assert.match(out, /Error/);
  });
});
