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

// ───────────── 受講生の質問の投稿（#46 B-2。POST /api/comments） ─────────────
//
// 講師の回答欄（A-2）の文言（REASON_MESSAGES・commentSubmitErrorMessage）は変えず、受講生向けの文言をここに足す。
// サーバーの拒否（#46 B-1）：403 forbidden_role / reply_not_allowed / course_locked、409 duplicate、
// 429 rate_limited（retryAfterSeconds と Retry-After）、400 は parseCreateComment の reason、404 はレッスンがない。

/** 質問を投稿する API */
export const QUESTION_POST_URL = "/api/comments";

/** 投稿できたときの知らせ（role="status" で読み上げる） */
export const QUESTION_POSTED_MESSAGE = "質問を投稿しました。";

/**
 * 送信できたかどうか分からない（通信エラー・502 / 503 / 504・ログイン以外へのリダイレクト）ときの文言。
 * 画面は質問の一覧を読み直す。再送しても、直前の自分の投稿と同じ本文なら 60 秒以内はサーバーが 409 duplicate で断るので、
 * 「一覧になければ送り直してよい。届いていれば送信済みと知らせる」と案内する（それより後の再送までは守れないので「直後に」と書く）
 */
export const QUESTION_UNKNOWN_RESULT_MESSAGE =
  "送信できたかどうか確かめられませんでした。質問の一覧を読み直したので、一覧に表示されていなければ、もう一度送信してください。直後に同じ内容を送り直した場合、すでに届いていれば「送信済み」とお知らせします。";

/** 409 duplicate（60 秒以内に直前の自分の投稿と同じ本文） */
export const QUESTION_DUPLICATE_MESSAGE = "同じ内容の質問を送信済みです。質問の一覧をご確認ください。";

/**
 * 429 rate_limited。待ち時間は言い切らない（直前の投稿の日時が未来だと、Retry-After を待っても 429 が続くことがある）。
 * retryAfterSeconds はおおよその目安として retryAfterHint で添える
 */
export const QUESTION_RATE_LIMITED_MESSAGE = "続けて投稿できません。しばらく待ってからもう一度お試しください。";

/** 403 course_locked（#69 で開けないはずだが、念のため扱う） */
export const QUESTION_COURSE_LOCKED_MESSAGE = "このコースはまだ解放されていません。";

const QUESTION_FORBIDDEN_MESSAGES: Readonly<Record<string, string>> = {
  forbidden_role: "講師のアカウントからは質問を投稿できません。回答は「質問対応」から行ってください。",
  reply_not_allowed: "返信は投稿できません。新しい質問として投稿してください。",
  course_locked: QUESTION_COURSE_LOCKED_MESSAGE,
};

/** 400 のうち、講師の回答欄と同じ文言を使う reason（本文の検証と JSON の形） */
const SHARED_BAD_REQUEST_REASONS: ReadonlySet<string> = new Set(["empty", "too_long", "invalid_content", "invalid_body"]);

const QUESTION_LESSON_UNKNOWN_MESSAGE = "このレッスンを確かめられませんでした。画面を再読み込みしてから、もう一度お試しください。";

/**
 * 429 の retryAfterSeconds を、おおよその目安の文言にする（例「（目安：約 30 秒後）」）。
 * 正の有限な数でなければ空文字（目安を出さない）。60 秒未満は秒、60 分未満は分、それ以上は時間（いずれも切り上げ）
 */
export function retryAfterHint(seconds: unknown): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  const s = Math.ceil(seconds);
  if (s < 60) return `（目安：約 ${s} 秒後）`;
  if (s < 3600) return `（目安：約 ${Math.ceil(s / 60)} 分後）`;
  return `（目安：約 ${Math.ceil(s / 3600)} 時間後）`;
}

/**
 * 受講生の質問の送信に失敗したときの文言。
 * - httpStatus が null・502 / 503 / 504：送信できたか分からない（QUESTION_UNKNOWN_RESULT_MESSAGE）
 * - 401 / redirected：ログインの期限切れ（講師の回答欄と同じ）
 * - 400：本文の検証は講師の回答欄と同じ文言。invalid_lesson_id は再読み込みの案内。それ以外は invalid_body と同じ
 * - 403：reason ごと（forbidden_role / reply_not_allowed / course_locked）。知らない reason は権限なし
 * - 404：レッスンが見つからない
 * - 409 duplicate：送信済み / 429：続けて投稿できない（目安の秒数を添える）
 * - それ以外（500 など）：サーバーのエラー
 */
