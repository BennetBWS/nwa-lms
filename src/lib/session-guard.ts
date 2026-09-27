import type { Prisma, PrismaClient, User } from "@prisma/client";
import type { NextAuthConfig } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { safeErrorSummary } from "./safe-error";

/**
 * Immediate revocation of JWT sessions (#11).
 *
 * NextAuth calls `callbacks.jwt` every time a session is read (route handlers'
 * `auth()`, `/api/auth/session`, middleware). On the Node side (src/lib/auth.ts)
 * the jwt callback is replaced by `makeJwtCallback`, which reads the user once by
 * primary key and compares it with the token. Returning `null` ends the session.
 *
 * The token carries `sv` (User.sessionVersion at sign-in). `iat` cannot be used,
 * since NextAuth re-issues the JWT (new `iat`) on every access.
 *
 * The middleware (Edge runtime) keeps using the DB-less jwt of auth.config.ts,
 * so it still lets an old JWT through; all data come from the API, which checks.
 */

export type SessionUserRow = Pick<
  User,
  "deactivatedAt" | "sessionVersion" | "role" | "email" | "name" | "avatar"
>;

export const SESSION_USER_SELECT = {
  deactivatedAt: true,
  sessionVersion: true,
  role: true,
  email: true,
  name: true,
  avatar: true,
} satisfies Prisma.UserSelect;

export type RevokeReason = "missing_id" | "not_found" | "deactivated" | "version" | "role" | "email";

export type TokenEvaluation = { valid: true; token: JWT } | { valid: false; reason: RevokeReason };

/**
 * Compares a (non sign-in) token with the current DB row.
 *
 * Revoked when: no row / deactivated / `token.sv` differs from sessionVersion
 * (a token without `sv`, issued before #11, is revoked too) / role differs /
 * email differs. Otherwise valid; name and picture follow the DB values.
 * The given token is not mutated.
 */
export function evaluateToken(token: JWT, dbUser: SessionUserRow | null): TokenEvaluation {
  if (!dbUser) return { valid: false, reason: "not_found" };
  if (dbUser.deactivatedAt !== null && dbUser.deactivatedAt !== undefined) {
    return { valid: false, reason: "deactivated" };
  }
  if (typeof token.sv !== "number" || token.sv !== dbUser.sessionVersion) {
    return { valid: false, reason: "version" };
  }
  if (token.role !== dbUser.role) return { valid: false, reason: "role" };
  if (token.email !== dbUser.email) return { valid: false, reason: "email" };

  const next: JWT = { ...token };
  if (token.name !== dbUser.name) next.name = dbUser.name;
  if (token.picture !== dbUser.avatar) next.picture = dbUser.avatar;
  return { valid: true, token: next };
}

export type SessionGuardDb = Pick<PrismaClient, "user">;

type JwtCallback = NonNullable<NonNullable<NextAuthConfig["callbacks"]>["jwt"]>;
type JwtParams = Parameters<JwtCallback>[0];

/**
 * Builds the Node-side jwt callback.
 *
 * - Sign-in (`trigger === "signIn"` or `user` present): no DB query. `baseJwt`
 *   (auth.config.ts: id / role) runs, then `sv` is taken from the value returned
 *   by `authorize` (`user.sessionVersion`).
 * - Otherwise: one `user.findUnique` by id, then `evaluateToken`.
 * - Revoked, a token without id, or a DB error (fail-closed): `null`.
 *
 * Logs never contain ids, emails or token contents.
 */
export function makeJwtCallback(db: SessionGuardDb, baseJwt: JwtCallback): JwtCallback {
  return async (params: JwtParams) => {
    const isSignIn = params.trigger === "signIn" || !!params.user;

    const token = await baseJwt(params);
    if (!token) return null;

    if (isSignIn) {
      const sv: unknown = params.user?.sessionVersion;
      // authorize always returns sessionVersion; anything else is refused.
      if (typeof sv !== "number" || !token.id) return null;
      return { ...token, sv };
    }

    if (typeof token.id !== "string" || token.id === "") return null;

    let dbUser: SessionUserRow | null;
    try {
      dbUser = await db.user.findUnique({ where: { id: token.id }, select: SESSION_USER_SELECT });
    } catch (error) {
      console.error("[auth] session check failed:", safeErrorSummary(error).name);
      return null;
    }

    const result = evaluateToken(token, dbUser);
    return result.valid ? result.token : null;
  };
}
