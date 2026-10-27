import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { authorizeCredentials } from "./account-access";

// #87 ログイン（NextAuth の Credentials の authorize）の本体。未ログインで呼べるので、
// DB に渡せない email・string でない password は DB を読まずに null（通常の失敗と同じ）を返し、
// 例外を投げないことを確かめる。DB の読み込みは差し替え、bcrypt はコストを下げる。
// 見えない文字は \u エスケープで書く。値はすべてダミー（example.com）。

const EMAIL = "student-87@example.com";
const PASSWORD = "dummy-password-87";
const hash = bcrypt.hashSync(PASSWORD, 4);
type U = { id: string; email: string; password: string; deactivatedAt: Date | null };
const active: U = { id: "u_87", email: EMAIL, password: hash, deactivatedAt: null };
const deactivated: U = { ...active, id: "u_87_off", deactivatedAt: new Date("2026-09-01T00:00:00Z") };

let lookups: string[];
let compares: number;
let rows: U[];

const find = async (email: string): Promise<U | null> => {
  lookups.push(email);
  return rows.find((u) => u.email === email) ?? null;
};
const compare = async (p: string, h: string) => {
  compares++;
  return bcrypt.compare(p, h);
};

beforeEach(() => {
  lookups = [];
  compares = 0;
  rows = [active];
});

describe("authorizeCredentials：正しい入力は今までどおり", () => {
  it("正しい email とパスワードなら利用者を返す", async () => {
    assert.equal(await authorizeCredentials({ email: EMAIL, password: PASSWORD }, find, compare), active);
    assert.deepEqual(lookups, [EMAIL], "email をそのまま 1 回だけ読む");
  });

  it("パスワード違い・登録のない email・無効化済みは null", async () => {
    assert.equal(await authorizeCredentials({ email: EMAIL, password: "wrong-password" }, find, compare), null);
    assert.equal(
      await authorizeCredentials({ email: "nobody-87@example.com", password: PASSWORD }, find, compare),
      null
    );
    rows = [deactivated];
    assert.equal(await authorizeCredentials({ email: EMAIL, password: PASSWORD }, find, compare), null);
    assert.equal(lookups.length, 3, "3 回とも DB を読む");
  });

  it("前後の空白は正規化しない（今までどおり、そのまま読む）", async () => {
    assert.equal(await authorizeCredentials({ email: ` ${EMAIL}`, password: PASSWORD }, find, compare), null);
    assert.deepEqual(lookups, [` ${EMAIL}`], "空白付きのまま読む");
  });
});

describe("authorizeCredentials：DB に渡せない入力は DB を読まずに null", () => {
  const BAD: Array<[string, Partial<Record<"email" | "password", unknown>> | undefined]> = [
    ["credentials がない", undefined],
    ["email がない", { password: PASSWORD }],
    ["password がない", { email: EMAIL }],
    ["email が空", { email: "", password: PASSWORD }],
    ["email が空白だけ", { email: "   ", password: PASSWORD }],
    ["email に NUL", { email: "a\u0000@example.com", password: PASSWORD }],
    ["email に上位サロゲートだけ", { email: "a\uD800@example.com", password: PASSWORD }],
    ["email に下位サロゲートだけ", { email: "\uDC00a@example.com", password: PASSWORD }],
    ["email が 255 文字", { email: "a".repeat(243) + "@example.com", password: PASSWORD }],
    ["email が数値", { email: 1, password: PASSWORD }],
    ["email が配列", { email: [EMAIL], password: PASSWORD }],
    ["email がオブジェクト", { email: { contains: "@" }, password: PASSWORD }],
    ["email が null", { email: null, password: PASSWORD }],
    ["password が数値", { email: EMAIL, password: 12345678 }],
    ["password が配列", { email: EMAIL, password: [PASSWORD] }],
    ["password がオブジェクト", { email: EMAIL, password: { p: PASSWORD } }],
    ["password が null", { email: EMAIL, password: null }],
    // 追加（tester、#87）
    ["email が true", { email: true, password: PASSWORD }],
    ["email に逆順のサロゲート", { email: "a\uDE00\uD83D@example.com", password: PASSWORD }],
    ["email が NUL だけ", { email: "\u0000", password: PASSWORD }],
    ["email がとても長い", { email: "a".repeat(100_000) + "@example.com", password: PASSWORD }],
    ["password が空", { email: EMAIL, password: "" }],
    ["password が true", { email: EMAIL, password: true }],
    ["credentials が空のオブジェクト（NextAuth は body がないと {} を渡す）", {}],
  ];
  for (const [label, credentials] of BAD) {
    it(`${label}`, async () => {
      let result: unknown = "not-called";
      await assert.doesNotReject(async () => {
        result = await authorizeCredentials(credentials, find, compare);
      }, `${label}：例外を投げない`);
      assert.equal(result, null, `${label}：null を返す`);
      assert.deepEqual(lookups, [], `${label}：DB を読まない`);
      assert.equal(compares, 0, `${label}：パスワードを比較しない`);
    });
  }

  it("email が 254 文字なら DB を読む（境界）", async () => {
    const email = "a".repeat(242) + "@example.com";
    assert.equal(email.length, 254, "テストの値の長さが違う");
    assert.equal(await authorizeCredentials({ email, password: PASSWORD }, find, compare), null);
    assert.deepEqual(lookups, [email], "254 文字は読む");
  });
});

describe("authorizeCredentials：追加の確認（tester、#87）", () => {
  it("パスワードに NUL・サロゲートが入っていても DB には email だけを渡し、比較して null（例外なし）", async () => {
    const result = await authorizeCredentials({ email: EMAIL, password: "pa\u0000ss\uD800" }, find, compare);
    assert.equal(result, null, "null");
    assert.deepEqual(lookups, [EMAIL], "email で 1 回読む");
    assert.equal(compares, 1, "比較は 1 回");
  });

  it("findUserByEmail が投げた例外は今までどおりそのまま伝わる（握りつぶさない）", async () => {
    const boom = async (): Promise<U | null> => {
      throw new Error("db down");
    };
    await assert.rejects(authorizeCredentials({ email: EMAIL, password: PASSWORD }, boom, compare), /db down/, "例外が伝わる");
  });

  it("auth.ts の authorize が返す項目は main と同じ（id / email / name / role / image=avatar / sessionVersion）", () => {
    const src = readFileSync(path.join(__dirname, "auth.ts"), "utf8");
    const ret = src.slice(src.indexOf("if (!user) return null;"));
    assert.ok(ret.length > 0 && src.includes("if (!user) return null;"), "authorize の return が見つからない");
    const block = ret.slice(ret.indexOf("return {"), ret.indexOf("};") + 2).replace(/\s+/g, " ");
    assert.equal(
      block,
      "return { id: user.id, email: user.email, name: user.name, role: user.role, image: user.avatar, sessionVersion: user.sessionVersion, };",
      "返す項目が変わった"
    );
  });
});

describe("auth.ts の authorize は authorizeCredentials を通す", () => {
  it("credentials を直接 DB に渡していない（auth.ts は next-auth を読み込むため、ソースで確かめる）", () => {
    const src = readFileSync(path.join(__dirname, "auth.ts"), "utf8");
    const body = src.slice(src.indexOf("async authorize("));
    assert.ok(src.includes("async authorize("), "authorize が見つからない");
    assert.ok(/authorizeCredentials\(\s*credentials,/.test(body), "authorize が authorizeCredentials に credentials を渡していない");
    assert.ok(!/credentials\??\.email/.test(src), "credentials.email を直接使っている");
    assert.ok(!/credentials\??\.password/.test(src), "credentials.password を直接使っている");
  });
});
