/**
 * 受講生画面（src/app/page.tsx）で、API の 403 { reason: "course_locked" }（#47 P4）を扱う純粋関数と文言。
 *
 * API はロック中のコースの詳細（/api/courses/[courseId]）・完了（POST /api/progress）・質問タブ
 * （/api/comments/[lessonId]）を 403 course_locked で断る。画面はこれを「通信エラー」と区別して表示する。
 * DB・DOM・fetch に触れない。
 */

/** API が返す拒否の理由（lesson-access.ts の COURSE_LOCKED_REASON と同じ値。サーバーのモジュールは import しない） */
export const COURSE_LOCKED = "course_locked";

export const COURSE_LOCKED_TITLE = "このコースはまだ解放されていません";
export const COURSE_LOCKED_DESCRIPTION = "前のコースのレッスンをすべて完了すると開けます。";
/** 完了にしようとしたレッスンのコースがロック中だったとき（楽観更新を戻す） */
export const COMPLETE_LOCKED_MESSAGE = "このコースはまだ解放されていないため、完了にできませんでした";
/** 完了が 403 で断られた（ロック以外）とき */
export const COMPLETE_FORBIDDEN_MESSAGE = "レッスンを完了にできませんでした";

/** 応答が 403 で、本文の reason が course_locked か */
export function isCourseLockedResponse(status: number, body: unknown): boolean {
  return (
    status === 403 &&
    typeof body === "object" &&
    body !== null &&
    (body as { reason?: unknown }).reason === COURSE_LOCKED
  );
}

/** 画面の SWR の fetcher が、ok でない応答で投げるエラー */
export type RequestError = Error & { status: number; courseLocked: boolean };

/** ok でない応答から、投げるエラーを作る（メッセージは状態コードだけ。本文は含めない） */
export function toRequestError(status: number, body: unknown): RequestError {
  const err = new Error(`Request failed (${status})`) as RequestError;
  err.status = status;
  err.courseLocked = isCourseLockedResponse(status, body);
  return err;
}

/** toRequestError が作った、ロック中のコースのエラーか */
export function isCourseLockedError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { courseLocked?: unknown }).courseLocked === true;
}

/**
 * POST /api/progress の応答で、楽観更新を戻すか。
 * - 403 course_locked："course_locked"
 * - それ以外の 403："forbidden"
 * - 403 以外：null（これまでどおり。401 などセッション切れは authFetch がサインアウトする）
 */
export function completeRejection(status: number, body: unknown): "course_locked" | "forbidden" | null {
  if (status !== 403) return null;
  return isCourseLockedResponse(status, body) ? "course_locked" : "forbidden";
}
