/**
 * レッスンの質問タブ（#32）と /api/comments の入力検証・応答の変換。
 *
 * route（src/app/api/comments/**）と src/app/page.tsx の LessonView の両方から使う。
 * DB・時計・DOM に触れない純粋関数だけを置く。現在時刻は必ず引数 `now` で受け取る。
 *
 * Tec の決定（#32、2026-10-06）：
 * - 質問タブは表示だけ。投稿欄の公開は #46
 * - 名前：受講生は登録名、講師は名前に「講師」バッジ、無効化された受講生は名前を出さず「受講生」
 * - メールアドレス・avatar・userId は返さない
 * - 返信は親の下に表示するだけ。API で返信への返信を禁止
 */

import { avatarInitial, displayName } from "./user-display";
import { relativeTimeJa } from "./student-dashboard";

/** 本文の最大文字数（コードポイント単位） */
export const COMMENT_MAX_LENGTH = 2000;

/** GET で返す親の質問の最大件数（新しい方から。ページングなし） */
export const COMMENTS_LIMIT = 100;

/** lessonId / parentId の最大文字数（cuid は 25 文字前後） */
export const ID_MAX_LENGTH = 64;

/** 文字数。サロゲートペア（絵文字など）は 1 文字、結合文字は別の 1 文字として数える */
export function commentLength(s: string): number {
  return Array.from(s).length;
}

/** 空でない string で ID_MAX_LENGTH 文字以内 */
export function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= ID_MAX_LENGTH;
}

/** 見える文字（文字・数字・記号・句読点）が 1 文字以上ある。判定は user-display の displayName と同じ */
export function hasVisibleText(value: unknown): boolean {
  return displayName(value) !== null;
}

// ───────────── POST /api/comments の入力 ─────────────

export type CreateCommentInput = { lessonId: string; content: string; parentId: string | null };

export type CreateCommentReason =
  | "invalid_body"
  | "invalid_lesson_id"
  | "invalid_content"
  | "empty"
  | "too_long"
  | "invalid_parent_id";

export type ParseResult<T, R> = { ok: true; value: T } | { ok: false; reason: R };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST /api/comments の body を検証する。
 * - content：string。前後の空白を除き、空・見える文字がない → empty、2000 文字超 → too_long。中の改行は残す
 * - lessonId：空でない string で 64 文字以内
 * - parentId：undefined / null（親の質問）か、空でない string で 64 文字以内
 * userId は受け取らない（route がセッションの値を使う）
 */
export function parseCreateComment(body: unknown): ParseResult<CreateCommentInput, CreateCommentReason> {
  if (!isPlainObject(body)) return { ok: false, reason: "invalid_body" };

  const { lessonId, content, parentId } = body;
  if (!isValidId(lessonId)) return { ok: false, reason: "invalid_lesson_id" };

  if (typeof content !== "string") return { ok: false, reason: "invalid_content" };
  const trimmed = content.trim();
  if (trimmed === "" || !hasVisibleText(trimmed)) return { ok: false, reason: "empty" };
  if (commentLength(trimmed) > COMMENT_MAX_LENGTH) return { ok: false, reason: "too_long" };

  let parent: string | null;
  if (parentId === undefined || parentId === null) parent = null;
  else if (isValidId(parentId)) parent = parentId;
  else return { ok: false, reason: "invalid_parent_id" };

  return { ok: true, value: { lessonId, content: trimmed, parentId: parent } };
}

// ───────────── API の応答 ─────────────

/** route が prisma の select で読む 1 件（user は name・role・deactivatedAt だけ） */
export type CommentRow = {
  id: string;
  content: string;
  createdAt: Date;
  userId: string;
  user: { name: string; role: string; deactivatedAt: Date | null };
};

export type CommentThreadRow = CommentRow & { replies?: ReadonlyArray<CommentRow> };

export type CommentAuthorView = { name: string | null; isInstructor: boolean };

export type CommentView = {
  id: string;
  content: string;
  createdAt: string;
  author: CommentAuthorView;
  mine: boolean;
};

export type CommentThreadView = CommentView & { replies: CommentView[] };

