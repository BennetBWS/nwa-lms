import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { studentStatusOf } from "@/lib/student-status";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if ((session?.user as any)?.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    // Students only (#7): other roles are answered with 404.
    const student = await prisma.user.findFirst({
      where: { id, role: "STUDENT" },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        createdAt: true,
        deactivatedAt: true,
      },
    });

    if (!student) {
      return NextResponse.json({ error: "Student not found" }, { status: 404 });
    }

    // Per-course progress
    const courses = await prisma.course.findMany({
      include: {
        sections: {
          include: {
            lessons: {
              include: {
                progress: {
                  where: { userId: id },
                },
              },
            },
          },
        },
      },
      orderBy: { order: "asc" },
    });

    const courseProgress = courses.map((course) => {
      const lessons = course.sections.flatMap((s) => s.lessons);
      const completedLessons = lessons.filter((l) =>
        l.progress.some((p) => p.completed)
      ).length;
      return {
        courseId: course.id,
        courseName: course.name,
        totalLessons: lessons.length,
        completedLessons,
      };
    });

    // Quiz attempts
    const quizAttempts = await prisma.quizAttempt.findMany({
      where: { userId: id },
      include: {
        quiz: { select: { title: true, type: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Assignments
    const assignments = await prisma.assignment.findMany({
      where: { userId: id },
      include: {
        course: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      ...student,
      ...studentStatusOf(student),
      courseProgress,
      quizAttempts,
      assignments,
    });
  } catch (error) {
    console.error("Failed to fetch student detail:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
