import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const session = await auth();
    if ((session?.user as any)?.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const quizzes = await prisma.quiz.findMany({
      include: {
        _count: {
          select: {
            questions: true,
            attempts: true,
          },
        },
        lesson: { select: { title: true } },
      },
      orderBy: { title: "asc" },
    });

    const result = quizzes.map((quiz) => ({
      ...quiz,
      questionCount: quiz._count.questions,
      attemptCount: quiz._count.attempts,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch quizzes:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
