import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";

/** 通知ページに返す最大件数（#32、ページングなし） */
const NOTIFICATIONS_LIMIT = 50;

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const notifications = await prisma.notification.findMany({
      where: { userId: session.user.id },
      select: { id: true, title: true, message: true, read: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: NOTIFICATIONS_LIMIT,
    });

    return NextResponse.json(notifications);
  } catch (error) {
    console.error("GET /api/notifications error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
