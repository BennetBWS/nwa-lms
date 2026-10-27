import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, seed, type FakeDb } from "./student-routes.test-helpers";

// #87 POST /api/auth/reset-password・GET /api/auth/verify-reset-token：DB に渡せない token は、
// DB に一度も触れずに今の「無効なトークン」の応答を返す。
// globalThis.prisma は記録用の Proxy で、触れたプロパティを記録してから偽の DB に渡す。DB・ネットワークなし。
// URL の query はデコードされるため、対になっていないサロゲートは verify には届かない（U+FFFD になる）。
// verify では NUL・長さ・置き換えの結果を確かめる。見えない文字は \u エスケープで書く。値はすべてダミー。

const HOUR = 3600_000;
const NEW_PASSWORD = "dummy-new-password-87";
const GOOD_TOKEN = "0f0e0d0c-0b0a-4908-8706-050403020187";

let db: FakeDb;
let verify: (req: Request) => Promise<Response>;
let reset: (req: Request) => Promise<Response>;
let touched: string[];
let logs: string[];

const verifyReq = (token: string) =>
  new Request(`http://localhost/api/auth/verify-reset-token?token=${encodeURIComponent(token)}`);
const resetReq = (body: unknown) =>
  new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

before(async () => {
  db = createFakeDb();
  const target = db.client;
  (globalThis as unknown as { prisma: unknown }).prisma = new Proxy(target, {
    get(t, prop, receiver) {
      touched.push(String(prop));
      return Reflect.get(t, prop, receiver);
    },
  });
  ({ GET: verify } = await import("../../src/app/api/auth/verify-reset-token/route"));
  ({ POST: reset } = await import("../../src/app/api/auth/reset-password/route"));
});

beforeEach(() => {
  for (const k of ["users", "resets", "progress", "quizAttempts", "comments", "assignments", "notifications", "calls"] as const) {
    db[k].length = 0;
  }
  seed(db);
  db.resets.push({
    id: "r87",
    userId: "stu_active",
    token: GOOD_TOKEN,
    expiresAt: new Date(Date.now() + HOUR),
    used: false,
  });
  touched = [];
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    mock.method(console, level, (...args: unknown[]) => logs.push(args.map(String).join(" ")));
  }
  mock.method(globalThis, "fetch", async () => {
    throw new Error("network access is not allowed in tests");
  });
});

afterEach(() => {
  mock.restoreAll();
});

const BAD_STRING_TOKENS: Array<[string, string]> = [
  ["NUL", "x\u0000"],
  ["正しいトークンの末尾に NUL", `${GOOD_TOKEN}\u0000`],
  ["上位サロゲートだけ", "x\uD800"],
  ["下位サロゲートだけ", "\uDC00x"],
  ["129 文字", "a".repeat(129)],
  ["とても長い", "a".repeat(100_000)],
];

