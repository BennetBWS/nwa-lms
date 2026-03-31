import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    const courses = await prisma.course.findMany({
      orderBy: { order: "asc" },
      include: {
        sections: {
          orderBy: { order: "asc" },
          include: {
            lessons: {
              orderBy: { order: "asc" },
            },
          },
        },
      },
    });

    const progressRecords = await prisma.progress.findMany({
      where: { userId, completed: true },
      select: { lessonId: true },
    });

    const completedLessonIds = new Set(
      progressRecords.map((p) => p.lessonId)
    );

    const coursesWithProgress = courses.map((course) => {
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

      return { ...course, sections, progress };
    });

    return NextResponse.json(coursesWithProgress);
  } catch (error) {
    console.error("GET /api/courses error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
