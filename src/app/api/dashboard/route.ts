import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { COURSE_ORDER_BY, LESSON_ORDER_BY, SECTION_ORDER_BY } from "@/lib/course-order";
import { unlockedCourseIdsOf } from "@/lib/course-gate";
import { loadCourseGates } from "@/lib/lesson-access";
import { NEXT_LESSONS_LIMIT, countCompletedSince, pickNextLessons, summarizeCourses } from "@/lib/student-dashboard";

// 受講生ダッシュボード（#32）。courses の各コースに locked を付ける（#78 PR A）。
// ロックは lesson-access の loadCourseGates（course-gate.ts の規則）で、/api/courses と同じく講師は常に locked: false。
// loadCourseGates が知らないコース（読み込みの間に足されたもの）はロックとして扱う。
// 「学習を続ける」・Next Up（pickNextLessons）はロック中のコースを選ばない
// 一覧の表示用の読み込みとロック用の読み込み（loadCourseGates）は別のクエリで、同じ時点のデータとは限らない。間に完了が書かれると、
// 一瞬だけ進捗とロックが食い違うことがある（例：100% なのに次のコースがまだロック、またはその逆）。どちらの向きにも食い違いうるが、
// locked とレッスンの中身を隠すかどうかは loadCourseGates の結果だけで決まり、開き直せば直る（既知の挙動）

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;
    const now = new Date();
    const isInstructor = session.user.role === "INSTRUCTOR";

    const [courses, userProgress, recentActivity, notifications, unreadNotifications, gates] =
      await Promise.all([
        prisma.course.findMany({
          orderBy: COURSE_ORDER_BY,
          select: {
            id: true,
            name: true,
            icon: true,
            color: true,
            order: true,
            sections: {
              orderBy: SECTION_ORDER_BY,
              select: {
                id: true,
                order: true,
                lessons: {
                  orderBy: LESSON_ORDER_BY,
                  select: { id: true, title: true, order: true },
                },
              },
            },
          },
        }),
        prisma.progress.findMany({
          where: { userId, completed: true },
          select: { lessonId: true, completed: true, completedAt: true },
        }),
        // completedAt が NULL の行は Postgres の DESC で先頭に来るため除く
        prisma.progress.findMany({
          where: { userId, completed: true, completedAt: { not: null } },
          orderBy: [{ completedAt: "desc" }, { id: "desc" }],
          take: 5,
          select: {
            completedAt: true,
            lesson: {
              select: {
                title: true,
                section: {
                  select: {
                    course: { select: { name: true } },
                  },
                },
              },
            },
          },
        }),
        prisma.notification.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, title: true, message: true, read: true, createdAt: true },
        }),
        prisma.notification.count({
          where: { userId, read: false },
        }),
        isInstructor ? null : loadCourseGates(prisma, userId),
      ]);

    const completedLessonIds = new Set(userProgress.map((p) => p.lessonId));
    const unlocked = gates === null ? null : new Set(unlockedCourseIdsOf(gates));
    const lockedCourseIds = new Set(unlocked === null ? [] : courses.filter((c) => !unlocked.has(c.id)).map((c) => c.id));
    const summary = summarizeCourses(courses, completedLessonIds, lockedCourseIds);

    const recentActivityData = recentActivity.map((p) => ({
      lessonTitle: p.lesson.title,
      courseName: p.lesson.section.course.name,
      completedAt: p.completedAt,
    }));

    return NextResponse.json({
      activeCourses: summary.activeCourses,
      completedLessons: summary.completedLessons,
      totalLessons: summary.totalLessons,
      overallProgress: summary.overallProgress,
      completedLast7Days: countCompletedSince(userProgress, now),
      courses: summary.courses,
      nextLessons: pickNextLessons(courses, completedLessonIds, NEXT_LESSONS_LIMIT, lockedCourseIds),
      recentActivity: recentActivityData,
      unreadNotifications,
      notifications,
    });
  } catch (error) {
    console.error("GET /api/dashboard error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
