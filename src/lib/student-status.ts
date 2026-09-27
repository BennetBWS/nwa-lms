import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Soft deactivation of students (#7).
 *
 * A student is deactivated when `User.deactivatedAt` is set (null = active).
 * Deactivation never deletes anything: progress, quiz attempts, comments,
 * assignments and notifications are kept so the student can be reactivated.
 *
 * Only users with role STUDENT are handled here. Any other user (and unknown
 * ids) is reported as "not_found", so callers answer 404 without revealing
 * that an instructor with that id exists.
 */

export type StudentStatusDb = Pick<PrismaClient, "$transaction" | "user" | "passwordReset">;

export type StudentStatusValue = "active" | "deactivated";

export type StudentStatus = {
  id: string;
  status: StudentStatusValue;
  /** ISO 8601 string, or null when active. */
  deactivatedAt: string | null;
};

export type StudentStatusResult =
  | { kind: "ok"; student: StudentStatus; changed: boolean }
  | { kind: "not_found" };

export function studentStatusOf(user: { id: string; deactivatedAt: Date | null }): StudentStatus {
  return {
    id: user.id,
    status: user.deactivatedAt ? "deactivated" : "active",
    deactivatedAt: user.deactivatedAt ? user.deactivatedAt.toISOString() : null,
  };
}

const STATUS_SELECT = { id: true, role: true, deactivatedAt: true } satisfies Prisma.UserSelect;

/**
 * Deactivate a student. Idempotent.
 *
 * In one transaction:
 * - sets `deactivatedAt` to `now` (an existing value is kept),
 * - increments `sessionVersion` (only on the active -> deactivated transition),
 * - marks the student's unused password reset tokens as used.
 */
export async function deactivateStudent(
  db: StudentStatusDb,
  id: string,
  now: Date = new Date()
): Promise<StudentStatusResult> {
  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id }, select: STATUS_SELECT });
    if (!user || user.role !== "STUDENT") return { kind: "not_found" };

    // Conditional update: a concurrent deactivation cannot bump sessionVersion twice
    // or overwrite the original deactivatedAt.
    const { count } = await tx.user.updateMany({
      where: { id, role: "STUDENT", deactivatedAt: null },
      data: { deactivatedAt: now, sessionVersion: { increment: 1 } },
    });

    await tx.passwordReset.updateMany({
      where: { userId: id, used: false },
      data: { used: true },
    });

    const current = await tx.user.findUnique({ where: { id }, select: STATUS_SELECT });
    if (!current || current.role !== "STUDENT") return { kind: "not_found" };

    return { kind: "ok", student: studentStatusOf(current), changed: count > 0 };
  });
}

/**
 * Reactivate a student. Idempotent.
 *
 * Only clears `deactivatedAt`. `sessionVersion` and the password are unchanged.
 */
export async function reactivateStudent(
  db: StudentStatusDb,
  id: string
): Promise<StudentStatusResult> {
  const user = await db.user.findUnique({ where: { id }, select: STATUS_SELECT });
  if (!user || user.role !== "STUDENT") return { kind: "not_found" };

  const { count } = await db.user.updateMany({
    where: { id, role: "STUDENT", deactivatedAt: { not: null } },
    data: { deactivatedAt: null },
  });

  return { kind: "ok", student: studentStatusOf({ id, deactivatedAt: null }), changed: count > 0 };
}

export type StudentStatusFilter = "active" | "deactivated" | "all";

/**
 * Parse the `status` query parameter of GET /api/admin/students.
 * Missing -> "active". Unknown values -> null (the route answers 400).
 */
export function parseStudentStatusFilter(value: string | null): StudentStatusFilter | null {
  if (value === null) return "active";
  if (value === "active" || value === "deactivated" || value === "all") return value;
  return null;
}

export function studentListWhere(filter: StudentStatusFilter): Prisma.UserWhereInput {
  switch (filter) {
    case "active":
      return { role: "STUDENT", deactivatedAt: null };
    case "deactivated":
      return { role: "STUDENT", deactivatedAt: { not: null } };
    case "all":
      return { role: "STUDENT" };
  }
}
