import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkResetToken } from "@/lib/account-access";
import { isValidResetTokenInput } from "@/lib/auth-input";
import { safeErrorSummary } from "@/lib/safe-error";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");

    if (!token) {
      return NextResponse.json({ valid: false, reason: "Token is required" });
    }
    // #87: a token that cannot be sent to the DB (too long, NUL; a lone surrogate
    // cannot arrive through the URL) is answered like an unknown token, without reading the DB.
    if (!isValidResetTokenInput(token)) {
      return NextResponse.json({ valid: false, reason: "Invalid token" });
    }

    const record = await prisma.passwordReset.findUnique({
      where: { token },
      include: { user: { select: { deactivatedAt: true } } },
    });

    // A deactivated user's token is answered like an unknown token (#7).
    const check = checkResetToken(record);
    if (check.valid === false) {
      return NextResponse.json({ valid: false, reason: check.reason });
    }

    return NextResponse.json({ valid: true });
  } catch (error) {
    // Do not pass the error object: its message/meta/stack may contain the token (#87).
    console.error("[verify-reset-token] Unexpected error:", safeErrorSummary(error).name);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
