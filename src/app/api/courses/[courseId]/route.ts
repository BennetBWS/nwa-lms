import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { LESSON_ORDER_BY, SECTION_ORDER_BY } from "@/lib/course-order";
import { COURSE_LOCKED_REASON, courseAccessFor } from "@/lib/lesson-access";

// コースの詳細（レッスンの本文・動画・資料を含む）。
// 受講生（講師以外）のロック中のコースは 403 { reason: "course_locked" } で、コースの中身を読まない（#47 P4、Tec 決定 D-a）。
// 講師はロックを見ない
export async function GET(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { courseId } = await params;
    const userId = session.user.id;

    if (session.user.role !== "INSTRUCTOR") {
      const access = await courseAccessFor(prisma, userId, courseId);
      if (access === "not_found") {
        return NextResponse.json({ error: "Course not found" }, { status: 404 });
      }
      if (access === "locked") {
        return NextResponse.json({ error: "Forbidden", reason: COURSE_LOCKED_REASON }, { status: 403 });
      }
    }

    const [course, progressRecords] = await Promise.all([
      prisma.course.findUnique({
        where: { id: courseId },
        include: {
          sections: {
            orderBy: SECTION_ORDER_BY,
            include: { lessons: { orderBy: LESSON_ORDER_BY } },
          },
        },
      }),
      prisma.progress.findMany({
        where: { userId, completed: true, lesson: { section: { courseId } } },
        select: { lessonId: true },
      }),
    ]);

    if (!course) {
      return NextResponse.json({ error: "Course not found" }, { status: 404 });
    }

    const completedLessonIds = new Set(
      progressRecords.map((p) => p.lessonId)
    );

    let totalLessons = 0;
    let completedLessons = 0;

    const sections = course.sections.map((section) => {
      const lessons = section.lessons.map((lesson) => {
        totalLessons++;
        const completed = completedLessonIds.has(lesson.id);
        if (completed) completedLessons++;
        return { ...lesson, completed };
      });
      return { ...section, lessons };
    });

    const progress =
      totalLessons > 0
        ? Math.round((completedLessons / totalLessons) * 100)
        : 0;

    return NextResponse.json({ ...course, sections, progress }, {
      headers: { "Cache-Control": "private, max-age=0, stale-while-revalidate=60" },
    });
  } catch (error) {
    console.error("GET /api/courses/[courseId] error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
