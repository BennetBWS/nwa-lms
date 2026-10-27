import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  DEACTIVATED_EMAIL,
  OTHER_EMAIL,
  USER_EMAIL,
  USER_ID,
  captureConsole,
  findLeaks,
  installFakePrisma,
  jsonRequest,
  type FakePrisma,
  type LogEntry,
} from "./forgot-password-route.test-helpers";

// #87 POST /api/auth/forgot-password：DB に渡せない email は、DB に一度も触れずに
// 「email がない」ときと同じ 400 を返し、トークンもメールも作らない。
// globalThis.prisma は記録用の Proxy で、触れたプロパティを記録してから偽の prisma に渡す。
// メールの環境変数は設定しない（メールの経路に入ると固定文の warn が出るので、それで経路を見分ける）。
// fetch は失敗する偽物に差し替える（ネットワークなし）。見えない文字は \u エスケープで書く。

for (const name of ["RESEND_API_KEY", "MAIL_FROM", "APP_BASE_URL", "MAIL_REPLY_TO", "VERCEL_ENV"]) {
  delete process.env[name];
}

const MAIL_WARN =
  "[forgot-password] Mail sending is not configured (missing: RESEND_API_KEY, MAIL_FROM, APP_BASE_URL). Skipped sending the reset email.";
const REQUIRED = { error: "Email is required" };

let POST: (req: Request) => Promise<Response>;
let fake: FakePrisma;
let touched: string[];
let logs: LogEntry[];
let fetchCalls: number;

/** 差し替える前の globalThis.prisma（after で戻す） */
const prismaBefore = (globalThis as unknown as { prisma?: unknown }).prisma;

before(async () => {
  fake = installFakePrisma();
  const target = fake;
  (globalThis as unknown as { prisma: unknown }).prisma = new Proxy(target, {
    get(t, prop, receiver) {
      touched.push(String(prop));
      return Reflect.get(t, prop, receiver);
    },
  });
  ({ POST } = await import("../../src/app/api/auth/forgot-password/route"));
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.createdTokens.length = 0;
  fake.failWith = undefined;
  touched = [];
  logs = captureConsole();
  fetchCalls = 0;
  mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    throw new Error("network access is not allowed in tests");
  });
});

afterEach(() => {
  mock.restoreAll();
});

after(() => {
  // 差し替えた globalThis.prisma を元に戻す（#87 レビュー 任意 6）
  const g = globalThis as unknown as { prisma?: unknown };
  if (prismaBefore === undefined) delete g.prisma;
  else g.prisma = prismaBefore;
});

const BAD_EMAILS: Array<[string, unknown]> = [
  ["NUL", "a\u0000@example.com"],
  ["登録済みのアドレスの末尾に NUL", `${USER_EMAIL}\u0000`],
  ["上位サロゲートだけ", "a\uD800@example.com"],
  ["下位サロゲートだけ", "\uDC00a@example.com"],
  ["数値", 1],
  ["配列", [USER_EMAIL]],
  ["オブジェクト（Prisma の条件の形）", { contains: "@" }],
  ["null", null],
  ["true", true],
  ["空", ""],
  ["空白だけ", "   "],
  ["255 文字", "a".repeat(243) + "@example.com"],
  ["とても長い", "a".repeat(100_000) + "@example.com"],
];

