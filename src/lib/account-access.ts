/**
 * Account access checks shared by sign-in and password reset (#7).
 *
 * A deactivated account (`deactivatedAt` set) is treated exactly like a wrong
 * password / an invalid token, so responses do not reveal that the account
 * exists but is deactivated.
 */

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
 */
export function checkResetToken<T extends ResetTokenRecord>(
  record: T | null,
  now: Date = new Date()
): ResetTokenCheck<T> {
  if (!record || !record.user || isDeactivated(record.user)) {
    return { valid: false, reason: "Invalid token" };
  }
  if (record.used) return { valid: false, reason: "Token already used" };
  if (record.expiresAt < now) return { valid: false, reason: "Token expired" };
  return { valid: true, record };
}
