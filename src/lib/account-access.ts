/**
 * Account access checks shared by sign-in and password reset (#7).
 *
 * A deactivated account (`deactivatedAt` set) is treated exactly like a wrong
 * password / an invalid token, so responses do not reveal that the account
 * exists but is deactivated.
 */
import { isValidEmailInput } from "./auth-input";

export function isDeactivated(user: { deactivatedAt: Date | null }): boolean {
  return user.deactivatedAt !== null && user.deactivatedAt !== undefined;
}

export type PasswordCompare = (plain: string, hash: string) => Promise<boolean>;

/**
 * Credentials check used by NextAuth `authorize`.
 *
 * The password is compared first, then the deactivation state, so a deactivated
 * account with the right password takes the same path (and returns the same
 * null) as a wrong password.
 */
export async function checkCredentials<U extends { password: string; deactivatedAt: Date | null }>(
  user: U | null,
  password: string,
  compare: PasswordCompare
): Promise<U | null> {
  if (!user) return null;

  const isValid = await compare(password, user.password);
  if (!isValid) return null;

  if (isDeactivated(user)) return null;

  return user;
}

/**
 * NextAuth の Credentials の authorize の本体（#87。auth.ts から DB の読み込みと比較を渡す）。
 *
 * 未ログインで呼べるので、email が DB に渡せない形（string でない・空白だけ・長すぎる・
 * NUL や対になっていないサロゲートを含む）なら DB を読まずに null を返す。password が
 * string でないときも比較せずに null を返す。どちらも通常のログインの失敗と同じ null で、
 * 例外を投げない。値は正規化せず、ログにも出さない。
 */
export async function authorizeCredentials<U extends { password: string; deactivatedAt: Date | null }>(
  credentials: Partial<Record<"email" | "password", unknown>> | undefined,
  findUserByEmail: (email: string) => Promise<U | null>,
  compare: PasswordCompare
): Promise<U | null> {
  const email = credentials?.email;
  const password = credentials?.password;
  if (!email || !password) return null;
  if (!isValidEmailInput(email) || typeof password !== "string") return null;

  const user = await findUserByEmail(email);

  // Wrong password and deactivated account (#7) both return null (same error).
  return checkCredentials(user, password, compare);
}

export type ResetTokenRecord = {
  used: boolean;
  expiresAt: Date;
  user: { deactivatedAt: Date | null } | null;
};

/**
 * Result of checkResetToken. When valid, `record` is the same (non-null) record
 * that was passed in, so callers can use its fields (e.g. `userId`) type-safely.
 */
export type ResetTokenCheck<T extends ResetTokenRecord = ResetTokenRecord> =
  | { valid: true; record: T }
  | { valid: false; reason: "Invalid token" | "Token already used" | "Token expired" };

/**
 * Validate a password reset token record (with its user).
 * A token that belongs to a deactivated user is reported as "Invalid token",
 * before the used / expired checks, so it is indistinguishable from an unknown token.
 * A token whose `expiresAt` is at or before `now` is expired (the same boundary as
 * the `expiresAt: { gt: now }` condition used when the token is consumed).
 */
export function checkResetToken<T extends ResetTokenRecord>(
  record: T | null,
  now: Date = new Date()
): ResetTokenCheck<T> {
  if (!record || !record.user || isDeactivated(record.user)) {
    return { valid: false, reason: "Invalid token" };
  }
  if (record.used) return { valid: false, reason: "Token already used" };
  if (record.expiresAt.getTime() <= now.getTime()) return { valid: false, reason: "Token expired" };
  return { valid: true, record };
}
