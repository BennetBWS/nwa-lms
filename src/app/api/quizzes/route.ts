import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { buildQuizCourses } from "@/lib/student-quizzes";

// 確認テストの一覧（#32）。コースごとに修了テスト・ミニテストと、自分の受験回数・最高点・合否、コースのロック。
// 正解・回答は読まない。受験記録は自分の分だけ
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    const [courses, progress, quizzes, attempts] = await Promise.all([
      prisma.course.findMany({
        orderBy: [{ order: "asc" }, { id: "asc" }],
        select: {
          id: true,
          name: true,
          order: true,
          icon: true,
          color: true,
          sections: { select: { lessons: { select: { id: true } } } },
        },
      }),
      prisma.progress.findMany({
        where: { userId, completed: true },
        select: { lessonId: true },
      }),
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
          _count: { select: { questions: true } },
        },
      }),
      prisma.quizAttempt.findMany({
        where: { userId },
        select: { quizId: true, score: true, passed: true, createdAt: true },
      }),
    ]);

    const completedLessonIds = new Set(progress.map((p) => p.lessonId));
    const quizInputs = quizzes.map(({ _count, ...q }) => ({ ...q, questionCount: _count.questions }));

    return NextResponse.json({
      courses: buildQuizCourses(courses, completedLessonIds, quizInputs, attempts),
    });
  } catch (error) {
    console.error("GET /api/quizzes error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
