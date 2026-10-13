/**
 * 講師の回答 API（POST /api/admin/comments/[id]/replies、#32 A-1）の入力検証・通知の判定と文面。
 *
 * DB・時計・DOM に触れない純粋関数だけを置く。
 *
 * Tec の決定（#32、2026-10-09）：
 * - 回答は講師専用の API に分ける（INSTRUCTOR 以外は 403）
 * - 無効化された受講生の質問にも回答できる。ただし通知は作らない
 * - 通知の文面は固定の「質問に回答がありました」に、コース名とレッスン名を添える（講師の名前と質問の本文は入れない）
 * - 回答の編集・削除は作らない
 */

import { isValidId, parseCommentContent, type CommentContentReason, type ParseResult } from "./lesson-comments";

/** 回答の通知のタイトル（固定） */
export const REPLY_NOTIFICATION_TITLE = "質問に回答がありました";

/** 回答の通知の本文。コース名とレッスン名だけを入れる（講師の名前・質問の本文は入れない） */
export function replyNotificationMessage(courseName: string, lessonTitle: string): string {
  return `${courseName} / ${lessonTitle} の質問に講師が回答しました`;
}

/** 通知の判定に使う、親の質問の投稿者 */
export type QuestionAuthor = { id: string; role: string; deactivatedAt: Date | null };

/**
 * 質問の投稿者に回答の通知を作るか。次のすべてを満たすときだけ true：
 * - 投稿者が回答者本人ではない
 * - 投稿者が STUDENT
 * - 投稿者が無効化されていない
 */
export function shouldNotifyQuestionAuthor(author: QuestionAuthor, replierId: string): boolean {
  return author.id !== replierId && author.role === "STUDENT" && author.deactivatedAt === null;
}

/** 回答の入力 */
export type ReplyInput = { content: string };

export type ReplyReason = "invalid_body" | CommentContentReason;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST /api/admin/comments/[id]/replies の body を検証する。content だけを使い、他の項目（userId・lessonId など）は無視する。
 * content の規則は POST /api/comments と同じ（parseCommentContent）
 */
export function parseReplyBody(body: unknown): ParseResult<ReplyInput, ReplyReason> {
  if (!isPlainObject(body)) return { ok: false, reason: "invalid_body" };
  const content = parseCommentContent(body.content);
  // tsconfig は strict: false なので ok では絞り込めない。"reason" in で失敗側に絞る
  if ("reason" in content) return { ok: false, reason: content.reason };
  return { ok: true, value: { content: content.value } };
}

/** 親の質問の id（URL の [id]）。空でない string で 64 文字以内 */
export function isValidQuestionId(value: unknown): value is string {
  return isValidId(value);
}
