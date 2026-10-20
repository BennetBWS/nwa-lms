import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { COURSE_ORDER_BY, LESSON_ORDER_BY, SECTION_ORDER_BY } from "@/lib/course-order";
import { hideLockedLessonContent, loadCourseGates } from "@/lib/lesson-access";
import { unlockedCourseIdsOf } from "@/lib/course-gate";
import { safeErrorSummary } from "@/lib/safe-error";

// コース一覧。受講生（講師以外）には、ロック中のコースも一覧には返すが、
// そのレッスンは LOCKED_LESSON_VISIBLE_FIELDS の項目だけにし（videoUrl・content・pdfUrl などを出さない）、コースに locked: true を付ける（#47 P4、Tec 決定 D-a）。
// 残すのは一覧表示に要る項目だけ（lesson-access.ts 参照）。講師は常に locked: false。
// ロックは lesson-access の loadCourseGates（course-gate.ts の規則。#78 PR A）の結果を使い、画面はこの locked を表示するだけにする。
// loadCourseGates が知らないコース（読み込みの間に足されたもの）はロックとして扱う
// 一覧の表示用の読み込みとロック用の読み込み（loadCourseGates）は別のクエリで、同じ時点のデータとは限らない。間に完了が書かれると、
// 一瞬だけ進捗とロックが食い違うことがある（例：100% なのに次のコースがまだロック）。ロックが残る側に食い違い、開き直せば直る（既知の挙動）
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    const isInstructor = session.user.role === "INSTRUCTOR";
    const [courses, progressRecords, gates] = await Promise.all([
      prisma.course.findMany({
        orderBy: COURSE_ORDER_BY,
        include: {
          sections: {
            orderBy: SECTION_ORDER_BY,
            include: { lessons: { orderBy: LESSON_ORDER_BY } },
          },
        },
      }),
      prisma.progress.findMany({
        where: { userId, completed: true },
        select: { lessonId: true },
      }),
      isInstructor ? null : loadCourseGates(prisma, userId),
    ]);

    const completedLessonIds = new Set(
      progressRecords.map((p) => p.lessonId)
    );

    const unlocked = gates === null ? null : new Set(unlockedCourseIdsOf(gates));

    const coursesWithProgress = courses.map((course) => {
      const locked = unlocked !== null && !unlocked.has(course.id);
      let totalLessons = 0;
      let completedLessons = 0;

      const sections = course.sections.map((section) => {
        const lessons = section.lessons.map((lesson) => {
          totalLessons++;
          const completed = completedLessonIds.has(lesson.id);
          if (completed) completedLessons++;
          const row = { ...lesson, completed };
          return locked ? hideLockedLessonContent(row) : row;
        });
        return { ...section, lessons };
      });

      const progress =
        totalLessons > 0
          ? Math.round((completedLessons / totalLessons) * 100)
          : 0;

      return { ...course, sections, progress, locked };
    });

    return NextResponse.json(coursesWithProgress, {
      headers: { "Cache-Control": "private, max-age=0, stale-while-revalidate=60" },
    });
  } catch (error) {
    console.error("GET /api/courses error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
