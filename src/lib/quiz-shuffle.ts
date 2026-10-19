/**
 * 確認テストの選択肢のシャッフル（#51 追加修正、Tec 決定 2026-10-19：方式 a「表示位置＋署名付きトークン」）。
 *
 * サーバー専用（node:crypto を使う）。src/app/page.tsx と src/lib/student-quizzes.ts からは import しない
 * （クライアントの bundle に node:crypto を入れない。テストで固定している）。
 *
 * - 鍵：AUTH_SECRET から HKDF-SHA256 で用途ごとに 2 本作る（k_shuffle・k_token）。新しい環境変数は使わない。
 *   Auth.js の JWE の鍵とは info が違うので独立した鍵になる
 * - 並べ替え：問題ごとに HMAC(k_shuffle, ["v1", userId, quizId, questionId, nonce, n]) を種にし、
 *   HMAC(k_shuffle, 種 || uint32be(counter)) の乱数列で Fisher–Yates を回す（剰余の偏りは棄却法で除く）。
 *   perm[k] は「表示位置 k に出す元の位置」
 * - トークン：`v1.<nonce>.<mac>`、mac = HMAC(k_token, ["v1", userId, quizId, nonce, contentDigest])。
 *   contentDigest（問題の id と選択肢の鍵付きダイジェスト）はトークンに入れない（入れると並べ替えを総当たりで特定できる）。
 *   選択肢が変わると mac が合わなくなる（409 quiz_changed）。有効期限は付けない（Tec 決定 Q3 a）
 * - 講師も同じようにシャッフルする（Tec 決定 Q2 a）
 * - トークン・nonce・並べ替え・回答はログに出さない（この関数群は何も出力しない）
 */

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { isAttemptTokenFormat, type QuestionView } from "./student-quizzes";

export type QuizKeys = { shuffleKey: Buffer; tokenKey: Buffer };

const HKDF_SALT = "nwa-lms";
export const SHUFFLE_KEY_INFO = "nwa-lms quiz option shuffle v1";
export const TOKEN_KEY_INFO = "nwa-lms quiz attempt token v1";
const KEY_BYTES = 32;
const NONCE_BYTES = 16;
const TOKEN_VERSION = "v1";

/** AUTH_SECRET から用途ごとの鍵を 2 本作る。secret が空なら例外（値は例外に含めない） */
export function deriveQuizKeys(secret: string): QuizKeys {
  if (typeof secret !== "string" || secret === "") throw new Error("quiz keys: empty secret");
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, info, KEY_BYTES));
  return { shuffleKey: derive(SHUFFLE_KEY_INFO), tokenKey: derive(TOKEN_KEY_INFO) };
}

function hmac(key: Buffer, data: string | Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** 種から uint32 を順に取り出す（HMAC(key, 種 || uint32be(counter)) のブロック、1 ブロック 8 個） */
function uint32Stream(key: Buffer, seed: Buffer): () => number {
  let counter = 0;
  let block: Buffer = Buffer.alloc(0);
  let offset = 0;
  return () => {
    if (offset >= block.length) {
      const c = Buffer.alloc(4);
      c.writeUInt32BE(counter, 0);
      counter += 1;
      block = hmac(key, Buffer.concat([seed, c]));
      offset = 0;
    }
    const v = block.readUInt32BE(offset);
    offset += 4;
    return v;
  };
}

const TWO_POW_32 = 2 ** 32;

export type PermutationInput = { userId: string; quizId: string; questionId: string; nonce: string; n: number };

/**
 * 問題ごとの決定的な並べ替え（0..n-1 の順列）。perm[k] は表示位置 k に出す元の位置。
 * 同じ入力なら同じ結果。Fisher–Yates を i = n-1 … 1 で回し、uint32 の剰余の偏りは棄却法で除く
 */
export function optionPermutation(shuffleKey: Buffer, { userId, quizId, questionId, nonce, n }: PermutationInput): number[] {
  if (!Number.isInteger(n) || n < 1) throw new Error("quiz shuffle: invalid option count");
  const seed = hmac(shuffleKey, JSON.stringify([TOKEN_VERSION, userId, quizId, questionId, nonce, n]));
  const next = uint32Stream(shuffleKey, seed);
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i >= 1; i--) {
    const range = i + 1;
    const limit = TWO_POW_32 - (TWO_POW_32 % range);
    let x = next();
    while (x >= limit) x = next();
    const j = x % range;
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  return perm;
}

/** 新しい nonce（16 バイトの base64url、22 字） */
export function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64url");
}

