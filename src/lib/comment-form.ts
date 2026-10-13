/**
 * 質問・回答の入力欄（#32 A-2 の講師の回答欄、#46 B-2 の受講生の質問欄で共通）の状態とエラー文言。
 *
 * DB・時計・DOM・React に触れない純粋関数だけを置く。
 *
 * 入力欄の決まり（設計メモ #32 A / #46 B）：
 * - textarea。文字数を表示し、2000 字（COMMENT_MAX_LENGTH）まで
 * - 文字数と空の判定はサーバー（lesson-comments の parseCommentContent）と同じ：前後の空白を除いてから数える。
 *   見える文字がなければ空として扱う
 * - 空・上限超え・送信中は送信できない
 * - Enter では送信しない（日本語 IME の確定の Enter と区別するため。送信はボタンだけ）
 * - 失敗したら入力を残し、ここで決めた文言を出す
 */

import { COMMENT_MAX_LENGTH, commentLength, hasVisibleText } from "./lesson-comments";

export { COMMENT_MAX_LENGTH };

export type CommentFormState = {
  /** 前後の空白を除いた文字数（サロゲートペアは 1 文字。サーバーと同じ数え方） */
  length: number;
  /** 空（見える文字がない） */
  empty: boolean;
  /** 2000 字を超えている */
  tooLong: boolean;
  /** 送信ボタンを押せる（空でない・上限以内・送信中でない） */
  canSubmit: boolean;
  /** 文字数の表示（例「12 / 2000」。超えたら「2001 / 2000（1 文字オーバー）」） */
  counterLabel: string;
};

/** 入力欄の状態。value が string でなければ空として扱う */
export function commentFormState(value: unknown, sending: boolean): CommentFormState {
  const text = typeof value === "string" ? value.trim() : "";
  const length = commentLength(text);
  const empty = text === "" || !hasVisibleText(text);
  const tooLong = length > COMMENT_MAX_LENGTH;
  const over = length - COMMENT_MAX_LENGTH;
  return {
    length,
    empty,
    tooLong,
    canSubmit: !empty && !tooLong && !sending,
    counterLabel: tooLong
      ? `${length} / ${COMMENT_MAX_LENGTH}（${over} 文字オーバー）`
      : `${length} / ${COMMENT_MAX_LENGTH}`,
  };
}

// ───────────── 送信に失敗したときの文言 ─────────────

export const COMMENT_SESSION_EXPIRED_MESSAGE = "ログインの有効期限が切れました。再度ログインしてください。";
export const COMMENT_NETWORK_ERROR_MESSAGE =
  "通信エラーが発生しました。送信できたかどうか一覧を再読み込みして確かめてから、もう一度お試しください。";
export const COMMENT_UNKNOWN_RESULT_MESSAGE =
  "送信できたかどうか確かめられませんでした。一覧を再読み込みして確かめてください。";
export const COMMENT_SERVER_ERROR_MESSAGE = "サーバーでエラーが発生しました。時間をおいて、もう一度お試しください。";

/**
 * ゲートウェイ・プロキシのエラー（502 / 503 / 504）。アプリが処理を終えたかどうか分からない
 * （処理中にタイムアウトした・応答だけが届かなかった）ため、送信の結果は不明として扱う
 */
const UNKNOWN_RESULT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * 送信できたかどうか分からない失敗（通信エラー・502 / 503 / 504・2xx なのに応答を読めない）の文言か。
 * このときは再送ではなく一覧の再読み込みで確かめるよう案内し、画面は「一覧を再読み込み」ボタンを出す（#32 A-2）。
 * 400 / 401 / 403 / 404 / 500 などの文言は false（サーバーが受け付けなかったと分かっている）
 */
export function isUncertainSubmitError(message: unknown): boolean {
  return message === COMMENT_NETWORK_ERROR_MESSAGE || message === COMMENT_UNKNOWN_RESULT_MESSAGE;
}

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  empty: "本文を入力してください。",
  too_long: `本文は ${COMMENT_MAX_LENGTH} 文字以内で入力してください。`,
  invalid_content: "送信内容を読み取れませんでした。画面を再読み込みして、もう一度お試しください。",
  invalid_body: "送信内容を読み取れませんでした。画面を再読み込みして、もう一度お試しください。",
  invalid_id: "送信先の質問を確かめられませんでした。一覧を再読み込みしてください。",
  not_a_question: "この投稿には回答できません。一覧を再読み込みしてください。",
};

/**
 * 送信に失敗したときの文言。
 * - httpStatus が null：通信エラー（送信できたか分からないので、再読み込みで確かめるよう案内する）
 * - 401 / redirected：ログインの期限切れ（画面は authFetch がサインアウトして /login へ移る）
 * - 400：reason ごとの文言（知らない reason は「送信内容を読み取れませんでした」）
 * - 403：権限なし / 404：質問が見つからない
 * - 502 / 503 / 504：送信できたか分からない（COMMENT_UNKNOWN_RESULT_MESSAGE。再読み込みで確かめるよう案内する）
 * - それ以外（500 など）：サーバーのエラー
 */
export function commentSubmitErrorMessage(input: { httpStatus: number | null; reason?: unknown; redirected?: boolean }): string {
  const { httpStatus, reason, redirected } = input;
  if (httpStatus === null) return COMMENT_NETWORK_ERROR_MESSAGE;
  if (redirected === true || httpStatus === 401) return COMMENT_SESSION_EXPIRED_MESSAGE;
  if (httpStatus === 400) {
    if (typeof reason === "string" && Object.prototype.hasOwnProperty.call(REASON_MESSAGES, reason)) {
      return REASON_MESSAGES[reason];
    }
    return REASON_MESSAGES.invalid_body;
  }
  if (httpStatus === 403) return "この操作を行う権限がありません。";
  if (httpStatus === 404) return "送信先の質問が見つかりませんでした。一覧を再読み込みしてください。";
  if (UNKNOWN_RESULT_STATUSES.has(httpStatus)) return COMMENT_UNKNOWN_RESULT_MESSAGE;
  return COMMENT_SERVER_ERROR_MESSAGE;
}
