import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

    const course = await prisma.course.findUnique({
      where: { id: courseId },
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

    if (!course) {
      return NextResponse.json({ error: "Course not found" }, { status: 404 });
    }

    const progressRecords = await prisma.progress.findMany({
      where: {
        userId,
        completed: true,
        lesson: {
          section: { courseId },
        },
      },
      select: { lessonId: true },
    });

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

    return NextResponse.json({ ...course, sections, progress });
  } catch (error) {
    console.error("GET /api/courses/[courseId] error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
