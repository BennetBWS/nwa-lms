import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { checkResetToken } from "@/lib/account-access";

export async function POST(request: Request) {
  try {
    const { token, newPassword } = await request.json();

    // Non-string values (numbers, arrays, objects) are rejected like missing ones.
    if (typeof token !== "string" || typeof newPassword !== "string" || !token || !newPassword) {
      return NextResponse.json({ error: "Token and new password are required" }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }

    const findRecord = () =>
      prisma.passwordReset.findUnique({
        where: { token },
        include: { user: { select: { deactivatedAt: true } } },
      });

    // One `now` for the check and the conditional update below, so both use the
    // same expiry boundary (expiresAt <= now is expired).
    const now = new Date();

    // A deactivated user's token is answered like an unknown token (#7).
    const check = checkResetToken(await findRecord(), now);
    if (check.valid === false) {
      return NextResponse.json({ error: check.reason }, { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // The token is consumed with a conditional update, so a token used, expired or
    // whose user was deactivated after the check above cannot change the password
    // (e.g. two concurrent requests with the same token: only one succeeds).
    // Bumping sessionVersion signs out every device (#11).
    const consumed = await prisma.$transaction(async (tx) => {
      const { count } = await tx.passwordReset.updateMany({
        where: { token, used: false, expiresAt: { gt: now }, user: { deactivatedAt: null } },
        data: { used: true },
      });
      if (count !== 1) return false;
      await tx.user.update({
        where: { id: check.record.userId },
        data: { password: hashedPassword, sessionVersion: { increment: 1 } },
      });
      return true;
    });

    if (!consumed) {
      // Answer exactly as the check above would now.
      const recheck = checkResetToken(await findRecord(), now);
      const reason = recheck.valid === false ? recheck.reason : "Invalid token";
      return NextResponse.json({ error: reason }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("reset-password error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
