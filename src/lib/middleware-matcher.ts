/**
 * The path pattern of the middleware (`config.matcher` in src/middleware.ts).
 *
 * Next.js reads `config.matcher` by static analysis of src/middleware.ts and only
 * accepts literals: an imported constant is not recognized, and the default
 * config (every path) would be used instead. So the middleware writes the same
 * string as a literal, and src/lib/client-session.test.ts checks that the two agree.
 *
 * Excluded:
 * - `api(?:/|$)`: `/api` and `/api/...`. API は各ルートの auth() が判定する。
 *   middleware は Cookie を作り直すので API にかけない（#30）。
 *   Pages whose name only starts with "api" (e.g. `/apiary`) are still matched.
 * - `_next`, `favicon.ico`, `sitemap.xml`, `robots.txt`, and any path containing a dot.
 */
export const MIDDLEWARE_MATCHER = "/((?!api(?:/|$)|_next|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\.).*)";
