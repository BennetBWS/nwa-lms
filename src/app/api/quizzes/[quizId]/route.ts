import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { isValidId } from "@/lib/lesson-comments";
import { summarizeAttempts, toQuestionViews } from "@/lib/student-quizzes";

// 受験画面の問題（#32）。correctIndex は読まないし返さない。受験記録は自分の分の集計値だけ（行そのものは返さない）
export async function GET(
  request: Request,
  { params }: { params: Promise<{ quizId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { quizId } = await params;
    if (!isValidId(quizId)) {
      return NextResponse.json({ error: "Invalid quizId" }, { status: 400 });
    }

    const userId = session.user.id;
    const [quiz, attempts] = await Promise.all([
      prisma.quiz.findUnique({
        where: { id: quizId },
        select: {
          id: true,
          title: true,
          type: true,
          questions: {
            orderBy: [{ order: "asc" }, { id: "asc" }],
            select: { id: true, question: true, options: true },
          },
        },
      }),
      prisma.quizAttempt.findMany({
        where: { userId, quizId },
        select: { score: true, passed: true, createdAt: true },
      }),
    ]);

    if (!quiz) {
      return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
    }

    const questions = toQuestionViews(quiz.questions);
    if (!questions) {
      return NextResponse.json({ error: "Quiz unavailable", reason: "quiz_unavailable" }, { status: 409 });
    }

    const stats = summarizeAttempts(attempts);
    return NextResponse.json({
      id: quiz.id,
      title: quiz.title,
      type: quiz.type,
      questionCount: questions.length,
      questions,
      attemptCount: stats.attemptCount,
      bestScore: stats.bestScore,
      passed: stats.passed,
    });
  } catch (error) {
    console.error("GET /api/quizzes/[quizId] error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
