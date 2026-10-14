/**
 * 質問の投稿（POST /api/comments）の連投の判定（#46、Tec 決定 2026-10-09）。
 *
 * - 1 件ごとに 30 秒の間隔をあける（直前の自分の投稿から 30 秒未満は拒否）
 * - 24 時間で 20 件まで（直近 24 時間の自分の投稿が 20 件あれば拒否）
 * - 60 秒以内に直前の自分の投稿と同じ本文（前後の空白を除いて比較）を送ったら重複として拒否
 *
 * DB・時計に触れない純粋関数だけを置く。現在時刻は必ず引数 `now` で受け取る。
 * route は自分の投稿を新しい順に最大 COMMENT_DAILY_LIMIT 件（createdAt が now - 24 時間より後）読んで渡す。
 * 同時に送られた投稿が両方とも通り抜ける競合は許容する（DB の関数やロックは使わない）。
 */

/** 投稿の間隔（ミリ秒） */
export const COMMENT_INTERVAL_MS = 30_000;

/** 回数を数える期間（ミリ秒） */
export const COMMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 期間内に投稿できる件数 */
export const COMMENT_DAILY_LIMIT = 20;

/** 同じ本文を重複とみなす期間（ミリ秒） */
export const COMMENT_DUPLICATE_MS = 60_000;

/** route が読む自分の投稿 1 件 */
export type RecentComment = { content: string; createdAt: Date };

export type CommentRateDecision =
  | { kind: "ok" }
  | { kind: "duplicate" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

/** 期間の始まり。createdAt がこの時刻より後（gt）の投稿を数える */
export function commentWindowStart(now: Date): Date {
  return new Date(now.getTime() - COMMENT_WINDOW_MS);
}

/** ミリ秒を秒に切り上げ、1 秒以上・上限以下に収める */
function toRetrySeconds(ms: number, maxMs: number): number {
  const clamped = Math.min(Math.max(ms, 0), maxMs);
  return Math.max(1, Math.ceil(clamped / 1000));
}

/**
 * 連投の判定。
 * - recent：自分の投稿（並び順は問わない）。期間外・日時が不正なものは無視する
 * - content：これから投稿する本文（parseCreateComment で trim 済み）
 *
 * 判定の順：重複（409）→ 回数・間隔（429）。
 * 429 の retryAfterSeconds は、間隔と回数の両方を満たせるまでの秒数（大きい方）。
 * 直前の投稿の日時が now より後（時計のずれ）なら、経過 0 秒として扱う。
 */
export function decideCommentRate(
  recent: ReadonlyArray<RecentComment>,
  content: string,
  now: Date
): CommentRateDecision {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - COMMENT_WINDOW_MS;
  const times = recent
    .filter((c) => c.createdAt instanceof Date && !Number.isNaN(c.createdAt.getTime()))
    .filter((c) => c.createdAt.getTime() > windowStartMs)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  if (times.length === 0) return { kind: "ok" };

  const last = times[0];
  const elapsed = Math.max(0, nowMs - last.createdAt.getTime());

  if (elapsed < COMMENT_DUPLICATE_MS && typeof last.content === "string" && last.content.trim() === content.trim()) {
    return { kind: "duplicate" };
  }

  let waitMs = 0;
  let maxMs = 0;
  if (elapsed < COMMENT_INTERVAL_MS) {
    waitMs = COMMENT_INTERVAL_MS - elapsed;
    maxMs = COMMENT_INTERVAL_MS;
  }
  if (times.length >= COMMENT_DAILY_LIMIT) {
    // 新しい方から 20 件目が期間の外に出れば、期間内は 19 件になる
    const oldest = times[COMMENT_DAILY_LIMIT - 1].createdAt.getTime();
    const untilFree = oldest + COMMENT_WINDOW_MS - nowMs;
    if (untilFree > waitMs) {
      waitMs = untilFree;
    }
    maxMs = COMMENT_WINDOW_MS;
  }
  if (maxMs === 0) return { kind: "ok" };
  return { kind: "rate_limited", retryAfterSeconds: toRetrySeconds(waitMs, maxMs) };
}
