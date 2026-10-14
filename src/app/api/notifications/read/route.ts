import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { parseMarkReadBody } from "@/lib/notification-read";

// 通知を既読にする（#62）。通知ページで表示した未読の id（重複を除いて 1〜50 件）を受け取る。
// where には必ず本人の userId を入れる。他人の id・存在しない id・既読の id は更新件数に入らないだけで、
// 404 は返さない（存在するかどうかを漏らさない）。何度呼んでも結果は同じ（冪等）。
// 応答は 200 { updated, unreadCount }。unreadCount は更新後の本人の未読件数（バッジの更新に使う）
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request", reason: "invalid_body" }, { status: 400 });
    }
    const parsed = parseMarkReadBody(body);
    // tsconfig は strict: false なので ok では絞り込めない。"reason" in で失敗側に絞る
    if ("reason" in parsed) {
      return NextResponse.json({ error: "Invalid request", reason: parsed.reason }, { status: 400 });
    }
    const { ids } = parsed.value;

    const { count: updated } = await prisma.notification.updateMany({
      where: { id: { in: ids }, userId, read: false },
      data: { read: true },
    });
    const unreadCount = await prisma.notification.count({
      where: { userId, read: false },
    });

    return NextResponse.json({ updated, unreadCount });
  } catch (error) {
    console.error("POST /api/notifications/read error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
