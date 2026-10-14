import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { COURSE_ORDER_BY, LESSON_ORDER_BY, SECTION_ORDER_BY } from "@/lib/course-order";
import { hideLockedLessonContent } from "@/lib/lesson-access";
import { unlockedCourseIds } from "@/lib/question-threads";

// コース一覧。受講生（講師以外）には、ロック中のコースも一覧には返すが、
// そのレッスンは LOCKED_LESSON_VISIBLE_FIELDS の項目だけにし（videoUrl・content・pdfUrl などを出さない）、コースに locked: true を付ける（#47 P4、Tec 決定 D-a）。
// 残すのは画面のロック計算（course-lock の isCourseLocked）と一覧表示に要る項目だけ（lesson-access.ts 参照）。講師は常に locked: false。
// ロックはここで読んだコース（COURSE_ORDER_BY の順）と自分の完了から計算する（lesson-access と同じ規則）
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    const [courses, progressRecords] = await Promise.all([
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
    ]);

    const completedLessonIds = new Set(
      progressRecords.map((p) => p.lessonId)
    );

    const unlocked = session.user.role === "INSTRUCTOR" ? null : new Set(unlockedCourseIds(courses, completedLessonIds));

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
    console.error("GET /api/courses error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
