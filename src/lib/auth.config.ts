import type { NextAuthConfig } from "next-auth";

export const authConfig: NextAuthConfig = {
  pages: {
    signIn: "/login",
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const { pathname } = nextUrl;

      // Pages only: /api/* is outside the middleware matcher (#30), so the API
      // routes (including /api/auth/*) never reach this callback.
      const publicPaths = [
        "/login",
        "/forgot-password",
        "/reset-password",
      ];
      const isPublic = publicPaths.some((p) => pathname.startsWith(p));

      if (pathname.startsWith("/login")) {
        if (isLoggedIn) return Response.redirect(new URL("/", nextUrl));
        return true;
      }

      if (isPublic) return true;
      if (!isLoggedIn) return false;
      return true;
    },
    // Edge (middleware) jwt: does NOT read the DB, so a revoked JWT still passes the
    // middleware (pages only; the page then detects the revoked session through
    // /api/auth/session and goes to /login, #30). On the Node side (src/lib/auth.ts) this callback is wrapped by
    // makeJwtCallback (src/lib/session-guard.ts), which checks the DB on every
    // access (#11). Do not import prisma here: this file is loaded by the middleware.
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.role = token.role;
        session.user.id = token.id;
      }
      return session;
    },
  },
  providers: [], // Added in auth.ts
  session: {
    strategy: "jwt",
  },
};
