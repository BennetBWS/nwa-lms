import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { isValidId } from "@/lib/lesson-comments";
import { hasAnswersArray, parseSubmitAnswers, scoreAttempt, toAnswerKey } from "@/lib/student-quizzes";

// 回答の送信と採点（#32）。採点はサーバーだけで行い、正解は返さない。
// userId はセッションの値（body の userId は読まない）。応答・ログに回答・正解を含めない
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
    if (!isValidId(quizId)) {
      return NextResponse.json({ error: "Invalid quizId" }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON", reason: "invalid_json" }, { status: 400 });
    }

    // 形が違う body は DB を読まずに断る（長さ・範囲は問題を読んでから確かめる）
    if (!hasAnswersArray(body)) {
      return NextResponse.json({ error: "Invalid request", reason: "invalid_answers" }, { status: 400 });
    }

    const quiz = await prisma.quiz.findUnique({
      where: { id: quizId },
      select: {
        id: true,
        // GET /api/quizzes/[quizId] と同じ並び
        questions: {
          orderBy: [{ order: "asc" }, { id: "asc" }],
          select: { options: true, correctIndex: true },
        },
      },
    });

    if (!quiz) {
      return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
    }

    const key = toAnswerKey(quiz.questions);
    if (!key) {
      return NextResponse.json({ error: "Quiz unavailable", reason: "quiz_unavailable" }, { status: 409 });
    }

    const parsed = parseSubmitAnswers(body, key.optionCounts);
    // tsconfig は strict: false なので ok では絞り込めない。"reason" in で失敗側に絞る
    if ("reason" in parsed) {
      return NextResponse.json({ error: "Invalid request", reason: parsed.reason }, { status: 400 });
    }
    const answers = parsed.value;

    const { score, passed, total, correct, results } = scoreAttempt(answers, key.correctIndexes);

    await prisma.quizAttempt.create({
      data: { userId: session.user.id, quizId: quiz.id, score, passed, answers },
      select: { id: true },
    });

    return NextResponse.json({ score, passed, total, correct, results });
  } catch (error) {
    console.error("POST /api/quizzes/[quizId]/submit error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
