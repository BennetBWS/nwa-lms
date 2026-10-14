/**
 * 講師の質問・返信の削除 API（DELETE /api/admin/comments/[id]、#47 P1）の判定・応答・ログの文面。
 *
 * DB・時計・DOM に触れない純粋関数だけを置く。
 *
 * Tec の決定（#47、2026-10-14）：
 * - 物理削除。質問を消すときは、その返信も同じトランザクションで明示的に消す
 *   （Comment.parentId の FK は ON DELETE SET NULL なので、親だけを消すと返信が質問として残る）
 * - 削除できるのは講師だけ（受講生が自分の投稿を消す API は作らない）
 * - 既に送った「質問に回答がありました」の通知は残す（通知はコメントを参照していない）
 * - 監査は固定文のログだけ（id・本文・名前は出さない）
 */

import type { QuestionThreadView } from "./question-threads";

/** 削除の対象の種類。parentId が null なら質問、それ以外は返信 */
export type DeletedCommentKind = "question" | "reply";

export function deletedCommentKind(row: { parentId: string | null }): DeletedCommentKind {
  return row.parentId === null ? "question" : "reply";
}

/** 200 の応答 */
export type DeleteCommentRes =
  /** 質問と、その返信をすべて削除した（deletedReplies は削除した返信の数。別レッスンの lessonId を持つ古い返信も数える） */
  | { kind: "question"; id: string; deletedReplies: number }
  /** 返信を 1 件削除した。thread は削除後のスレッド（GET /api/comments の 1 件と同じ形。answered が false に戻ることもある） */
  | { kind: "reply"; id: string; thread: QuestionThreadView };

export function questionDeletedResponse(id: string, deletedReplies: number): DeleteCommentRes {
  return { kind: "question", id, deletedReplies };
}

export function replyDeletedResponse(id: string, thread: QuestionThreadView): DeleteCommentRes {
  return { kind: "reply", id, thread };
}

/** 削除に成功したときのログ（固定文。id・本文・名前は出さない） */
export const DELETE_LOG_MESSAGE: Readonly<Record<DeletedCommentKind, string>> = {
  question: "[admin] question deleted",
  reply: "[admin] reply deleted",
};
