import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { isValidId } from "@/lib/lesson-comments";
import {
  parsePatchQuestionBody,
  patchQuestionResponse,
  planQuestionEdit,
  questionUpdatedLogMessage,
  toAdminQuizQuestion,
  type AdminQuestionRow,
  type ChangedField,
  type PatchQuestionReason,
} from "@/lib/admin-quizzes";
import { questionRevision } from "@/lib/admin-quiz-revision";

function noStoreJson(body: unknown, init: { status: number }) {
  return NextResponse.json(body, { status: init.status, headers: { "Cache-Control": "no-store" } });
}

/** updateMany の条件に使う、読んだ options の値（JSON の null は Prisma.JsonNull で表す） */
function jsonEquals(value: Prisma.JsonValue): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : value;
}

type EditOutcome =
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "invalid"; reason: PatchQuestionReason }
  | { kind: "ok"; row: AdminQuestionRow; changed: ChangedField[]; attemptCount: number };

// 確認テストの問題の修正（#81 Q1）。講師専用（未ログインは 401、講師以外は 403。どちらも DB を読む前に返す）。
// 変えられるのは問題文・選択肢の文（2〜10 件）・正解だけ（D1 a）。order・quizId などほかの項目は 400 unknown_field。
// 過去の受験記録は再採点しない（D2 a。件数だけを返す）。旧 PUT・DELETE は #81 Q3 で閉じた（戻さない）。
// 手順（1 つのトランザクション）：
// 1. 行を読む。なければ 404
// 2. revision（内容の sha256）が送られた値と違えば 409 edit_conflict（D4 a）
// 3. 変更後の値を確かめる（正解の位置は変更後の選択肢の範囲内）。何も変わらなければ 400 no_changes（履歴は書かない）
// 4. 読んだ値と同じことを条件に updateMany。件数が 0 なら、読んでから書くまでに別の講師が直したので 409 edit_conflict
// 5. QuizQuestionRevision を 1 行 insert（changedFields は 1 件以上、before / after は {question, options, correctIndex}。D3 b）
// 6. 受験記録の件数を数えて返す
// body の形（DB を読まずに分かるもの）は先に確かめて 400 を返す。理由は src/lib/admin-quizzes.ts の parsePatchQuestionBody。
// 応答は PatchQuestionResponse（許可リストで組み立てる）。ログは固定文と変わった項目の名前だけ（id・本文・選択肢は出さない）。
// 応答は Cache-Control: no-store
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return noStoreJson({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.user.role !== "INSTRUCTOR") {
      return noStoreJson({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    if (!isValidId(id)) {
      return noStoreJson({ error: "Invalid request", reason: "invalid_id" }, { status: 400 });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return noStoreJson({ error: "Invalid request", reason: "invalid_json" }, { status: 400 });
    }
    const parsed = parsePatchQuestionBody(raw);
    // tsconfig は strict: false なので ok では絞り込めない。"reason" in で失敗側に絞る（quiz-submit.ts と同じ）
    if ("reason" in parsed) {
      return noStoreJson({ error: "Invalid request", reason: parsed.reason }, { status: 400 });
    }
    const input = parsed.value;
    const editorId = session.user.id;

    const outcome = await prisma.$transaction(async (tx): Promise<EditOutcome> => {
      const current = await tx.quizQuestion.findUnique({
        where: { id },
        select: { id: true, quizId: true, order: true, question: true, options: true, correctIndex: true },
      });
      if (!current) return { kind: "not_found" };
      if (questionRevision(current) !== input.revision) return { kind: "conflict" };

      const plan = planQuestionEdit(current, input);
      if ("reason" in plan) return { kind: "invalid", reason: plan.reason };
      const { data, changed, before, after } = plan.value;

      const updated = await tx.quizQuestion.updateMany({
        where: {
          id: current.id,
          question: current.question,
          correctIndex: current.correctIndex,
          options: { equals: jsonEquals(current.options) },
        },
        data,
      });
      if (updated.count !== 1) return { kind: "conflict" };

      await tx.quizQuestionRevision.create({
        data: {
          questionId: current.id,
          quizId: current.quizId,
          editorId,
          changedFields: changed,
          // オブジェクトの中の JSON の null はそのまま書ける（Prisma.JsonNull が要るのは値そのものが null のときだけ）
          before: { question: before.question, options: before.options, correctIndex: before.correctIndex },
          after: { question: after.question, options: after.options, correctIndex: after.correctIndex },
        },
        select: { id: true },
      });

      const attemptCount = await tx.quizAttempt.count({ where: { quizId: current.quizId } });
      return {
        kind: "ok",
        row: { id: current.id, order: current.order, question: after.question, options: after.options, correctIndex: after.correctIndex },
        changed,
        attemptCount,
      };
    });

    if (outcome.kind === "not_found") {
      return noStoreJson({ error: "Question not found" }, { status: 404 });
    }
    if (outcome.kind === "conflict") {
      return noStoreJson({ error: "Conflict", reason: "edit_conflict" }, { status: 409 });
    }
    if (outcome.kind === "invalid") {
      return noStoreJson({ error: "Invalid request", reason: outcome.reason }, { status: 400 });
    }

    console.info(questionUpdatedLogMessage(outcome.changed));
    const question = toAdminQuizQuestion(outcome.row, questionRevision(outcome.row));
    return noStoreJson(patchQuestionResponse(question, outcome.changed, outcome.attemptCount), { status: 200 });
  } catch (error) {
    const summary = safeErrorSummary(error);
    if (summary.code === "P2025") {
      return noStoreJson({ error: "Question not found" }, { status: 404 });
    }
    console.error("PATCH /api/admin/questions/[id] error:", summary.name);
    return noStoreJson({ error: "Internal server error" }, { status: 500 });
  }
}
