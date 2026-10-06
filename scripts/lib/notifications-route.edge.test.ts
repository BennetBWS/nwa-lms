import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { installFakeAuth, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #32 GET /api/notifications の境界・権限・エラーの追加検査。
// DB・ネットワークなし。prisma は globalThis.prisma に置くこのテスト専用の偽物
// （where の userId 一致・orderBy の複数キー・take・select だけを再現）。データはすべてダミー。

type Row = { id: string; userId: string; title: string; message: string; read: boolean; createdAt: Date };
type Call = { args: Record<string, unknown> };

const USER = "stu_active";
const OTHER = "stu_other";
const DUMMY_EMAIL = "student@example.com";
const BASE = Date.parse("2026-09-29T12:00:00.000Z");

let session: FakeSession;
let authThrows: unknown;
let calls: Call[];
let rows: Row[];
let failWith: unknown;
let GET: () => Promise<Response>;

function sortRows(list: Row[], orderBy: unknown): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, "asc" | "desc">>;
  return [...list].sort((a, b) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0];
      const av = a[k as keyof Row];
      const bv = b[k as keyof Row];
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
      calls.push({ args });
      if (failWith !== undefined) throw failWith;
      const where = (args.where ?? {}) as Record<string, unknown>;
      let out = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k as keyof Row] === v));
      out = sortRows(out, args.orderBy);
      if (typeof args.take === "number") out = out.slice(0, args.take);
      const select = args.select as Record<string, boolean> | undefined;
      return out.map((r) => {
        if (!select) return { ...r };
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(select)) if (v) o[k] = r[k as keyof Row];
        return o;
      });
    },
  },
};

