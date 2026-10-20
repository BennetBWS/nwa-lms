import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { isValidId } from "@/lib/lesson-comments";
import { COURSE_LOCKED_REASON, quizAccessFor } from "@/lib/lesson-access";
import { QUIZ_RATE_LIMITS, decideQuizAttempt, quizWindowStart } from "@/lib/quiz-rate-limit";
import { checkQuestionIds, hasSubmitShape, normalizeOptions, parseSubmitAnswers, scoreAttempt, toAnswerKey } from "@/lib/student-quizzes";
import { toOriginalAnswers, verifyAttemptToken } from "@/lib/quiz-shuffle";
import { quizKeys } from "@/lib/quiz-shuffle-key";

/**
 * POST /api/quizzes/[quizId]/submit の本体（#32）。採点はサーバーだけで行い、正解は返さない。
 *
 * - 認証は route（src/app/api/quizzes/[quizId]/submit/route.ts）が行い、セッションの userId を渡す。
 *   body の userId は読まない。応答・ログに回答・正解を含めない
 * - attemptsEnabled が false のとき（QUIZ_ATTEMPTS_ENABLED。#51 で公開し、いまは緊急時に止めるためのスイッチ）は、
 *   入力も DB も見ずに 503 attempts_disabled を返す（Tec 決定、2026-10-07）
 * - 受講生（role が INSTRUCTOR 以外。role がなくても受講生として扱う）は、入力の形を確かめたあと、
 *   問題を読む前にクイズのコースのロックを確かめる。ロック中なら 403 course_locked で、正解を読まず・採点も保存もしない。
 *   コースのないクイズは 404（#47 P5、Tec 決定 D-a・F-a）。講師はロックを見ない
 * - 受験の公開前の修正（#51、Tec 決定 2026-10-15）。判定の順（DB をなるべく読まない順）：
 *   1. 503 attempts_disabled → 2. quizId（400）→ 3. JSON（400 invalid_json）
 *   → 4. 形（hasSubmitShape。400 invalid_answers / invalid_question_ids / invalid_attempt_token。DB は読まない）
 *   → 5. 受講生のロック（404 / 403 course_locked）→ 6. クイズ（404）→ 7. 受験できない（409 quiz_unavailable）
 *   → 8. questionIds がサーバーの並びと違う（409 quiz_changed。answers の長さより先に見て、400 と取り違えない）
 *   → 8b. attemptToken の MAC が合わない（409 quiz_changed。別のユーザー・クイズのトークン、改ざん、受験中の選択肢の変更）
 *   → 9. answers の中身（400 invalid_answers。表示位置の範囲）。そのあと表示位置を元の位置に戻す（#51 選択肢のシャッフル）。
 *      以降の重複判定・採点・保存は元の位置だけを使う（受験記録の answers は元の位置）
 *   → 10. 直近 24 時間の自分の受験記録で判定（decideQuizAttempt）
 *      - 重複（直近 1 件と同じ回答で間隔の内側）：記録せず、送られた回答を今の正解で採点して 200 duplicate: true
 *      - 間隔・回数の上限：429 rate_limited（retryAfterSeconds と Retry-After）。講師は上限を受けない（重複の判定は受ける。Q2 a）
 *   → 11. 採点して保存し、200 duplicate: false
 *   429・409 の本文には点数・正誤・正解・問題の id を入れない。
 *   同時に送られた受験は、記録を読んでから書くまでの間に並ぶと両方とも通る（Q4 a で許容。CLAUDE.md に記載）
 * - 選択肢のシャッフル（#51 追加修正、Tec 決定 2026-10-19）：鍵は AUTH_SECRET から作る（quiz-shuffle-key）。
 *   未設定なら形の確認のあと DB を読まずに 500。トークン・nonce・並べ替え・回答はログにも本文にも出さない。
 *   トークンに有効期限はない（Q3 a）。講師も同じ手順（Q2 a）
 * - route ファイルは GET / POST など決まった名前以外を export できないので、本体はここに置く。
 *   テストは attemptsEnabled: true を渡して採点・保存を確かめる。now はテスト用（省略時は new Date()）
 */
