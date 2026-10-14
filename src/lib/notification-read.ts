/**
 * 通知の未読件数バッジと既読化 API（POST /api/notifications/read、#62）の純粋関数。
 *
 * DB・時計・DOM に触れない純粋関数だけを置く。
 *
 * Tec の決定（#62）：
 * - 通知ページを開いたら、表示した未読（最大 50 件）を ids 指定で既読にする（「すべて既読」は作らない）
 * - バッジは 10 件以上を「9+」と表記する
 */

import { isValidId, type ParseResult } from "./lesson-comments";

/** 1 回の既読化で受け付ける id の最大件数（重複を除いたあと。通知ページの表示件数と同じ） */
export const MARK_READ_MAX_IDS = 50;

/** バッジに数字をそのまま出す上限。これを超えると「9+」 */
export const BADGE_MAX = 9;

/** 既読化の入力 */
export type MarkReadInput = { ids: string[] };

export type MarkReadReason = "invalid_body" | "invalid_ids";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST /api/notifications/read の body を検証する。ids だけを使い、他の項目（userId など）は無視する。
 * - body がオブジェクトでなければ invalid_body
 * - ids が配列でない・要素のどれかが isValidId（空でない string で 64 文字以内）でない・重複を除いて 0 件または 51 件以上なら invalid_ids
 * - 重複は最初に出た順で 1 つにまとめる
 */
export function parseMarkReadBody(body: unknown): ParseResult<MarkReadInput, MarkReadReason> {
  if (!isPlainObject(body)) return { ok: false, reason: "invalid_body" };
  const raw = body.ids;
  if (!Array.isArray(raw)) return { ok: false, reason: "invalid_ids" };
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (!isValidId(id)) return { ok: false, reason: "invalid_ids" };
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    // 上限を超えた時点で止める（残りの要素を見ない。大きな配列でも検査の手間が増えない）
    if (ids.length > MARK_READ_MAX_IDS) return { ok: false, reason: "invalid_ids" };
  }
  if (ids.length === 0) return { ok: false, reason: "invalid_ids" };
  return { ok: true, value: { ids } };
}

/**
 * サイドバーのバッジの表記。
 * - 数値でない・整数でない・有限でない・0 以下なら null（バッジを出さない）
 * - 1〜9 は "1"〜"9"、10 以上は "9+"
 */
export function formatBadgeCount(count: unknown): string | null {
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) return null;
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}
