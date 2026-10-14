import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { COMMENTS_LIMIT, isValidId, toCommentThreadView } from "@/lib/lesson-comments";
import { COURSE_LOCKED_REASON, lessonAccessFor } from "@/lib/lesson-access";

// 1 件ごとに読む項目。user は name・role・deactivatedAt だけ（応答には含めない。#32）
const COMMENT_SELECT = {
  id: true,
  content: true,
  createdAt: true,
  userId: true,
  user: { select: { name: true, role: true, deactivatedAt: true } },
} as const;

// レッスンの質問タブ（#32）。受講生（講師以外）のロック中のコースのレッスンは 403 { reason: "course_locked" } で、
// 質問を読まない（#47 P4、Tec 決定 D-a）。講師はロックを見ない。
// レッスンがないときは、これまでどおり空の配列を返す（質問を読まない）
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

    if (session.user.role !== "INSTRUCTOR") {
      const access = await lessonAccessFor(prisma, session.user.id, lessonId);
      if (access === "not_found") return NextResponse.json([]);
      if (access === "locked") {
        return NextResponse.json({ error: "Forbidden", reason: COURSE_LOCKED_REASON }, { status: 403 });
      }
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
