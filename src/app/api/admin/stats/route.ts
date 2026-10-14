import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { COURSE_ORDER_BY } from "@/lib/course-order";
import { safeErrorSummary } from "@/lib/safe-error";
import { buildAdminStats } from "@/lib/admin-stats";

// 集計値は毎回読み直す（キャッシュしない）
export const dynamic = "force-dynamic";

// コースの構成（レッスンの id だけ）。並び順は生徒管理の一覧（currentCourse）と同じ
const COURSE_SELECT = {
  id: true,
  name: true,
  color: true,
  sections: { select: { lessons: { select: { id: true } } } },
} satisfies Prisma.CourseSelect;

// 管理ダッシュボードの統計（#32 PR B）。定義は src/lib/admin-stats.ts の先頭のコメント。
// 応答は集計値とコース名・色だけ（受講生個人の名前・メールは読まない・返さない）。読み取りだけ
export async function GET() {
  try {
    const session = await auth();
    if (session?.user?.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const [students, courses, progress, questions] = await Promise.all([
      // 無効化済みも含める（月別の推移で使う。カードと分布は buildAdminStats が有効な受講生だけにする）
      prisma.user.findMany({
        where: { role: "STUDENT" },
        select: { id: true, deactivatedAt: true },
      }),
      prisma.course.findMany({
        select: COURSE_SELECT,
        orderBy: COURSE_ORDER_BY,
      }),
      // 完了行（completedAt が null の古い行も含む）。受講生以外の行は buildAdminStats が除く
      prisma.progress.findMany({
        where: { completed: true },
        select: { userId: true, lessonId: true, completedAt: true },
      }),
      // 親の質問と返信（未回答の判定は question-threads と同じく、親と同じレッスンの講師の返信で行う）
      prisma.comment.findMany({
        where: { parentId: null },
        select: {
          lesson: { select: { id: true } },
          replies: { select: { lessonId: true, user: { select: { role: true } } } },
        },
      }),
    ]);

    return NextResponse.json(buildAdminStats({ students, courses, progress, questions }, new Date()));
  } catch (error) {
    console.error("GET /api/admin/stats error:", safeErrorSummary(error).name);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
