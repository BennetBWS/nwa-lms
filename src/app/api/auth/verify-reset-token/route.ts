import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");

    if (!token) {
      return NextResponse.json({ valid: false, reason: "Token is required" });
    }

    const record = await prisma.passwordReset.findUnique({ where: { token } });

    if (!record) {
      return NextResponse.json({ valid: false, reason: "Invalid token" });
    }
    if (record.used) {
      return NextResponse.json({ valid: false, reason: "Token already used" });
    }
    if (record.expiresAt < new Date()) {
      return NextResponse.json({ valid: false, reason: "Token expired" });
    }

    return NextResponse.json({ valid: true });
  } catch (error) {
    console.error("verify-reset-token error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
