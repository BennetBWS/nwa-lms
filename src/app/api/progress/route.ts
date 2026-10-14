import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { isValidId } from "@/lib/lesson-comments";
import { COURSE_LOCKED_REASON, lessonAccessFor } from "@/lib/lesson-access";

// レッスンを完了にする。
// ロックの規則は「このコースの完了が 1 件以上あれば解放」なので、ロック中のコースに完了を書くとロックが外れてしまう。
// そのため受講生（講師以外）は、書く前にコースのロックを確かめる（#47 P4、Tec 決定 D-a）。講師はロックを見ない。
// 判定の順：
// 1. 未ログイン 401
// 2. JSON でない・lessonId が空でない 64 文字以内の文字列でない 400
// 3. レッスンがない 404（以前は FK エラーで 500 だった）
// 4. 受講生でロック中のコース 403 { reason: "course_locked" }（progress を書かない）
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

    const lessonId = typeof body === "object" && body !== null ? (body as { lessonId?: unknown }).lessonId : undefined;
    if (!isValidId(lessonId)) {
      return NextResponse.json(
        { error: "lessonId is required" },
        { status: 400 }
      );
    }

    const userId = session.user.id;
    if (session.user.role === "INSTRUCTOR") {
      const lesson = await prisma.lesson.findUnique({ where: { id: lessonId }, select: { id: true } });
      if (!lesson) {
        return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
      }
    } else {
      const access = await lessonAccessFor(prisma, userId, lessonId);
      if (access === "not_found") {
        return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
      }
      if (access === "locked") {
        return NextResponse.json({ error: "Forbidden", reason: COURSE_LOCKED_REASON }, { status: 403 });
      }
    }

    const progress = await prisma.progress.upsert({
      where: {
        userId_lessonId: {
          userId,
          lessonId,
        },
      },
      update: {
        completed: true,
        completedAt: new Date(),
      },
      create: {
        userId,
        lessonId,
        completed: true,
        completedAt: new Date(),
      },
    });

    return NextResponse.json(progress, {
      headers: { "Cache-Control": "no-cache, no-store" },
    });
  } catch (error) {
    console.error("POST /api/progress error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
