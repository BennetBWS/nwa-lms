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

const RESEND_ERROR_NAME = /^[a-z_]{1,64}$/;

/**
 * Log-safe summary of a Resend SDK error (#9).
 *
 * Resend v6 returns errors as plain objects `{ name, statusCode, message }`.
 * Only `name` (when it looks like a Resend error code such as
 * "validation_error") and an HTTP-range `statusCode` are returned. `message`
 * is never used, since it can echo the recipient address or other input.
 */
export function safeResendErrorSummary(error: unknown): { name: string; statusCode?: number } {
  if (typeof error !== "object" || error === null) return { name: "unknown" };

  const rawName = "name" in error ? (error as { name: unknown }).name : undefined;
  const name = typeof rawName === "string" && RESEND_ERROR_NAME.test(rawName) ? rawName : "unknown";

  if ("statusCode" in error) {
    const statusCode = (error as { statusCode: unknown }).statusCode;
    if (
      typeof statusCode === "number" &&
      Number.isInteger(statusCode) &&
      statusCode >= 100 &&
      statusCode <= 599
    ) {
      return { name, statusCode };
    }
  }

  return { name };
}