describe("POST /api/auth/forgot-password：DB に渡せない email（#87）", () => {
  for (const [label, email] of BAD_EMAILS) {
    it(`${label}：DB に触れずに 400 Email is required、トークンもメールも作らない`, async () => {
      const res = await POST(jsonRequest({ email }));
      assert.equal(res.status, 400, `${label}：400`);
      assert.deepEqual(await res.json(), REQUIRED, `${label}：今の 400 の形`);
      assert.deepEqual(touched, [], `${label}：prisma に触れていない`);
      assert.deepEqual(fake.calls, [], `${label}：DB の呼び出しがない`);
      assert.equal(fake.createdTokens.length, 0, `${label}：トークンを作らない`);
      assert.equal(fetchCalls, 0, `${label}：メールを送らない`);
      assert.deepEqual(logs, [], `${label}：ログを出さない（メールの経路に入っていない）`);
    });
  }

  it("email がない・body が JSON の null / 数値 / 配列：同じ 400（500 にならない）", async () => {
    for (const body of [{}, null, 1, "\"a@example.com\"", [USER_EMAIL]]) {
      const res = await POST(jsonRequest(body === null ? "null" : body));
      assert.equal(res.status, 400, `body ${JSON.stringify(body)}：400`);
      assert.deepEqual(await res.json(), REQUIRED, `body ${JSON.stringify(body)}：今の 400 の形`);
    }
    assert.deepEqual(touched, [], "prisma に触れていない");
    assert.deepEqual(logs, [], "ログを出さない");
  });

  it("断った応答は、どの入力でも本文・形が同じ（登録の有無を示さない）", async () => {
    const nul = await POST(jsonRequest({ email: `${USER_EMAIL}\u0000` }));
    const missing = await POST(jsonRequest({}));
    assert.equal(nul.status, missing.status, "status が同じ");
    assert.equal(nul.headers.get("content-type"), missing.headers.get("content-type"), "content-type が同じ");
    assert.equal(await nul.text(), await missing.text(), "本文が同じ");
  });
});

describe("POST /api/auth/forgot-password：正しい email は今までどおり（#87）", () => {
  it("登録済み：200 {success:true}、トークンを 1 つ作り、メールの経路に入る", async () => {
    const res = await POST(jsonRequest({ email: USER_EMAIL }));
    assert.equal(res.status, 200, "200");
    assert.deepEqual(await res.json(), { success: true }, "今の 200 の形");
    assert.ok(touched.includes("user"), "user を読む");
    assert.equal(fake.createdTokens.length, 1, "トークンを 1 つ作る");
    assert.deepEqual(logs, [{ level: "warn", text: MAIL_WARN }], "メールの経路に入る（設定がないので送らない）");
    assert.deepEqual(findLeaks(logs, [fake.createdTokens[0], USER_EMAIL, USER_ID]), [], "ログに値が出ない");
  });

  it("登録のない email・254 文字・絵文字：200 {success:true}（DB は読む）", async () => {
    for (const email of [OTHER_EMAIL, "a".repeat(242) + "@example.com", "a\u{1F600}@example.com"]) {
      touched = [];
      const res = await POST(jsonRequest({ email }));
      assert.equal(res.status, 200, `${email.length} 文字：200`);
      assert.deepEqual(await res.json(), { success: true }, `${email.length} 文字：今の 200 の形`);
      assert.ok(touched.includes("user"), `${email.length} 文字：DB を読む`);
    }
    assert.equal(fake.createdTokens.length, 0, "トークンを作らない");
    assert.deepEqual(logs, [], "ログを出さない");
  });

  it("壊れた JSON は今までどおり 500（#87 では変えない）", async () => {
    const res = await POST(jsonRequest(`{"email":"${USER_EMAIL}"`));
    assert.equal(res.status, 500, "500");
    assert.deepEqual(touched, [], "prisma に触れていない");
  });
});

// ---- 追加（tester、#87）：4 通りの応答と DB の読み込み回数、境界、ヘッダーまで含めた比較 ----

/** status・本文・すべてのヘッダー（名前と値） */
async function shapeOf(res: Response) {
  return { status: res.status, headers: Array.from(res.headers.entries()), body: await res.text() };
}

