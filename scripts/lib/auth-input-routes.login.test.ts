import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

// #87 ログイン：本物の NextAuth（src/lib/auth.ts の handlers）に、CSRF トークンを付けて
// POST /api/auth/callback/credentials を送り、authorize が null を返したときに通常のログイン失敗
// （/login?error=CredentialsSignin&code=credentials への 302、セッションの Cookie なし）になることを確かめる。
// globalThis.prisma は偽物（記録用）。DB・ネットワークなし。AUTH_SECRET はこのプロセスだけのダミー。
// 値はすべてダミー（example.com）。見えない文字は \u エスケープで書く。

const prismaBefore = (globalThis as unknown as { prisma?: unknown }).prisma;

const EMAIL = "student-87-login@example.com";
const OFF_EMAIL = "deactivated-87-login@example.com";
const PASSWORD = "dummy-password-87-login";
const BASE = "http://localhost:3000";
const FAIL_LOCATION = `${BASE}/login?error=CredentialsSignin&code=credentials`;
const SESSION_COOKIE = "authjs.session-token";

type Row = {
  id: string;
  email: string;
  name: string;
  role: string;
  avatar: string | null;
  sessionVersion: number;
  password: string;
  deactivatedAt: Date | null;
};
const hash = bcrypt.hashSync(PASSWORD, 4);
const ROWS: Row[] = [
  { id: "u_87_login", email: EMAIL, name: "Dummy 87", role: "STUDENT", avatar: "/avatars/dummy-87.png", sessionVersion: 7, password: hash, deactivatedAt: null },
  { id: "u_87_off", email: OFF_EMAIL, name: "Dummy 87 Off", role: "STUDENT", avatar: null, sessionVersion: 2, password: hash, deactivatedAt: new Date("2026-09-01T00:00:00Z") },
];

let lookups: unknown[];
let touched: string[];
let logs: string[];
let compares: number;
let handlers: { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response> };
let decode: (p: { token: string; secret: string; salt: string }) => Promise<Record<string, unknown> | null>;
const SECRET = "dummy-auth-secret-for-tests-only-87-000000";
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  for (const k of ["AUTH_SECRET", "AUTH_TRUST_HOST", "AUTH_URL", "NEXTAUTH_URL"]) savedEnv[k] = process.env[k];
  process.env.AUTH_SECRET = SECRET;
  process.env.AUTH_TRUST_HOST = "true";
  delete process.env.AUTH_URL;
  delete process.env.NEXTAUTH_URL;
  const fake = {
    user: {
      async findUnique(args: { where: { email?: unknown; id?: unknown } }) {
        lookups.push(args);
        return ROWS.find((r) => r.email === args.where.email || r.id === args.where.id) ?? null;
      },
    },
  };
  (globalThis as unknown as { prisma: unknown }).prisma = new Proxy(fake, {
    get(t, prop, receiver) {
      touched.push(String(prop));
      return Reflect.get(t, prop, receiver);
    },
  });
  ({ handlers } = (await import("../../src/lib/auth")) as unknown as { handlers: typeof handlers });
  ({ decode } = (await import("next-auth/jwt")) as unknown as { decode: typeof decode });
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  lookups = [];
  touched = [];
  logs = [];
  compares = 0;
  const original = bcrypt.compare.bind(bcrypt);
  mock.method(bcrypt, "compare", async (p: string, h: string) => {
    compares++;
    return original(p, h);
  });
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

async function csrf(): Promise<{ csrfToken: string; cookie: string }> {
  const res = await handlers.GET(new Request(`${BASE}/api/auth/csrf`));
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { csrfToken, cookie };
}

async function login(credentials: Record<string, unknown>): Promise<Response> {
  const { csrfToken, cookie } = await csrf();
  // CSRF の取得では DB を読まない。ここで記録を消し、ログインだけを数える。
  touched = [];
  lookups = [];
  return handlers.POST(
    new Request(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...credentials, csrfToken }),
    })
  );
}

function cookieNames(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split("=")[0]);
}

describe("テストの前提", () => {
  it("このファイルの開始時に globalThis.prisma はない（ほかのテストファイルの Proxy が漏れていない）", () => {
    assert.equal(prismaBefore, undefined, "別のファイルの globalThis.prisma が残っている");
  });
});

