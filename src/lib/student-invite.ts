/**
 * Duplicate-email handling for POST /api/admin/students/invite (#7).
 */

export type InviteConflictBody =
  | { error: string; code: "DEACTIVATED"; userId: string }
  | { error: string; code: "EXISTS" };

export const INVITE_EXISTS_MESSAGE = "このメールアドレスは既に登録されています";
export const INVITE_DEACTIVATED_MESSAGE =
  "このメールアドレスの受講生は無効化されています。再招待ではなく再有効化してください";

/**
 * Returns the 409 body when an account with the email already exists, or null.
 * Only a deactivated STUDENT gets code DEACTIVATED (with its id, so the admin UI
 * can offer reactivation). Any other existing account gets code EXISTS.
 */
export function inviteConflictFor(
  existing: { id: string; role: string; deactivatedAt: Date | null } | null
): InviteConflictBody | null {
  if (!existing) return null;
  if (existing.role === "STUDENT" && existing.deactivatedAt) {
    return { error: INVITE_DEACTIVATED_MESSAGE, code: "DEACTIVATED", userId: existing.id };
  }
  return { error: INVITE_EXISTS_MESSAGE, code: "EXISTS" };
}

/** Prisma unique constraint violation (P2002), e.g. a concurrent invite of the same email. */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
