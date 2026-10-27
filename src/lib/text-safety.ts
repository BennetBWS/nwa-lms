/**
 * Postgres に送れない文字の判定（#86。#81 Q1 の admin-quizzes.ts から移した）。
 *
 * DB・時計・DOM・node:crypto に触れない純粋関数だけを置く（画面からも import できる）。
 *
 * - NUL（U+0000）：Postgres の text・jsonb は受け付けない（22021。route の catch で 500 になる）
 * - 対になっていないサロゲート：Prisma が InvalidArg で断る。jsonb は拒否し、text は U+FFFD に置き換える
 *
 * 対になったサロゲート（絵文字など）は問題ない。
 */

/** NUL（U+0000） */
const NUL = /\u0000/;

/** 対になっていないサロゲート（String.prototype.isWellFormed がない環境での代わり） */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 対になっていないサロゲートを含まない */
export function isWellFormedText(s: string): boolean {
  return typeof s.isWellFormed === "function" ? s.isWellFormed() : !LONE_SURROGATE.test(s);
}

/** NUL または対になっていないサロゲートを含む（DB に送らずに 400 で断るべき値） */
export function hasDbUnsafeChars(s: string): boolean {
  return NUL.test(s) || !isWellFormedText(s);
}
