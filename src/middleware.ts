import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";

export default NextAuth(authConfig).auth;

// API は各ルートの auth() が判定する。middleware は Cookie を作り直すので API にかけない（#30）。
// The middleware re-issues the session cookie (with a new 30-day expiry) on every request it
// can decode, without checking the DB; running it on API calls brought revoked cookies back.
//
// Keep this literal identical to MIDDLEWARE_MATCHER (src/lib/middleware-matcher.ts): Next.js
// only reads literals here, so the constant cannot be imported. A test checks they match.
export const config = {
  matcher: [
    "/((?!api(?:/|$)|_next|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\.).*)",
  ],
};
