/**
 * 確認テストの受験（POST /api/quizzes/[quizId]/submit）の間隔・回数・重複の判定（#51、Tec 決定 2026-10-15）。
 *
 * - ミニテスト（MINI）：前回の受験から 60 秒あける。24 時間に 10 回まで
 * - 修了テスト（FINAL）：前回の受験から 30 分あける。24 時間に 3 回まで
 * - 期間はカレンダーの 1 日ではなく、直近 24 時間（質問の投稿と同じ）
 * - 重複：直近 1 件と同じ回答で、間隔（intervalMs）の内側なら重複（記録せずに結果だけ返す）。
 *   応答が届かずに再送した人が 429 を受けないよう、重複は回数・間隔より先に判定する
 *
 * DB・時計に触れない純粋関数だけを置く。現在時刻は必ず引数 `now` で受け取る。
 * route は自分の、このクイズの受験記録を新しい順に最大 dailyLimit 件（createdAt が now - 24 時間より後）読んで渡す。
 * 同時に送られた受験が両方とも通り抜ける競合は許容する（Tec 決定 Q4 a。DB の関数やロックは使わない）。
 */

import type { QuizType } from "./student-quizzes";

export type QuizRateLimit = { intervalMs: number; dailyLimit: number };

/** クイズの種類ごとの間隔と、24 時間に受けられる回数 */
export const QUIZ_RATE_LIMITS: Readonly<Record<QuizType, Readonly<QuizRateLimit>>> = Object.freeze({
  MINI: Object.freeze({ intervalMs: 60_000, dailyLimit: 10 }),
  FINAL: Object.freeze({ intervalMs: 30 * 60_000, dailyLimit: 3 }),
});

/** 回数を数える期間（ミリ秒）。起点は直近 24 時間 */
export const QUIZ_WINDOW_MS = 24 * 60 * 60 * 1000;

/** route が読む自分の受験記録 1 件（answers は Json のまま） */
export type RecentAttempt = { answers: unknown; createdAt: Date };

export type QuizAttemptDecision =
  | { kind: "ok" }
  | { kind: "duplicate" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

/** 期間の始まり。createdAt がこの時刻より後（gt）の受験を数える */
export function quizWindowStart(now: Date): Date {
  return new Date(now.getTime() - QUIZ_WINDOW_MS);
}

/** 種類の制限。想定外の値なら厳しい方（修了テスト）を使う */
function limitFor(type: QuizType): Readonly<QuizRateLimit> {
  return Object.prototype.hasOwnProperty.call(QUIZ_RATE_LIMITS, type) ? QUIZ_RATE_LIMITS[type] : QUIZ_RATE_LIMITS.FINAL;
}

/** 日時が正しく、期間内の記録を新しい順に並べる */
function recentInWindow<T extends { createdAt: Date }>(recent: ReadonlyArray<T>, nowMs: number): T[] {
  const windowStartMs = nowMs - QUIZ_WINDOW_MS;
  return recent
    .filter((a) => a.createdAt instanceof Date && !Number.isNaN(a.createdAt.getTime()))
    .filter((a) => a.createdAt.getTime() > windowStartMs)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** ミリ秒を秒に切り上げ、1 秒以上・上限以下に収める */
function toRetrySeconds(ms: number, maxMs: number): number {
  const clamped = Math.min(Math.max(ms, 0), maxMs);
  return Math.max(1, Math.ceil(clamped / 1000));
}

/**
 * 間隔と回数の判定（重複は見ない）。sorted は recentInWindow の結果。
 * 送信できるなら null、できないなら待つ秒数（間隔と回数の両方を満たせるまで。大きい方）。
 * 直前の受験の日時が now より後（時計のずれ）なら、経過 0 として扱う
 */
function waitSeconds(sorted: ReadonlyArray<{ createdAt: Date }>, limit: Readonly<QuizRateLimit>, nowMs: number): number | null {
  if (sorted.length === 0) return null;
  const elapsed = Math.max(0, nowMs - sorted[0].createdAt.getTime());
  let waitMs = 0;
  let maxMs = 0;
  if (elapsed < limit.intervalMs) {
    waitMs = limit.intervalMs - elapsed;
    maxMs = limit.intervalMs;
  }
  if (sorted.length >= limit.dailyLimit) {
    // 新しい方から dailyLimit 件目が期間の外に出れば、期間内は dailyLimit - 1 件になる
    const oldest = sorted[limit.dailyLimit - 1].createdAt.getTime();
    const untilFree = oldest + QUIZ_WINDOW_MS - nowMs;
    if (untilFree > waitMs) waitMs = untilFree;
    maxMs = QUIZ_WINDOW_MS;
  }
  if (maxMs === 0) return null;
  return toRetrySeconds(waitMs, maxMs);
}

/** 保存された answers（Json）が、送られた回答と同じ配列か。Json が配列でなければ false */
function sameAnswers(stored: unknown, answers: ReadonlyArray<number>): boolean {
  if (!Array.isArray(stored) || stored.length !== answers.length) return false;
  return answers.every((a, i) => stored[i] === a);
}

/**
 * 受験を記録してよいかの判定。
 * - recent：自分の、このクイズの受験記録（並び順は問わない）。期間外・日時が不正なものは無視する
 * - answers：検証済みの回答（parseSubmitAnswers の値）
 *
 * 判定の順：重複（直近 1 件と同じ回答で、経過が intervalMs 未満）→ 間隔・回数（429）。
 * 経過がちょうど intervalMs なら、同じ回答でも新しい受験として扱う。
 */
export function decideQuizAttempt(
  recent: ReadonlyArray<RecentAttempt>,
  answers: ReadonlyArray<number>,
  type: QuizType,
  now: Date
): QuizAttemptDecision {
  const nowMs = now.getTime();
  const limit = limitFor(type);
  const sorted = recentInWindow(recent, nowMs);
  if (sorted.length > 0) {
    const last = sorted[0];
    const elapsed = Math.max(0, nowMs - last.createdAt.getTime());
    if (elapsed < limit.intervalMs && sameAnswers(last.answers, answers)) return { kind: "duplicate" };
  }
  const wait = waitSeconds(sorted, limit, nowMs);
  return wait === null ? { kind: "ok" } : { kind: "rate_limited", retryAfterSeconds: wait };
}

/**
 * GET /api/quizzes/[quizId] の retryAfterSeconds（Tec 決定 Q3 b）。いま別の回答を送ったら 429 になるなら待つ秒数、
 * ならなければ null。重複は見ない（回答はまだない）。recent は GET が読んでいる受験記録（answers は不要）
 */
export function quizRetryAfterSeconds(
  recent: ReadonlyArray<{ createdAt: Date }>,
  type: QuizType,
  now: Date
): number | null {
  const nowMs = now.getTime();
  return waitSeconds(recentInWindow(recent, nowMs), limitFor(type), nowMs);
}
