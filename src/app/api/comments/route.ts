import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { parseCreateComment, toCommentThreadView } from "@/lib/lesson-comments";

// 画面からは使わない（投稿欄の公開は #46）。入力検証だけ強化して残す（#32）
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = parseCreateComment(body);
    // tsconfig は strict: false なので ok では絞り込めない。"reason" in で失敗側に絞る
    if ("reason" in parsed) {
      return NextResponse.json({ error: "Invalid request", reason: parsed.reason }, { status: 400 });
    }
    const { lessonId, content, parentId } = parsed.value;

    const lesson = await prisma.lesson.findUnique({ where: { id: lessonId }, select: { id: true } });
    if (!lesson) {
      return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
    }

    if (parentId !== null) {
      // 返信は、同じレッスンの親の質問（parentId が null）にだけ付けられる。返信への返信は禁止
      const parent = await prisma.comment.findUnique({
        where: { id: parentId },
        select: { lessonId: true, parentId: true },
      });
      if (!parent || parent.lessonId !== lessonId || parent.parentId !== null) {
        return NextResponse.json({ error: "Invalid request", reason: "invalid_parent_id" }, { status: 400 });
      }
    }

    const userId = session.user.id;
    const comment = await prisma.comment.create({
      data: { userId, lessonId, content, parentId },
      select: {
        id: true,
        content: true,
        createdAt: true,
        userId: true,
        user: { select: { name: true, role: true, deactivatedAt: true } },
      },
    });

    return NextResponse.json(toCommentThreadView({ ...comment, replies: [] }, userId), { status: 201 });
  } catch (error) {
    console.error("POST /api/comments error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