describe("POST /api/auth/forgot-password：登録あり・なし・無効化済み・断った入力（tester、#87）", () => {
  it("登録あり・なし・無効化済みは status・本文・ヘッダーがすべて同じ。DB の読み書きの回数だけが違う", async () => {
    const results: Array<[string, Awaited<ReturnType<typeof shapeOf>>, string[]]> = [];
    for (const [label, email] of [
      ["登録あり", USER_EMAIL],
      ["登録なし", OTHER_EMAIL],
      ["無効化済み", DEACTIVATED_EMAIL],
    ] as Array<[string, string]>) {
      fake.calls.length = 0;
      const res = await POST(jsonRequest({ email }));
      results.push([label, await shapeOf(res), fake.calls.map((c) => c.method)]);
    }
    for (const [label, shape] of results.slice(1)) {
      assert.deepEqual(shape, results[0][1], `${label}：登録ありと同じ応答`);
    }
    assert.deepEqual(
      results.map(([label, , calls]) => [label, calls]),
      [
        ["登録あり", ["user.findUnique", "passwordReset.updateMany", "passwordReset.create"]],
        ["登録なし", ["user.findUnique"]],
        ["無効化済み", ["user.findUnique"]],
      ],
      "DB の呼び出し（登録ありだけ 3 回。#87 より前からの差）"
    );
  });

  it("断った入力は 0 回で 400。status・本文・ヘッダーは email がないときと同じ（入力だけで決まる）", async () => {
    const missing = await shapeOf(await POST(jsonRequest({})));
    for (const email of [`${USER_EMAIL}\u0000`, `${OTHER_EMAIL}\u0000`, `${DEACTIVATED_EMAIL}\u0000`, { equals: USER_EMAIL }]) {
      const shape = await shapeOf(await POST(jsonRequest({ email })));
      assert.deepEqual(shape, missing, `${JSON.stringify(email)}：email がないときと同じ応答`);
    }
    assert.deepEqual(fake.calls, [], "DB を読まない");
    assert.deepEqual(touched, [], "prisma に触れていない");
  });

  it("逆順のサロゲート・NUL だけ・body が true / JSON の文字列：DB に触れずに 400 Email is required", async () => {
    for (const raw of [
      JSON.stringify({ email: "a\uDE00\uD83D@example.com" }),
      JSON.stringify({ email: "\u0000" }),
      "true",
      '"x"',
    ]) {
      const res = await POST(jsonRequest(raw));
      assert.equal(res.status, 400, `${raw}：400`);
      assert.deepEqual(await res.json(), REQUIRED, `${raw}：今の 400 の形`);
    }
    assert.deepEqual(touched, [], "prisma に触れていない");
    assert.equal(fetchCalls, 0, "メールを送らない");
  });

  it("前後に空白のある email は正規化せずにそのまま DB に渡す（今までどおり、見つからなければ 200）", async () => {
    const res = await POST(jsonRequest({ email: ` ${USER_EMAIL} ` }));
    assert.equal(res.status, 200, "200");
    assert.deepEqual(await res.json(), { success: true }, "今の 200 の形");
    assert.deepEqual(
      fake.calls.map((c) => c.args[0]),
      [{ where: { email: ` ${USER_EMAIL} ` } }],
      "空白付きのまま 1 回だけ読む"
    );
    assert.equal(fake.createdTokens.length, 0, "トークンを作らない");
  });

  it("254 文字の登録済みアドレスなら今までどおりトークンを作る（境界の内側）", async () => {
    const long = "a".repeat(242) + "@example.com";
    assert.equal(long.length, 254, "テストの値の長さが違う");
    const original = fake.user.findUnique;
    fake.user.findUnique = async (args) => {
      fake.calls.push({ method: "user.findUnique", args: [args] });
      return args.where.email === long ? { id: USER_ID, email: long, name: "Dummy", deactivatedAt: null } : null;
    };
    try {
      const res = await POST(jsonRequest({ email: long }));
      assert.equal(res.status, 200, "200");
      assert.equal(fake.createdTokens.length, 1, "トークンを 1 つ作る");
      assert.deepEqual(findLeaks(logs, [fake.createdTokens[0], long, USER_ID]), [], "ログに値が出ない");
    } finally {
      fake.user.findUnique = original;
    }
  });

  it("DB の例外のメッセージに email が入っていても、ログに出ない", async () => {
    fake.failWith = Object.assign(new Error(`Unique constraint failed on email ${USER_EMAIL}`), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    const res = await POST(jsonRequest({ email: USER_EMAIL }));
    assert.equal(res.status, 500, "500");
    assert.deepEqual(findLeaks(logs, [USER_EMAIL]), [], "ログに email が出ない");
  });
});
