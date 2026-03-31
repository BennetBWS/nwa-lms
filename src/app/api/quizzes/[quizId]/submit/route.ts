import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ quizId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { quizId } = await params;
    const { answers } = await request.json();

    if (!Array.isArray(answers)) {
      return NextResponse.json(
        { error: "answers must be an array" },
        { status: 400 }
      );
    }

    const quiz = await prisma.quiz.findUnique({
      where: { id: quizId },
      include: {
        questions: {
          orderBy: { order: "asc" },
        },
      },
    });

    if (!quiz) {
      return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
    }

    const total = quiz.questions.length;
    let correct = 0;

    for (let i = 0; i < total; i++) {
      if (answers[i] === quiz.questions[i].correctIndex) {
        correct++;
      }
    }

    const score = total > 0 ? Math.round((correct / total) * 100) : 0;
    const passed = score >= 70;

    await prisma.quizAttempt.create({
      data: {
        userId: session.user.id,
        quizId,
        score,
        passed,
        answers,
      },
    });

    return NextResponse.json({ score, passed, total, correct });
  } catch (error) {
    console.error("POST /api/quizzes/[quizId]/submit error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
