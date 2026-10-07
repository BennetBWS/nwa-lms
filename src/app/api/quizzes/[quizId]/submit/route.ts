import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { safeErrorSummary } from "@/lib/safe-error";
import { handleQuizSubmit } from "@/lib/quiz-submit";
import { QUIZ_ATTEMPTS_ENABLED } from "@/lib/student-quizzes";

// 回答の送信と採点（#32）。本体は src/lib/quiz-submit.ts。
// QUIZ_ATTEMPTS_ENABLED が false の間は、認証のあと DB を読まずに 503 attempts_disabled を返す。
// userId はセッションの値（body の userId は読まない）
export async function POST(
  request: Request,
  context: { params: Promise<{ quizId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return await handleQuizSubmit(session.user.id, request, context, { attemptsEnabled: QUIZ_ATTEMPTS_ENABLED });
  } catch (error) {
    console.error("POST /api/quizzes/[quizId]/submit error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
