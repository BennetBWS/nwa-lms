import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";

export default NextAuth(authConfig).auth;

export const config = {
  matcher: [
    "/((?!api/auth|_next|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\.).*)",
  ],
};
