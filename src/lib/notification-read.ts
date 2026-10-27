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
 * - ids が配列でない・要素のどれかが isValidId（空でない string で 64 文字以内、NUL・対になっていないサロゲートを含まない。#86）でない・重複を除いて 0 件または 51 件以上なら invalid_ids
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

// ── 画面（src/app/page.tsx）で使う純粋関数（#62 PR-2） ──

/** 未読件数として使える値（0 以上の安全な整数）なら返し、そうでなければ null */
export function toUnreadCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** GET /api/notifications/unread-count の応答 `{ count }` から件数を読む。形が違えば null（前の値を使い続ける） */
export function readUnreadCountResponse(body: unknown): number | null {
  if (!isPlainObject(body)) return null;
  return toUnreadCount(body.count);
}

/** POST /api/notifications/read の応答 `{ updated, unreadCount }` から更新後の未読件数を読む。形が違えば null */
export function readMarkReadResponse(body: unknown): number | null {
  if (!isPlainObject(body)) return null;
  return toUnreadCount(body.unreadCount);
}

/**
 * 通知ページで表示した行（toNewsItems の結果）から、既読にする id を集める。
 * - unread が true の行だけ。空文字・文字列でない id は除く
 * - 重複は最初に出た順で 1 つにまとめ、最大 MARK_READ_MAX_IDS 件（API の上限と同じ）
 */
export function unreadIdsToMark(items: ReadonlyArray<{ id: unknown; unread: unknown }> | null | undefined): string[] {
  if (!Array.isArray(items)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (ids.length >= MARK_READ_MAX_IDS) break;
    if (!isPlainObject(item) || item.unread !== true) continue;
    const id = item.id;
    if (!isValidId(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** バッジの読み上げ用ラベル。バッジを出さないとき（formatBadgeCount が null）は null。表記が「9+」でも実際の件数を読む */
export function unreadBadgeLabel(count: unknown): string | null {
  if (formatBadgeCount(count) === null) return null;
  return `未読 ${count} 件`;
}
