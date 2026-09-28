import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { MIDDLEWARE_MATCHER } from "./middleware-matcher";

// #30：middleware の matcher を、Next.js 自身の変換で正規表現にして判定する。
// client-session.test.ts の近似テスト（"^" + pattern + "$"）を補う。
//
// 使うのは Next.js の内部モジュール（公開 API ではない）：
// - next/dist/build/analysis/get-page-static-info の getMiddlewareMatchers
//   （next build が middleware-manifest.json の matchers を作るときの変換）
// - next/dist/shared/lib/router/utils/middleware-route-matcher の getMiddlewareRouteMatcher
//   （実行時に pathname を matchers と照合する関数）
// どちらも DB・ネットワーク不要。Next.js を更新して場所や形が変わったら、このテストが
// 「内部 API が見つからない」で失敗する。その場合は next build 後の
// .next/server/middleware-manifest.json の matchers を見て、このテストを追従させる。

type Matcher = { regexp: string; originalSource: string };

const requireFromHere = createRequire(__filename);

function loadNext() {
  const staticInfo = requireFromHere("next/dist/build/analysis/get-page-static-info") as {
    getMiddlewareMatchers?: (matcher: string | string[], nextConfig: Record<string, unknown>) => Matcher[];
  };
  const routeMatcher = requireFromHere("next/dist/shared/lib/router/utils/middleware-route-matcher") as {
    getMiddlewareRouteMatcher?: (matchers: Matcher[]) => (pathname: string, req: unknown, query: unknown) => boolean;
  };
  assert.equal(typeof staticInfo.getMiddlewareMatchers, "function", "Next.js 内部 API getMiddlewareMatchers が見つからない");
  assert.equal(typeof routeMatcher.getMiddlewareRouteMatcher, "function", "Next.js 内部 API getMiddlewareRouteMatcher が見つからない");
  return { getMiddlewareMatchers: staticInfo.getMiddlewareMatchers!, getMiddlewareRouteMatcher: routeMatcher.getMiddlewareRouteMatcher! };
}

describe("middleware matcher を Next.js の変換で判定する (#30)", () => {
  const { getMiddlewareMatchers, getMiddlewareRouteMatcher } = loadNext();
  // next.config.mjs は空（basePath / i18n なし）なので nextConfig は {}
  const matchers = getMiddlewareMatchers([MIDDLEWARE_MATCHER], {});
  const matches = getMiddlewareRouteMatcher(matchers);
  // 実行時、Next.js はクエリを除いた pathname を渡す
  const isMiddlewareTarget = (url: string) => matches(new URL(url, "http://localhost:3000").pathname, {}, {});

  it("matcher は 1 件で、元の文字列が MIDDLEWARE_MATCHER", () => {
    assert.equal(matchers.length, 1);
    assert.equal(matchers[0].originalSource, MIDDLEWARE_MATCHER);
  });

  for (const path of ["/", "/login", "/login?callbackUrl=%2F", "/forgot-password", "/reset-password", "/reset-password?token=dummy", "/apiary", "/api-docs", "/apis", "/x/api", "/x/api/y"]) {
    it(`対象：${path}`, () => {
      assert.equal(isMiddlewareTarget(path), true);
    });
  }

  for (const path of [
    "/api",
    "/api/",
    "/api/dashboard",
    "/api/auth/session",
    "/api/auth/csrf",
    "/api/auth/signout",
    "/api/auth/forgot-password",
    "/api/admin/students?status=all",
    "/api/admin/students/s1/deactivate",
    "/_next/static/x.js",
    "/_next/image",
    "/_next/data/build-id/index.json",
    "/favicon.ico",
    "/sitemap.xml",
    "/robots.txt",
    "/logo.png",
  ]) {
    it(`対象外：${path}`, () => {
      assert.equal(isMiddlewareTarget(path), false);
    });
  }

  it("クエリ付きの文字列をそのまま渡しても /api/ 以下は対象外", () => {
    // 実行時に渡るのは pathname だけ（クエリなし）。"/api?x=1" のような文字列は来ないので判定しない
    assert.equal(matches("/api/admin/students?status=all", {}, {}), false);
  });
});
