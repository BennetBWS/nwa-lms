import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { authConfig } from "./auth.config";

// #30 で middleware は /api/* にかからなくなった。API の認証・権限は各ルートの auth() だけが頼り。
// ソースを読んで、次を固定する（DB・ネットワークなし）。
// 1. 公開 API（パスワード再設定の 3 件と NextAuth 本体）以外のすべてのハンドラが、最初に auth() を呼び、
//    未ログインを 401 / 403 で返す
// 2. 受講生画面 src/app/page.tsx の API 呼び出しが authFetch 経由になっている
// 3. authConfig.callbacks.authorized（ページ用）の判定

const API_DIR = join(__dirname, "..", "app", "api");
const PAGE = join(__dirname, "..", "app", "page.tsx");

const PUBLIC_ROUTES = new Set([
  "auth/[...nextauth]/route.ts",
  "auth/forgot-password/route.ts",
  "auth/reset-password/route.ts",
  "auth/verify-reset-token/route.ts",
]);

function listRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listRoutes(p));
    else if (name === "route.ts" || name === "route.js") out.push(p);
  }
  return out;
}

/** export async function GET(...) { ... } の本体を、次の export までで切り出す */
function handlerBodies(source: string): Array<{ method: string; body: string }> {
  const re = /export\s+(?:async\s+function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
  const starts: Array<{ method: string; index: number }> = [];
  for (let m = re.exec(source); m; m = re.exec(source)) starts.push({ method: m[1], index: m.index });
  return starts.map((s, i) => ({ method: s.method, body: source.slice(s.index, starts[i + 1]?.index ?? source.length) }));
}

describe("API ルートは各自で認証する（middleware に頼らない、#30）", () => {
  const routes = listRoutes(API_DIR).map((p) => ({ path: p, rel: relative(API_DIR, p).split(sep).join("/") }));

  it("ルートが見つかる（走査の前提）", () => {
    assert.ok(routes.length >= 20, `route.ts が ${routes.length} 件しかない`);
    for (const r of Array.from(PUBLIC_ROUTES)) assert.ok(routes.some((x) => x.rel === r), `公開ルート ${r} が存在しない（一覧を更新する）`);
  });

  for (const { path, rel } of routes) {
    if (PUBLIC_ROUTES.has(rel)) continue;
    it(`${rel}：すべてのハンドラが最初に auth() を呼び、未ログインを 401 / 403 で返す`, () => {
      const source = readFileSync(path, "utf8");
      const handlers = handlerBodies(source);
      assert.ok(handlers.length > 0, "export されたハンドラがない");
      for (const { method, body } of handlers) {
        const authAt = body.indexOf("await auth()");
        assert.ok(authAt >= 0, `${method} が auth() を呼んでいない`);
        // auth() より前に prisma へのアクセスがない
        assert.equal(body.slice(0, authAt).includes("prisma."), false, `${method} が auth() の前に DB を読んでいる`);
        assert.match(body, /status:\s*40[13]\b/, `${method} に 401 / 403 の応答がない`);
      }
    });
  }
});

describe("src/app/page.tsx の API 呼び出しは authFetch 経由 (#30)", () => {
  const source = readFileSync(PAGE, "utf8");
  // 識別子の一部（authFetch / browserFetch / swr の fetcher など）ではない、素の fetch( 呼び出し
  const bareFetch = Array.from(source.matchAll(/(?<![\w$.])fetch\s*\(/g)).map((m) => {
    const line = source.slice(0, m.index).split("\n").length;
    return { line, text: source.split("\n")[line - 1].trim() };
  });

  it("素の fetch( は browserFetch の定義と、fallback の /api/auth/session だけ", () => {
    const unexpected = bareFetch.filter(
      ({ text }) => !/^const browserFetch = \(input, init\) => fetch\(input, init\);$/.test(text) && !/^fetch\("\/api\/auth\/session"/.test(text)
    );
    assert.deepEqual(unexpected, [], JSON.stringify(unexpected));
    assert.equal(bareFetch.length, 2, JSON.stringify(bareFetch));
  });

  it("\"/api/ を含む行はすべて authFetch / useSWR のキー / preload / /api/auth/session のどれか", () => {
    const lines = source.split("\n");
    const offenders = lines
      .map((text, i) => ({ line: i + 1, text: text.trim(), prev: (lines[i - 1] ?? "").trim() }))
      .filter(({ text }) => /["`]\/api\//.test(text))
      .filter(({ text }) => !text.startsWith("//") && !text.startsWith("*"))
      .filter(({ text, prev }) => !/authFetch\(|useSWR|preload\(|"\/api\/auth\/session"/.test(text) && !/useSWR\($/.test(prev));
    assert.deepEqual(offenders, [], JSON.stringify(offenders));
  });

  it("swrFetcher は authFetch を使う", () => {
    const m = /const swrFetcher = async \(url\) => \{([\s\S]*?)\n\};/.exec(source);
    assert.ok(m, "swrFetcher が見つからない");
    assert.match(m[1], /await authFetch\(url\)/);
    assert.equal(/(?<![\w$.])fetch\s*\(/.test(m[1]), false);
  });
});

describe("authConfig.callbacks.authorized（ページ用、#30）", () => {
  const authorized = authConfig.callbacks!.authorized! as unknown as (p: {
    auth: unknown;
    request: { nextUrl: URL };
  }) => unknown;
  const call = (path: string, loggedIn: boolean) =>
    authorized({
      auth: loggedIn ? { user: { role: "STUDENT" } } : null,
      request: { nextUrl: new URL(path, "http://localhost:3000") },
    });

  it("未ログインで / は false（ログイン画面へ）", () => {
    assert.equal(call("/", false), false);
  });

  it("未ログインで公開ページは true", () => {
    for (const p of ["/login", "/forgot-password", "/reset-password", "/reset-password?token=dummy"]) {
      assert.equal(call(p, false), true, p);
    }
  });

  it("ログイン済みで /login はトップへリダイレクト", () => {
    const res = call("/login", true);
    assert.ok(res instanceof Response);
    assert.equal(new URL(res.headers.get("location")!).pathname, "/");
  });

  it("ログイン済みで / は true", () => {
    assert.equal(call("/", true), true);
  });

  it("publicPaths から外した /api/auth/* は（middleware に届けば）未ログインで false になる：matcher で除外していることが前提", () => {
    // middleware は /api/* にかからない（middleware-matcher.next.test.ts）。ここでは authorized 単体の挙動を記録する
    for (const p of ["/api/auth/forgot-password", "/api/auth/verify-reset-token", "/api/auth/reset-password"]) {
      assert.equal(call(p, false), false, p);
    }
  });
});