describe("POST /api/auth/reset-password：DB に渡せない token（#87）", () => {
  for (const [label, token] of BAD_STRING_TOKENS) {
    it(`${label}：DB に触れずに 400 Invalid token、パスワードを変えない`, async () => {
      const pw = db.users.find((u) => u.id === "stu_active")!.password;
      const res = await reset(resetReq({ token, newPassword: NEW_PASSWORD }));
      assert.equal(res.status, 400, `${label}：400`);
      assert.deepEqual(await res.json(), { error: "Invalid token" }, `${label}：今の無効なトークンの形`);
      assert.deepEqual(touched, [], `${label}：prisma に触れていない`);
      assert.deepEqual(db.calls, [], `${label}：DB の呼び出しがない`);
      assert.equal(db.users.find((u) => u.id === "stu_active")!.password, pw, `${label}：パスワードは変わらない`);
      assert.deepEqual(logs, [], `${label}：ログを出さない`);
    });
  }

  it("断った応答は、登録のないトークンの応答と同じ", async () => {
    const unknown = await reset(resetReq({ token: "tok-unknown", newPassword: NEW_PASSWORD }));
    const nul = await reset(resetReq({ token: `${GOOD_TOKEN}\u0000`, newPassword: NEW_PASSWORD }));
    assert.equal(nul.status, unknown.status, "status が同じ");
    assert.equal(nul.headers.get("content-type"), unknown.headers.get("content-type"), "content-type が同じ");
    assert.equal(await nul.text(), await unknown.text(), "本文が同じ");
  });

  const NOT_STRINGS: Array<[string, unknown]> = [
    ["数値", 1],
    ["配列", [GOOD_TOKEN]],
    ["オブジェクト", { not: "" }],
    ["null", null],
    ["空", ""],
  ];
  for (const [label, token] of NOT_STRINGS) {
    it(`token が ${label}：DB に触れずに今の 400 Token and new password are required`, async () => {
      const res = await reset(resetReq({ token, newPassword: NEW_PASSWORD }));
      assert.equal(res.status, 400, `${label}：400`);
      assert.deepEqual(await res.json(), { error: "Token and new password are required" }, `${label}：今の 400 の形`);
      assert.deepEqual(touched, [], `${label}：prisma に触れていない`);
    });
    it(`newPassword が ${label}：DB に触れずに 400（500 にならない）`, async () => {
      const res = await reset(resetReq({ token: GOOD_TOKEN, newPassword: token }));
      assert.equal(res.status, 400, `${label}：400`);
      assert.deepEqual(await res.json(), { error: "Token and new password are required" }, `${label}：今の 400 の形`);
      assert.deepEqual(touched, [], `${label}：prisma に触れていない`);
      assert.equal(db.resets.find((r) => r.id === "r87")!.used, false, `${label}：トークンを使わない`);
    });
  }

  it("新しいパスワードの文字は確かめない（ハッシュだけが入る）。長さの規則は今までどおり", async () => {
    const short = await reset(resetReq({ token: GOOD_TOKEN, newPassword: "short" }));
    assert.equal(short.status, 400, "8 文字未満は 400");
    assert.deepEqual(await short.json(), { error: "Password must be at least 8 characters" }, "今の形");
    assert.deepEqual(touched, [], "8 文字未満は prisma に触れない");

    const res = await reset(resetReq({ token: GOOD_TOKEN, newPassword: "pass\u0000word\uD800" }));
    assert.equal(res.status, 200, "NUL・サロゲートを含むパスワードでも 200");
    const stored = db.users.find((u) => u.id === "stu_active")!.password;
    assert.ok(!stored.includes("\u0000") && /^\$2[aby]\$/.test(stored), "ハッシュだけが入る");
  });

  it("正しいトークン（36 文字の UUID）：今までどおり 200 でパスワードを変え、トークンを使う", async () => {
    const before = db.users.find((u) => u.id === "stu_active")!.password;
    const res = await reset(resetReq({ token: GOOD_TOKEN, newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 200, "200");
    assert.deepEqual(await res.json(), { success: true }, "今の 200 の形");
    assert.notEqual(db.users.find((u) => u.id === "stu_active")!.password, before, "パスワードが変わる");
    assert.equal(db.resets.find((r) => r.id === "r87")!.used, true, "トークンを使う");
  });

  it("128 文字の登録のないトークン：DB を読んで 400 Invalid token（境界）", async () => {
    const res = await reset(resetReq({ token: "a".repeat(128), newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 400, "400");
    assert.deepEqual(await res.json(), { error: "Invalid token" }, "今の形");
    assert.ok(touched.includes("passwordReset"), "128 文字は DB を読む");
  });
});

describe("GET /api/auth/verify-reset-token：DB に渡せない token（#87）", () => {
  const INVALID = { valid: false, reason: "Invalid token" };

  for (const [label, token] of [
    ["NUL", "x\u0000"],
    ["正しいトークンの末尾に NUL", `${GOOD_TOKEN}\u0000`],
    ["129 文字", "a".repeat(129)],
    ["とても長い", "a".repeat(100_000)],
  ] as Array<[string, string]>) {
    it(`${label}：DB に触れずに今の Invalid token`, async () => {
      const res = await verify(verifyReq(token));
      assert.equal(res.status, 200, `${label}：今の status`);
      assert.deepEqual(await res.json(), INVALID, `${label}：今の無効なトークンの形`);
      assert.deepEqual(touched, [], `${label}：prisma に触れていない`);
      assert.deepEqual(logs, [], `${label}：ログを出さない`);
    });
  }

  it("%00 を直接書いた query も同じ", async () => {
    const res = await verify(new Request("http://localhost/api/auth/verify-reset-token?token=abc%00"));
    assert.deepEqual(await res.json(), INVALID, "Invalid token");
    assert.deepEqual(touched, [], "prisma に触れていない");
  });

  it("対になっていないサロゲートは query では U+FFFD になって届く（DB は読むが 500 にならない）", async () => {
    for (const q of ["x%ED%A0%80", encodeURIComponent("x�")]) {
      touched = [];
      const res = await verify(new Request(`http://localhost/api/auth/verify-reset-token?token=${q}`));
      assert.equal(res.status, 200, `${q}：200`);
      assert.deepEqual(await res.json(), INVALID, `${q}：Invalid token`);
    }
    const looked = db.calls.filter((c) => c.method === "passwordReset.findUnique");
    for (const c of looked) {
      const t = (c.args[0] as { where: { token: string } }).where.token;
      assert.ok(!/[\uD800-\uDFFF]/.test(t), "DB に届いた値にサロゲートがない");
    }
  });

  it("token がない・空：今の Token is required", async () => {
    for (const url of ["http://localhost/api/auth/verify-reset-token", "http://localhost/api/auth/verify-reset-token?token="]) {
      const res = await verify(new Request(url));
      assert.deepEqual(await res.json(), { valid: false, reason: "Token is required" }, url);
    }
    assert.deepEqual(touched, [], "prisma に触れていない");
  });

  it("正しいトークン：今までどおり valid（DB を読む）", async () => {
    const res = await verify(verifyReq(GOOD_TOKEN));
    assert.deepEqual(await res.json(), { valid: true }, "valid");
    assert.ok(touched.includes("passwordReset"), "DB を読む");
  });

  it("想定外の例外のログはエラー名だけ（token を出さない）", async () => {
    const secret = "0f0e0d0c-0b0a-4908-8706-0504030201ff";
    const original = (db.client.passwordReset as { findUnique: unknown }).findUnique;
    (db.client.passwordReset as { findUnique: unknown }).findUnique = async () => {
      throw Object.assign(new Error(`lookup failed where token = "${secret}"`), {
        name: "PrismaClientKnownRequestError",
        code: "P2000",
      });
    };
    try {
      const res = await verify(verifyReq(secret));
      assert.equal(res.status, 500, "500");
      assert.deepEqual(logs, ["[verify-reset-token] Unexpected error: PrismaClientKnownRequestError"], "固定文とエラー名だけ");
      assert.ok(!logs.some((l) => l.includes(secret)), "ログに token が出ない");
    } finally {
      (db.client.passwordReset as { findUnique: unknown }).findUnique = original;
    }
  });
});