/** トークンの MAC が覆う問題の内容（id と選択肢の文・並び） */
export type DigestQuestion = { id: string; options: ReadonlyArray<string> };

function contentDigest(tokenKey: Buffer, questions: ReadonlyArray<DigestQuestion>): string {
  return hmac(tokenKey, JSON.stringify(questions.map((q) => [q.id, [...q.options]]))).toString("base64url");
}

function tokenMac(tokenKey: Buffer, userId: string, quizId: string, nonce: string, questions: ReadonlyArray<DigestQuestion>): string {
  const digest = contentDigest(tokenKey, questions);
  return hmac(tokenKey, JSON.stringify([TOKEN_VERSION, userId, quizId, nonce, digest])).toString("base64url");
}

export type TokenContext = { userId: string; quizId: string; questions: ReadonlyArray<DigestQuestion> };

/** トークンを発行する（`v1.<nonce>.<mac>`）。nonce は省略時に新しく作る（テストだけが決まった値を渡す） */
export function issueAttemptToken(keys: QuizKeys, { userId, quizId, questions }: TokenContext, nonce: string = newNonce()): string {
  return `${TOKEN_VERSION}.${nonce}.${tokenMac(keys.tokenKey, userId, quizId, nonce, questions)}`;
}

/**
 * トークンを検証し、正しければ nonce を返す。形が違う・MAC が合わない（別のユーザー・クイズ、選択肢の変更、改ざん）なら null。
 * 比較は長さを確かめてから timingSafeEqual で行う
 */
export function verifyAttemptToken(keys: QuizKeys, token: unknown, { userId, quizId, questions }: TokenContext): string | null {
  if (!isAttemptTokenFormat(token)) return null;
  const [, nonce, mac] = token.split(".");
  const expected = Buffer.from(tokenMac(keys.tokenKey, userId, quizId, nonce, questions), "utf8");
  const sent = Buffer.from(mac, "utf8");
  if (sent.length !== expected.length) return null;
  return timingSafeEqual(sent, expected) ? nonce : null;
}

export type ShuffleContext = { userId: string; quizId: string; nonce: string };

/** GET の応答用に、問題ごとに選択肢を並べ替える（新しい配列。問題の順は変えない） */
export function shuffleQuestionViews(
  shuffleKey: Buffer,
  { userId, quizId, nonce }: ShuffleContext,
  views: ReadonlyArray<QuestionView>
): QuestionView[] {
  return views.map((v) => {
    const perm = optionPermutation(shuffleKey, { userId, quizId, questionId: v.id, nonce, n: v.options.length });
    return { id: v.id, question: v.question, options: perm.map((o) => v.options[o]) };
  });
}

/**
 * 送られた表示位置を元の位置に戻す（original[i] = perm_i[displayed[i]]）。
 * displayed は parseSubmitAnswers で範囲を確かめ済みで、長さが questions と同じであること
 */
export function toOriginalAnswers(
  shuffleKey: Buffer,
  { userId, quizId, nonce }: ShuffleContext,
  questions: ReadonlyArray<{ id: string; optionCount: number }>,
  displayed: ReadonlyArray<number>
): number[] {
  if (displayed.length !== questions.length) throw new Error("quiz shuffle: answer count mismatch");
  return questions.map((q, i) => {
    const perm = optionPermutation(shuffleKey, { userId, quizId, questionId: q.id, nonce, n: q.optionCount });
    const d = displayed[i];
    if (!Number.isInteger(d) || d < 0 || d >= perm.length) throw new Error("quiz shuffle: answer out of range");
    return perm[d];
  });
}
