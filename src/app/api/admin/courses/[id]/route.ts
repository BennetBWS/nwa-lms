import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if ((session?.user as any)?.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json();
    const { name, description, order, icon, color } = body;

    const course = await prisma.course.update({
      where: { id },
      data: { name, description, order, icon, color },
    });

    return NextResponse.json(course);
  } catch (error) {
    console.error("Failed to update course:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if ((session?.user as any)?.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    await prisma.$transaction(async (tx) => {
      // Get all quizzes in this course (via lessons or directly linked)
      const sections = await tx.section.findMany({
        where: { courseId: id },
        select: { id: true },
      });
      const sectionIds = sections.map((s) => s.id);

      const lessons = await tx.lesson.findMany({
        where: { sectionId: { in: sectionIds } },
        select: { id: true },
      });
      const lessonIds = lessons.map((l) => l.id);

      const quizzes = await tx.quiz.findMany({
        where: {
          OR: [
            { courseId: id },
            { lessonId: { in: lessonIds } },
          ],
        },
        select: { id: true },
      });
      const quizIds = quizzes.map((q) => q.id);

      // Delete in dependency order
      await tx.quizAttempt.deleteMany({ where: { quizId: { in: quizIds } } });
      await tx.quizQuestion.deleteMany({ where: { quizId: { in: quizIds } } });
      await tx.quiz.deleteMany({
        where: {
          OR: [
            { courseId: id },
            { lessonId: { in: lessonIds } },
          ],
        },
      });
      await tx.progress.deleteMany({ where: { lessonId: { in: lessonIds } } });
      await tx.comment.deleteMany({ where: { lessonId: { in: lessonIds } } });
      await tx.lesson.deleteMany({ where: { sectionId: { in: sectionIds } } });
      await tx.section.deleteMany({ where: { courseId: id } });
      await tx.assignment.deleteMany({ where: { courseId: id } });
      await tx.course.delete({ where: { id } });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete course:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
