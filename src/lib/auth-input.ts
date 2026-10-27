/**
 * 未ログインで呼べる認証まわりの入力の形の確認（#87）。
 *
 * ログイン（Credentials の authorize）・POST /api/auth/forgot-password の email と、
 * POST /api/auth/reset-password・GET /api/auth/verify-reset-token の token を、
 * DB を読む前に確かめる。NUL と対になっていないサロゲートは Postgres / Prisma が
 * エラーにして 500 になるため、`hasDbUnsafeChars`（#86）で断る。
 *
 * DB・時計・DOM・node:crypto に触れない純粋関数だけを置く。値を正規化しない
 * （前後の空白を除くのは空かどうかの判定だけで、DB にはそのまま渡す。今までの照合を変えないため）。
 */
import { hasDbUnsafeChars } from "./text-safety";

/** メールアドレスの上限（RFC 5321 の経路の上限に合わせる） */
export const MAX_EMAIL_LENGTH = 254;

/**
 * リセットトークンの上限。今のトークンは crypto.randomUUID() の 36 文字だが、
 * 形式を変えても困らないようにゆるく決める（DB に長すぎる値を渡さないための上限）。
 */
export const MAX_RESET_TOKEN_LENGTH = 128;

/** DB に渡してよい email か（string・空白だけでない・254 文字以下・使えない文字を含まない） */
export function isValidEmailInput(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_EMAIL_LENGTH &&
    !hasDbUnsafeChars(value)
  );
}

/** DB に渡してよいリセットトークンか（string・1〜128 文字・使えない文字を含まない） */
export function isValidResetTokenInput(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_RESET_TOKEN_LENGTH &&
    !hasDbUnsafeChars(value)
  );
}
