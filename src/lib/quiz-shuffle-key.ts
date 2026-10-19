/**
 * 選択肢のシャッフル・受験のトークンの鍵（#51 追加修正）。サーバー専用。
 *
 * process.env.AUTH_SECRET（Auth.js と同じ既存のシークレット）から HKDF で用途別の鍵を作る（Tec 承認 2026-10-19）。
 * 未設定・空なら QuizKeyUnavailableError を投げる（route は 500。受け付けない側に倒す）。
 * 値は例外のメッセージにもログにも含めない
 */

import { deriveQuizKeys, type QuizKeys } from "./quiz-shuffle";

export class QuizKeyUnavailableError extends Error {
  constructor() {
    super("quiz keys are unavailable");
    this.name = "QuizKeyUnavailableError";
  }
}

/** いまの AUTH_SECRET から鍵を作る（毎回導出する。値を保持しない） */
export function quizKeys(env: Readonly<Record<string, string | undefined>> = process.env): QuizKeys {
  const secret = env.AUTH_SECRET;
  if (typeof secret !== "string" || secret === "") throw new QuizKeyUnavailableError();
  return deriveQuizKeys(secret);
}