export function questionSubmitErrorMessage(input: {
  httpStatus: number | null;
  reason?: unknown;
  retryAfterSeconds?: unknown;
  redirected?: boolean;
}): string {
  const { httpStatus, reason, retryAfterSeconds, redirected } = input;
  if (httpStatus === null || UNKNOWN_RESULT_STATUSES.has(httpStatus)) return QUESTION_UNKNOWN_RESULT_MESSAGE;
  if (redirected === true || httpStatus === 401) return COMMENT_SESSION_EXPIRED_MESSAGE;
  const knownReason = typeof reason === "string" ? reason : null;
  if (httpStatus === 400) {
    if (knownReason === "invalid_lesson_id") return QUESTION_LESSON_UNKNOWN_MESSAGE;
    if (knownReason !== null && SHARED_BAD_REQUEST_REASONS.has(knownReason)) return REASON_MESSAGES[knownReason];
    return REASON_MESSAGES.invalid_body;
  }
  if (httpStatus === 403) {
    if (knownReason !== null && Object.prototype.hasOwnProperty.call(QUESTION_FORBIDDEN_MESSAGES, knownReason)) {
      return QUESTION_FORBIDDEN_MESSAGES[knownReason];
    }
    return "この操作を行う権限がありません。";
  }
  if (httpStatus === 404) return "このレッスンが見つかりませんでした。画面を再読み込みしてください。";
  if (httpStatus === 409 && knownReason === "duplicate") return QUESTION_DUPLICATE_MESSAGE;
  if (httpStatus === 429) return QUESTION_RATE_LIMITED_MESSAGE + retryAfterHint(retryAfterSeconds);
  return COMMENT_SERVER_ERROR_MESSAGE;
}

/**
 * 送信の結果。
 * - success：投稿できた（入力を空にし、一覧を読み直す）
 * - error：入力を残して message を出す。reload が true なら一覧も読み直す
 *   （送信できたか分からないとき・送信済み〔409〕のとき。自分の質問が一覧にあるかを見せるため）
 */
export type QuestionPostOutcome = { kind: "success" } | { kind: "error"; message: string; reload: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST /api/comments の応答を解釈する。response が null なら通信エラー（authFetch が例外を投げた）。
 * - redirected：/login への移動（期限切れ。expired で判定済みのもの）はログインの期限切れ、それ以外の移動は結果不明
 * - 2xx（リダイレクトなし）：投稿できた（201 の本文は使わない。一覧を読み直して表示する）
 * - それ以外：questionSubmitErrorMessage
 */
export function interpretQuestionPostResponse(
  response: { ok: boolean; status: number; redirected: boolean; expired: boolean; body: unknown } | null
): QuestionPostOutcome {
  if (response === null) return { kind: "error", message: QUESTION_UNKNOWN_RESULT_MESSAGE, reload: true };
  const { ok, status, redirected, expired, body } = response;
  if (expired) return { kind: "error", message: COMMENT_SESSION_EXPIRED_MESSAGE, reload: false };
  if (redirected) return { kind: "error", message: QUESTION_UNKNOWN_RESULT_MESSAGE, reload: true };
  if (ok) return { kind: "success" };
  const reason = isRecord(body) ? body.reason : undefined;
  const retryAfterSeconds = isRecord(body) ? body.retryAfterSeconds : undefined;
  const message = questionSubmitErrorMessage({ httpStatus: status, reason, retryAfterSeconds });
  const reload = message === QUESTION_UNKNOWN_RESULT_MESSAGE || message === QUESTION_DUPLICATE_MESSAGE;
  return { kind: "error", message, reload };
}

/** 送る本文。lessonId と content だけ（parentId は送らない：受講生は親の質問だけ投稿できる） */
export function questionPostBody(lessonId: string, content: string): string {
  return JSON.stringify({ lessonId, content });
}
