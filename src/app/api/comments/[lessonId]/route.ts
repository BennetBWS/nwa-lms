import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { COMMENTS_LIMIT, isValidId, toCommentThreadView } from "@/lib/lesson-comments";

// 1 件ごとに読む項目。user は name・role・deactivatedAt だけ（応答には含めない。#32）
const COMMENT_SELECT = {
  id: true,
  content: true,
  createdAt: true,
  userId: true,
  user: { select: { name: true, role: true, deactivatedAt: true } },
} as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ lessonId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { lessonId } = await params;
    if (!isValidId(lessonId)) {
      return NextResponse.json({ error: "Invalid lessonId" }, { status: 400 });
    }

    const comments = await prisma.comment.findMany({
      where: { lessonId, parentId: null },
      select: {
        ...COMMENT_SELECT,
        // 親と同じレッスンの返信だけ（#32 より前の POST では、別レッスンの lessonId を持つ返信が作られうる）
        replies: {
          where: { lessonId },
          select: COMMENT_SELECT,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: COMMENTS_LIMIT,
    });

    const viewerId = session.user.id;
    return NextResponse.json(comments.map((c) => toCommentThreadView(c, viewerId)));
  } catch (error) {
    console.error("GET /api/comments/[lessonId] error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
