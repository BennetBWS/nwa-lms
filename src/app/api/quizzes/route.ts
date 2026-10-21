import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { COURSE_ORDER_BY } from "@/lib/course-order";
import { safeErrorSummary } from "@/lib/safe-error";
import { unlockedCourseIdsOf } from "@/lib/course-gate";
import { loadCourseGates } from "@/lib/lesson-access";
import { buildQuizCourses } from "@/lib/student-quizzes";

// 確認テストの一覧（#32）。コースごとに修了テスト・ミニテストと、自分の受験回数・最高点・合否、コースのロック。
// 問題の選択肢・正解は受験できるかの確認だけに読み、応答には含めない。回答・問題文は読まない。受験記録は自分の分だけ
// ロックは lesson-access の loadCourseGates（course-gate.ts の規則。#78 PR A）。ロールは見ない（講師も自分の完了で計算する。今までどおり）。
// loadCourseGates が知らないコース（読み込みの間に足されたもの）はロックとして扱う
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    const [courses, gates, quizzes, attempts] = await Promise.all([
      prisma.course.findMany({
        orderBy: COURSE_ORDER_BY,
        select: {
          id: true,
          name: true,
          order: true,
          icon: true,
          color: true,
        },
      }),
      loadCourseGates(prisma, userId),
      prisma.quiz.findMany({
        select: {
          id: true,
          title: true,
          type: true,
          courseId: true,
          lessonId: true,
          lesson: {
            select: {
              id: true,
              title: true,
              order: true,
              section: { select: { id: true, order: true, courseId: true } },
            },
          },
          // 受験できるか（選択肢が壊れていない・正解が範囲内）の確認だけに使う。応答には件数だけを出す
          questions: { select: { options: true, correctIndex: true } },
        },
      }),
      prisma.quizAttempt.findMany({
        where: { userId },
        select: { quizId: true, score: true, passed: true, createdAt: true },
      }),
    ]);

    const unlocked = new Set(unlockedCourseIdsOf(gates));
    const lockedCourseIds = new Set(courses.filter((c) => !unlocked.has(c.id)).map((c) => c.id));
    return NextResponse.json({
      courses: buildQuizCourses(courses, lockedCourseIds, quizzes, attempts),
    });
  } catch (error) {
    console.error("GET /api/quizzes error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
