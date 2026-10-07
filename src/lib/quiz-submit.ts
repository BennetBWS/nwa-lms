import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { isValidId } from "@/lib/lesson-comments";
import { hasAnswersArray, parseSubmitAnswers, scoreAttempt, toAnswerKey } from "@/lib/student-quizzes";

/**
 * POST /api/quizzes/[quizId]/submit の本体（#32）。採点はサーバーだけで行い、正解は返さない。
 *
 * - 認証は route（src/app/api/quizzes/[quizId]/submit/route.ts）が行い、セッションの userId を渡す。
 *   body の userId は読まない。応答・ログに回答・正解を含めない
 * - attemptsEnabled が false の間（QUIZ_ATTEMPTS_ENABLED、#8 のあとに公開）は、
 *   入力も DB も見ずに 503 attempts_disabled を返す（Tec 決定、2026-10-07）
 * - route ファイルは GET / POST など決まった名前以外を export できないので、本体はここに置く。
 *   テストは attemptsEnabled: true を渡して採点・保存を確かめる
 */
export async function handleQuizSubmit(
  userId: string,
  request: Request,
  { params }: { params: Promise<{ quizId: string }> },
  { attemptsEnabled }: { attemptsEnabled: boolean }
): Promise<Response> {
  if (!attemptsEnabled) {
    return NextResponse.json(
      { error: "Quiz attempts are not available yet", reason: "attempts_disabled" },
      { status: 503 }
    );
  }

  try {
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
      data: { userId, quizId: quiz.id, score, passed, answers },
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
