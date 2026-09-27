import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkResetToken } from "@/lib/account-access";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");

    if (!token) {
      return NextResponse.json({ valid: false, reason: "Token is required" });
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
    console.error("verify-reset-token error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