function make(n: number, userId: string, prefix: string, offsetMin = 0): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${String(i).padStart(3, "0")}`,
    userId,
    title: `ダミー${i}`,
    message: `本文${i}`,
    read: i % 2 === 0,
    createdAt: new Date(BASE - (offsetMin + i) * 60_000),
  }));
}

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => {
    if (authThrows !== undefined) throw authThrows;
    return session;
  });
  ({ GET } = await import("../../src/app/api/notifications/route"));
});

beforeEach(() => {
  session = STUDENT_SESSION;
  authThrows = undefined;
  calls = [];
  rows = [];
  failWith = undefined;
});

async function ids(): Promise<string[]> {
  const res = await GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  return body.map((n: { id: string }) => n.id);
}

describe("GET /api/notifications：件数の境界", () => {
  it("0 件なら空配列（200）", async () => {
    assert.deepEqual(await ids(), []);
  });

  it("49 件はすべて返す", async () => {
    rows = make(49, USER, "a");
    assert.equal((await ids()).length, 49);
  });

  it("50 件ちょうどはすべて返す", async () => {
    rows = make(50, USER, "a");
    const got = await ids();
    assert.equal(got.length, 50);
    assert.equal(got[0], "a000");
    assert.equal(got[49], "a049");
  });

  it("51 件なら最も古い 1 件だけ落ちる", async () => {
    rows = make(51, USER, "a");
    const got = await ids();
    assert.equal(got.length, 50);
    assert.ok(!got.includes("a050"));
  });

  it("take は 50 で、DB 側で絞る（取得後に slice しない）", async () => {
    await GET();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.take, 50);
  });
});

describe("GET /api/notifications：並び順", () => {
  it("同時刻が 3 件以上でも id の降順で、境界（50 件目）も決定的", async () => {
    // 新しい 48 件 + 同時刻 4 件（50 件目の境界をまたぐ）
    const t = new Date(BASE - 1000 * 60_000);
    rows = [
      ...make(48, USER, "a"),
      ...["s1", "s3", "s4", "s2"].map((id) => ({ id, userId: USER, title: id, message: "", read: false, createdAt: t })),
    ];
    const got = await ids();
    assert.equal(got.length, 50);
    assert.deepEqual(got.slice(48), ["s4", "s3"]);
  });

  it("並びは createdAt の新しい順で、入力順に依存しない", async () => {
    rows = make(5, USER, "a").reverse();
    assert.deepEqual(await ids(), ["a000", "a001", "a002", "a003", "a004"]);
  });
});

describe("GET /api/notifications：他人のデータ（権限）", () => {
  it("他人の新しい通知が大量にあっても、自分の分は 50 件の枠を奪われない", async () => {
    rows = [...make(80, OTHER, "o"), ...make(3, USER, "a", 500)];
    const got = await ids();
    assert.deepEqual(got, ["a000", "a001", "a002"]);
  });

  it("where は userId だけで、セッションの id を使う（別ユーザーのセッションでは別の結果）", async () => {
    rows = [...make(2, USER, "a"), ...make(2, OTHER, "o")];
    session = { user: { id: OTHER, role: "STUDENT" } };
    assert.deepEqual(await ids(), ["o000", "o001"]);
    assert.deepEqual(calls[0].args.where, { userId: OTHER });
  });

  it("講師のセッションでも自分宛てだけ（受講生の通知は見えない）", async () => {
    rows = make(3, USER, "a");
    session = { user: { id: "ins_1", role: "INSTRUCTOR" } };
    assert.deepEqual(await ids(), []);
    assert.deepEqual(calls[0].args.where, { userId: "ins_1" });
  });

  it("応答に userId・他人の id・メールが含まれない", async () => {
    rows = [...make(3, USER, "a"), ...make(3, OTHER, "o")];
    const text = await (await GET()).text();
    assert.doesNotMatch(text, /userId/);
    assert.doesNotMatch(text, new RegExp(USER));
    assert.doesNotMatch(text, new RegExp(OTHER));
    assert.doesNotMatch(text, /"o\d{3}"/);
    assert.doesNotMatch(text, /example\.com/);
  });

  it("createdAt は ISO 文字列で返り、read は真偽値のまま", async () => {
    rows = make(2, USER, "a");
    const body = await (await GET()).json();
    assert.equal(body[0].createdAt, new Date(BASE).toISOString());
    assert.equal(body[0].read, true);
    assert.equal(body[1].read, false);
  });
});

describe("GET /api/notifications：未認証", () => {
  for (const [label, s] of [
    ["null", null],
    ["user なし", {} as unknown as FakeSession],
    ["id が空文字", { user: { id: "", role: "STUDENT" } }],
  ] as Array<[string, FakeSession]>) {
    it(`セッションが ${label} なら 401 で DB を読まない`, async () => {
      session = s;
      const res = await GET();
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "Unauthorized" });
      assert.equal(calls.length, 0);
    });
  }
});

describe("GET /api/notifications：例外", () => {
  async function capture(): Promise<{ res: Response; out: string }> {
    const logged = mock.method(console, "error", () => {});
    const res = await GET();
    const out = logged.mock.calls
      .flatMap((c) => c.arguments)
      .map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 })))
      .join(" ");
    logged.mock.restore();
    return { res, out };
  }

  it("auth() が例外なら 500 で DB を読まず、ログに個人情報を出さない", async () => {
    authThrows = new Error(`session decode failed for ${DUMMY_EMAIL}`);
    const { res, out } = await capture();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.equal(calls.length, 0);
    assert.doesNotMatch(out, /example\.com|decode failed/);
  });

  it("Error でない値（文字列）を投げられても 500 で、中身をログに出さない", async () => {
    failWith = `raw ${DUMMY_EMAIL} ${USER}`;
    const { res, out } = await capture();
    assert.equal(res.status, 500);
    assert.doesNotMatch(out, /example\.com/);
    assert.doesNotMatch(out, new RegExp(USER));
    assert.match(out, /string/);
  });

  it("stack・meta・cause もログに出さない", async () => {
    const err = new Error("query failed");
    Object.assign(err, { meta: { target: DUMMY_EMAIL }, cause: new Error(`cause ${USER}`) });
    err.stack = `Error: ${DUMMY_EMAIL}\n    at somewhere`;
    failWith = err;
    const { res, out } = await capture();
    assert.equal(res.status, 500);
    assert.doesNotMatch(out, /example\.com|query failed|at somewhere/);
    assert.doesNotMatch(out, new RegExp(USER));
  });

  it("500 の応答本文にも例外の中身を含めない", async () => {
    failWith = new Error(`boom ${DUMMY_EMAIL}`);
    const { res } = await capture();
    const text = await res.text();
    assert.doesNotMatch(text, /example\.com|boom/);
  });
});