/**
 * 投稿者の表示。講師は名前をそのまま（講師は無効化の対象外）。
 * 無効化された受講生は name: null（画面で「受講生」と表示。再有効化されれば名前に戻る）
 */
export function commentAuthorView(user: CommentRow["user"]): CommentAuthorView {
  const isInstructor = user.role === "INSTRUCTOR";
  if (!isInstructor && user.deactivatedAt) return { name: null, isInstructor };
  return { name: user.name, isInstructor };
}

function toCommentView(row: CommentRow, viewerId: string): CommentView {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    author: commentAuthorView(row.user),
    mine: row.userId === viewerId,
  };
}

/**
 * API の応答 1 件。userId・メールアドレス・avatar・role・deactivatedAt は含めない。
 * replies は渡された順（route が古い順に並べる）。返信の返信は含めない
 */
export function toCommentThreadView(row: CommentThreadRow, viewerId: string): CommentThreadView {
  return {
    ...toCommentView(row, viewerId),
    replies: (row.replies ?? []).map((r) => toCommentView(r, viewerId)),
  };
}

// ───────────── 画面の表示 ─────────────

export type CommentItem = {
  id: string;
  /** 表示する名前。名前がなければ受講生は「受講生」、講師は「講師」 */
  name: string;
  /** アバターの頭文字。null なら画面は User アイコン */
  initial: string | null;
  isInstructor: boolean;
  time: string;
  content: string;
  mine: boolean;
};

export type CommentThreadItem = CommentItem & { replies: CommentItem[] };

type DateInput = Date | string | number | null | undefined;

function toDateInput(value: unknown): DateInput {
  return typeof value === "string" || typeof value === "number" || value instanceof Date ? value : null;
}

function toItem(row: Record<string, unknown>, now: Date): CommentItem {
  const author = isPlainObject(row.author) ? row.author : {};
  const isInstructor = author.isInstructor === true;
  const shown = displayName(author.name);
  return {
    id: row.id as string,
    name: shown ?? (isInstructor ? "講師" : "受講生"),
    initial: shown === null ? null : avatarInitial(shown),
    isInstructor,
    time: relativeTimeJa(toDateInput(row.createdAt), now),
    content: row.content as string,
    mine: row.mine === true,
  };
}

/** id（空でない string、まだ出ていない）と content（string）がある要素だけを残す */
function validRows(rows: unknown, seen: Set<string>): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (!isPlainObject(r)) continue;
    if (typeof r.id !== "string" || r.id === "" || seen.has(r.id)) continue;
    if (typeof r.content !== "string") continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * GET /api/comments/[lessonId] の応答を画面の行にする。
 * 壊れた要素（非オブジェクト、id か content が文字列でない）を飛ばし、
 * 空の id と、親・返信を通して重複した id を除く（最初の 1 件を残す。id は React の key）。
 * 順序は API のまま
 */
export function toCommentItems(rows: unknown, now: Date): CommentThreadItem[] {
  const seen = new Set<string>();
  return validRows(rows, seen).map((r) => ({
    ...toItem(r, now),
    replies: validRows(r.replies, seen).map((x) => toItem(x, now)),
  }));
}

/** 質問タブの名前。件数（親の質問の数）が分からない間（読み込み中・失敗）は「質問」 */
export function commentsTabLabel(count: number | null): string {
  if (count === null || !Number.isInteger(count) || count < 0) return "質問";
  return `質問 (${count})`;
}

// ───────────── 概要タブ ─────────────

const LESSON_TYPE_LABELS: Readonly<Record<string, string>> = {
  TEXT: "テキスト",
  VIDEO: "動画",
  PDF: "PDF",
  QUIZ: "クイズ",
};

/** レッスンの種類のバッジの文言。未知の値・値なしは null（バッジを出さない） */
export function lessonTypeLabel(type: unknown): string | null {
  if (typeof type !== "string") return null;
  return Object.prototype.hasOwnProperty.call(LESSON_TYPE_LABELS, type) ? LESSON_TYPE_LABELS[type] : null;
}

/**
 * 教材リンクの href。http: / https: の絶対 URL のときだけ、正規化した URL を返す。
 * javascript: や data:、相対パス、前後に空白のある文字列などは null（リンクにしない）
 */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value !== value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}
