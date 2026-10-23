/**
 * 確認テストの問題の修正（#81 Q1）の DB の処理。問題の PATCH の route がトランザクションの中で呼ぶ。
 * route から移したのは、本物の DB（ローカル DB）で scripts/verify-quiz-admin-db.ts から同じ処理を確かめるため。
 * （admin-closed-apis.test.ts が src の中の管理用クイズ API のパスを呼び出し元とみなすため、ここにはパスを書かない）
 *
 * revision の計算（node:crypto）は引数の revisionOf で受け取る。このファイルは admin-quiz-revision を import しない
 * （admin-quizzes.test.ts の import の境界：admin-quiz-revision を import するのは route だけ）。
 * 画面（src/app/page.tsx など）から import しない（@prisma/client の値を使うサーバー専用のファイル）。
 */

import { Prisma } from "@prisma/client";
import {
  planQuestionEdit,
  type AdminQuestionRow,
  type ChangedField,
  type PatchQuestionInput,
  type PatchQuestionReason,
  type QuestionContent,
} from "./admin-quizzes";

export type EditOutcome =
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "invalid"; reason: PatchQuestionReason }
  | { kind: "ok"; row: AdminQuestionRow; changed: ChangedField[]; attemptCount: number };

export type EditQuizQuestionArgs = {
  id: string;
  /** parsePatchQuestionBody で検証済みの入力 */
  input: PatchQuestionInput;
  /** 履歴（QuizQuestionRevision.editorId）に書く講師の id */
  editorId: string;
  /** 内容の revision（route は admin-quiz-revision の questionRevision を渡す） */
  revisionOf: (content: QuestionContent) => string;
};

/** updateMany の条件に使う、読んだ options の値（JSON の null は Prisma.JsonNull で表す） */
function jsonEquals(value: Prisma.JsonValue): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : value;
}

/**
 * 1 つのトランザクション（tx）の中で問題を修正する。手順：
 * 1. 行を読む。なければ not_found
 * 2. revision が送られた値と違えば conflict（D4 a）
 * 3. 変更後の値を確かめる（正解の位置は変更後の選択肢の範囲内）。何も変わらなければ invalid（no_changes。履歴は書かない）
 * 4. 読んだ値と同じことを条件に updateMany。件数が 0 なら、読んでから書くまでに別の講師が直したので conflict
 * 5. QuizQuestionRevision を 1 行 insert（changedFields は 1 件以上、before / after は {question, options, correctIndex}。D3 b）
 * 6. 受験記録の件数を数えて返す
 */
export async function editQuizQuestion(tx: Prisma.TransactionClient, args: EditQuizQuestionArgs): Promise<EditOutcome> {
  const { id, input, editorId, revisionOf } = args;

  const current = await tx.quizQuestion.findUnique({
    where: { id },
    select: { id: true, quizId: true, order: true, question: true, options: true, correctIndex: true },
  });
  if (!current) return { kind: "not_found" };
  if (revisionOf(current) !== input.revision) return { kind: "conflict" };

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
}
