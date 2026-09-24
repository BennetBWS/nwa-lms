/**
 * Log-safe error summary.
 *
 * Returns only the error name and, for Prisma known request errors, the error
 * code (e.g. "P2002"). Never includes message, meta or stack, since those can
 * contain user input such as email addresses.
 */

const PRISMA_ERROR_CODE = /^P\d{4}$/;

export function safeErrorSummary(error: unknown): { name: string; code?: string } {
  const name = error instanceof Error ? error.name : typeof error;

  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && PRISMA_ERROR_CODE.test(code)) {
      return { name, code };
    }
  }

  return { name };
}
