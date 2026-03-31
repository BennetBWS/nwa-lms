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
    const { title, type, videoUrl, content, pdfUrl, duration, order } = body;

    const lesson = await prisma.lesson.update({
      where: { id },
      data: { title, type, videoUrl, content, pdfUrl, duration, order },
    });

    return NextResponse.json(lesson);
  } catch (error) {
    console.error("Failed to update lesson:", error);
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
      await tx.progress.deleteMany({ where: { lessonId: id } });
      await tx.comment.deleteMany({ where: { lessonId: id } });
      const quizzes = await tx.quiz.findMany({
        where: { lessonId: id },
        select: { id: true },
      });
      const quizIds = quizzes.map((q) => q.id);
      await tx.quizAttempt.deleteMany({ where: { quizId: { in: quizIds } } });
      await tx.quizQuestion.deleteMany({ where: { quizId: { in: quizIds } } });
      await tx.quiz.deleteMany({ where: { lessonId: id } });
      await tx.lesson.delete({ where: { id } });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete lesson:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