describe("NextAuth の Credentials：DB に渡せない入力は通常のログイン失敗（#87）", () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ["email がオブジェクト（Prisma の条件の形）", { email: { contains: "@" }, password: PASSWORD }],
    ["email が配列", { email: [EMAIL], password: PASSWORD }],
    ["email が数値", { email: 1, password: PASSWORD }],
    ["email が true", { email: true, password: PASSWORD }],
    ["email が null", { email: null, password: PASSWORD }],
    ["email が空白だけ", { email: "   ", password: PASSWORD }],
    ["email の末尾に NUL", { email: `${EMAIL}\u0000`, password: PASSWORD }],
    ["email に上位サロゲートだけ", { email: "a\uD800@example.com", password: PASSWORD }],
    ["email に下位サロゲートだけ", { email: "\uDC00a@example.com", password: PASSWORD }],
    ["email に逆順のサロゲート", { email: "a\uDE00\uD83D@example.com", password: PASSWORD }],
    ["email が 255 文字", { email: "a".repeat(243) + "@example.com", password: PASSWORD }],
    ["password が数値", { email: EMAIL, password: 12345678 }],
    ["password が配列", { email: EMAIL, password: [PASSWORD] }],
    ["password がオブジェクト", { email: EMAIL, password: { p: PASSWORD } }],
    ["password が true", { email: EMAIL, password: true }],
    ["password が空", { email: EMAIL, password: "" }],
  ];
  for (const [label, credentials] of BAD) {
    it(`${label}：/login?error=CredentialsSignin に 302、Cookie なし、DB も bcrypt も使わない`, async () => {
      const res = await login(credentials);
      assert.equal(res.status, 302, `${label}：302`);
      assert.equal(res.headers.get("location"), FAIL_LOCATION, `${label}：通常のログイン失敗と同じ行き先`);
      assert.ok(!cookieNames(res).includes(SESSION_COOKIE), `${label}：セッションの Cookie を出さない`);
      assert.deepEqual(touched, [], `${label}：prisma に触れていない`);
      assert.equal(compares, 0, `${label}：bcrypt で比較しない`);
      assert.ok(
        logs.every((l) => l.includes("CredentialsSignin") || l.trim().startsWith("at ") || l.trim() === ""),
        `${label}：CredentialsSignin 以外のログがない（CallbackRouteError になっていない）`
      );
      assert.ok(!logs.some((l) => l.includes(EMAIL) || l.includes(PASSWORD)), `${label}：ログに入力の値が出ない`);
    });
  }

  it("断った入力の応答は、パスワード違い・登録のない email・無効化済みの応答と同じ", async () => {
    const shapes: Array<[string, { status: number; location: string | null; cookies: string[]; body: string }]> = [];
    for (const [label, c] of [
      ["断った入力", { email: { contains: "@" }, password: PASSWORD }],
      ["パスワード違い", { email: EMAIL, password: "wrong-password-87" }],
      ["登録のない email", { email: "nobody-87-login@example.com", password: PASSWORD }],
      ["無効化済み", { email: OFF_EMAIL, password: PASSWORD }],
    ] as Array<[string, Record<string, unknown>]>) {
      const res = await login(c);
      shapes.push([label, { status: res.status, location: res.headers.get("location"), cookies: cookieNames(res), body: await res.text() }]);
    }
    for (const [label, s] of shapes.slice(1)) {
      assert.deepEqual(s, shapes[0][1], `${label}：断った入力と同じ応答`);
    }
  });

  it("form-urlencoded で %00 を含む email も、DB を読まずに通常のログイン失敗", async () => {
    const { csrfToken, cookie } = await csrf();
    touched = [];
    const body = `email=${encodeURIComponent(EMAIL)}%00&password=${encodeURIComponent(PASSWORD)}&csrfToken=${encodeURIComponent(csrfToken)}`;
    const res = await handlers.POST(
      new Request(`${BASE}/api/auth/callback/credentials`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body,
      })
    );
    assert.equal(res.status, 302, "302");
    assert.equal(res.headers.get("location"), FAIL_LOCATION, "通常のログイン失敗");
    assert.deepEqual(touched, [], "prisma に触れていない");
  });
});

describe("NextAuth の Credentials：正しい入力は今までどおり（#87）", () => {
  it("成功：セッションの Cookie を出し、JWT に main と同じ項目（id / role / sv / name / email / picture）が入る", async () => {
    const res = await login({ email: EMAIL, password: PASSWORD });
    assert.equal(res.status, 302, "302");
    assert.equal(res.headers.get("location"), BASE, "callbackUrl（既定はトップ）へ");
    const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    assert.ok(raw, "セッションの Cookie がある");
    assert.equal(lookups.length, 1, "email で 1 回だけ読む");
    assert.deepEqual(lookups[0], { where: { email: EMAIL } }, "email をそのまま渡す");
    assert.equal(compares, 1, "bcrypt で 1 回比較する");

    const token = await decode({ token: raw!.split(";")[0].slice(SESSION_COOKIE.length + 1), secret: SECRET, salt: SESSION_COOKIE });
    assert.ok(token, "JWT を読める");
    const row = ROWS[0];
    assert.equal(token!.sub, row.id, "sub");
    assert.equal(token!.id, row.id, "id");
    assert.equal(token!.role, row.role, "role");
    assert.equal(token!.sv, row.sessionVersion, "sessionVersion（sv）");
    assert.equal(token!.name, row.name, "name");
    assert.equal(token!.email, row.email, "email");
    assert.equal(token!.picture, row.avatar, "avatar（picture）");
    assert.ok(!JSON.stringify(token).includes(row.password), "パスワードのハッシュは JWT に入らない");
  });

  it("パスワード違い・無効化済みは比較してから失敗、登録のない email は比較せずに失敗（main と同じ）", async () => {
    for (const [label, c, expectedCompares] of [
      ["パスワード違い", { email: EMAIL, password: "wrong-password-87" }, 1],
      ["無効化済み（正しいパスワード）", { email: OFF_EMAIL, password: PASSWORD }, 1],
      ["登録のない email", { email: "nobody-87-login@example.com", password: PASSWORD }, 0],
      ["前後に空白のある email（正規化しない）", { email: ` ${EMAIL} `, password: PASSWORD }, 0],
    ] as Array<[string, Record<string, unknown>, number]>) {
      compares = 0;
      const res = await login(c);
      assert.equal(res.headers.get("location"), FAIL_LOCATION, `${label}：通常のログイン失敗`);
      assert.equal(lookups.length, 1, `${label}：DB を 1 回読む`);
      assert.deepEqual(lookups[0], { where: { email: c.email } }, `${label}：email をそのまま渡す`);
      assert.equal(compares, expectedCompares, `${label}：比較の回数`);
      assert.ok(!logs.some((l) => l.includes(EMAIL) || l.includes(PASSWORD)), `${label}：ログに入力の値が出ない`);
    }
  });
});