export async function handleQuizSubmit(
  userId: string,
  request: Request,
  { params }: { params: Promise<{ quizId: string }> },
  { attemptsEnabled, role, now }: { attemptsEnabled: boolean; role: string | null | undefined; now?: Date }
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

    // 形が違う body は DB を読まずに断る（answers の長さ・範囲と questionIds の中身は問題を読んでから確かめる）
    const shape = hasSubmitShape(body);
    // tsconfig は strict: false なので ok では絞り込めない。"reason" in で失敗側に絞る
    if ("reason" in shape) {
      return NextResponse.json({ error: "Invalid request", reason: shape.reason }, { status: 400 });
    }

    const keys = quizKeys();

    const isStudent = role !== "INSTRUCTOR";
    if (isStudent) {
      const access = await quizAccessFor(prisma, userId, quizId);
      if (access === "not_found") {
        return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
      }
      if (access === "locked") {
        return NextResponse.json({ error: "Forbidden", reason: COURSE_LOCKED_REASON }, { status: 403 });
      }
    }

    const quiz = await prisma.quiz.findUnique({
      where: { id: quizId },
      select: {
        id: true,
        type: true,
        // GET /api/quizzes/[quizId] と同じ並び
        questions: {
          orderBy: [{ order: "asc" }, { id: "asc" }],
          select: { id: true, options: true, correctIndex: true },
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

    if (!checkQuestionIds(shape.value.questionIds, quiz.questions.map((q) => q.id))) {
      return NextResponse.json({ error: "Conflict", reason: "quiz_changed" }, { status: 409 });
    }

    // toAnswerKey が通っているので options はすべて正しい（null にならない）。GET と同じく元の並びで MAC を確かめる
    const digestQuestions = quiz.questions.map((q) => ({ id: q.id, options: normalizeOptions(q.options) ?? [] }));
    const nonce = verifyAttemptToken(keys, shape.value.attemptToken, { userId, quizId: quiz.id, questions: digestQuestions });
    if (nonce === null) {
      return NextResponse.json({ error: "Conflict", reason: "quiz_changed" }, { status: 409 });
    }

    const parsed = parseSubmitAnswers(body, key.optionCounts);
    if ("reason" in parsed) {
      return NextResponse.json({ error: "Invalid request", reason: parsed.reason }, { status: 400 });
    }
    // 表示位置 → 元の位置。ここから先は元の位置だけを使う
    const answers = toOriginalAnswers(
      keys.shuffleKey,
      { userId, quizId: quiz.id, nonce },
      quiz.questions.map((q, i) => ({ id: q.id, optionCount: key.optionCounts[i] })),
      parsed.value
    );

    const at = now ?? new Date();
    const recent = await prisma.quizAttempt.findMany({
      where: { userId, quizId: quiz.id, createdAt: { gt: quizWindowStart(at) } },
      select: { answers: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: QUIZ_RATE_LIMITS[quiz.type].dailyLimit,
    });
    const decision = decideQuizAttempt(recent, answers, quiz.type, at);

    // 講師は間隔・回数の上限を受けない（重複は decideQuizAttempt が先に判定済み。Tec 決定 Q2 a）
    if (decision.kind === "rate_limited" && isStudent) {
      return NextResponse.json(
        { error: "Too many requests", reason: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } }
      );
    }

    const { score, passed, total, correct, results } = scoreAttempt(answers, key.correctIndexes);

    if (decision.kind === "duplicate") {
      // 前回の送信が届いていた再送。記録は増やさず、同じ回答の結果をもう一度返す（新しい正誤の情報は出ない）
      return NextResponse.json({ score, passed, total, correct, results, duplicate: true });
    }

    await prisma.quizAttempt.create({
      data: { userId, quizId: quiz.id, score, passed, answers },
      select: { id: true },
    });

    return NextResponse.json({ score, passed, total, correct, results, duplicate: false });
  } catch (error) {
    console.error("POST /api/quizzes/[quizId]/submit error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
