/**
 * 講師の質問・返信の削除 API（DELETE /api/admin/comments/[id]、#47 P1）の判定・応答・ログの文面。
 *
 * DB・時計・DOM に触れない関数だけを置く（子孫の収集は、子の id を読む関数を引数で受け取る）。
 *
 * Tec の決定（#47、2026-10-14）：
 * - 物理削除。質問・返信を消すときは、その下の返信（子孫）もすべて同じトランザクションで明示的に消す
 *   （Comment.parentId の FK は ON DELETE SET NULL なので、親だけを消すと返信が質問として残る。
 *   #32 より前の POST /api/comments は parentId を検証していなかったので、返信への返信もありうる）
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
  /** 質問と、その返信をすべて削除した（deletedReplies は削除した子孫の返信の総数。別レッスンの lessonId を持つ古い返信・返信への返信も数える） */
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

/** 子孫の返信をたどる深さの上限（直下の返信が 1 段目）。これより深い返信があれば例外にする */
export const MAX_REPLY_DEPTH = 10;

/** 子孫が MAX_REPLY_DEPTH 段より深い（route では 500 になり、削除はロールバックされる） */
export class ReplyTreeTooDeepError extends Error {
  constructor() {
    super("Reply tree is deeper than the limit");
    this.name = "ReplyTreeTooDeepError";
  }
}

/**
 * rootId の子孫（返信・返信への返信…）の id を、浅い順にすべて集める。rootId 自身は含めない。
 * findChildIds は「parentId が parentIds のどれかである行の id」を返す関数（route では同じトランザクションの findMany）。
 * - 一度見た id は二度と数えない（parentId の循環があっても止まる）
 * - MAX_REPLY_DEPTH 段を超える子孫があれば ReplyTreeTooDeepError を投げる
 */
export async function collectDescendantIds(
  rootId: string,
  findChildIds: (parentIds: string[]) => Promise<string[]>,
  maxDepth: number = MAX_REPLY_DEPTH
): Promise<string[]> {
  const seen = new Set<string>([rootId]);
  const out: string[] = [];
  let frontier = [rootId];
  for (let depth = 0; ; depth++) {
    const next: string[] = [];
    for (const id of await findChildIds(frontier)) {
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(id);
    }
    if (next.length === 0) return out;
    if (depth >= maxDepth) throw new ReplyTreeTooDeepError();
    out.push(...next);
    frontier = next;
  }
}
