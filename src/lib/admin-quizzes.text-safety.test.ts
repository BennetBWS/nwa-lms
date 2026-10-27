import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OPTION_MAX_LENGTH, QUESTION_MAX_LENGTH, optionDuplicateKey, parsePatchQuestionBody } from "./admin-quizzes";
import { commentLength, hasVisibleText } from "./lesson-comments";

// #86 テスト担当の追加：admin-quizzes の NUL・対になっていないサロゲートの判定を text-safety に移したあとも、
// 問題文・選択肢の検証（parsePatchQuestionBody）が main（#81 Q1）と同じ結果になることを、シード固定の乱数の入力で確かめる。
// 基準は、移す前の main の cleanText をそのまま写したもの（下の MAIN_*）。DB・ネットワークなし。
// 見えない文字・サロゲートはソースに直接書かず、\u エスケープで書く。

// ───── main（移す前）の admin-quizzes.ts の判定を写したもの ─────
const MAIN_NUL = /\u0000/;
const MAIN_LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function mainIsWellFormedText(s: string): boolean {
  return typeof s.isWellFormed === "function" ? s.isWellFormed() : !MAIN_LONE_SURROGATE.test(s);
}
function mainCleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t === "" || t.length > max * 2) return null;
  if (MAIN_NUL.test(t) || !mainIsWellFormedText(t)) return null;
  if (commentLength(t) > max || !hasVisibleText(t)) return null;
  return t;
}

/** 再現できるよう、シード固定の簡単な乱数（mulberry32） */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UNITS = [
  "a",
  "b",
  "あ",
  "問",
  " ",
  "\n",
  "\u3000",
  "\u00A0",
  "\u200B",
  "\u200D",
  "\u0301",
  "\uFE0F",
  "😀",
  "\uFFFD",
  "\u0001",
];
const UNSAFE_UNITS = ["\u0000", "\uD800", "\uDBFF", "\uDC00", "\uDFFF", "\uDE00\uD83D"];

function randomText(next: () => number, maxLen: number, unsafeRate: number): string {
  const len = Math.floor(next() * (maxLen + 1));
  let s = "";
  for (let i = 0; i < len; i++) {
    const r = next();
    if (r < unsafeRate) s += UNSAFE_UNITS[Math.floor(next() * UNSAFE_UNITS.length)];
    else if (r < unsafeRate + 0.05) s += String.fromCharCode(Math.floor(next() * 0x10000));
    else s += UNITS[Math.floor(next() * UNITS.length)];
  }
  return s;
}

const REV = "0".repeat(64);
const FIXED_OPTION = "固定の選択肢"; // 固定の選択肢（ほかと重ならない）
const reasonOf = (r: unknown): string => ((r as { reason?: string }).reason ?? "ok");

describe("admin-quizzes：問題文・選択肢の検証が main と同じ（乱数の入力・シード固定）", () => {
  const next = rng(8601);
  const N = 6000;
  /** 長さのばらつき：上限の前後と、2 倍（UTF-16 の長さで先に断る境界）を含める */
  const LENGTHS = [3, 10, 40];

  it("問題文：main の cleanText で null なら invalid_question、そうでなければ同じ値で ok", () => {
    let rejectedByChars = 0;
    let ok = 0;
    for (let i = 0; i < N; i++) {
      const s = randomText(next, LENGTHS[i % LENGTHS.length], i % 2 === 0 ? 0.05 : 0);
      const expected = mainCleanText(s, QUESTION_MAX_LENGTH);
      const actual = parsePatchQuestionBody({ revision: REV, question: s });
      if (expected === null) {
        assert.equal(reasonOf(actual), "invalid_question", `${i} 番目：${JSON.stringify(s)}`);
        const t = s.trim();
        if (t !== "" && (MAIN_NUL.test(t) || !mainIsWellFormedText(t))) rejectedByChars++;
      } else {
        assert.deepEqual(actual, { ok: true, value: { revision: REV, question: expected } }, `${i} 番目：${JSON.stringify(s)}`);
        ok++;
      }
    }
    assert.ok(rejectedByChars > N * 0.1, `NUL・サロゲートで断られた入力が少なすぎる：${rejectedByChars}`);
    assert.ok(ok > N * 0.2, `通った入力が少なすぎる：${ok}`);
  });

  it("問題文の長さの境界（上限ちょうど・超え・UTF-16 で 2 倍超え）に NUL・サロゲートを混ぜても main と同じ", () => {
    const bodies = [
      "あ".repeat(QUESTION_MAX_LENGTH),
      "あ".repeat(QUESTION_MAX_LENGTH + 1),
      "😀".repeat(QUESTION_MAX_LENGTH),
      "😀".repeat(QUESTION_MAX_LENGTH) + "a",
    ];
    for (const base of bodies) {
      for (const extra of ["", ...UNSAFE_UNITS]) {
        for (const s of [base + extra, extra + base, ` ${extra}${base} `]) {
          const expected = mainCleanText(s, QUESTION_MAX_LENGTH);
          const actual = parsePatchQuestionBody({ revision: REV, question: s });
          assert.equal(reasonOf(actual), expected === null ? "invalid_question" : "ok", `長さ ${s.length}・${JSON.stringify(extra)}`);
        }
      }
    }
  });

  it("選択肢：main の cleanText と重複の規則から求めた結果と同じ", () => {
    let rejectedByChars = 0;
    for (let i = 0; i < N; i++) {
      const k = 2 + Math.floor(next() * 4);
      const options = Array.from({ length: k - 1 }, () => randomText(next, 6, i % 2 === 0 ? 0.08 : 0));
      options.push(FIXED_OPTION);
      // main の規則で期待値を作る
      let expected: string[] | null = [];
      const keys = new Set<string>();
      for (const o of options) {
        const t = mainCleanText(o, OPTION_MAX_LENGTH);
        if (t === null) {
          if (o.includes("\u0000") || !mainIsWellFormedText(o)) rejectedByChars++;
          expected = null;
          break;
        }
        const key = optionDuplicateKey(t);
        if (keys.has(key)) {
          expected = null;
          break;
        }
        keys.add(key);
        expected.push(t);
      }
      const actual = parsePatchQuestionBody({ revision: REV, options });
      if (expected === null) assert.equal(reasonOf(actual), "invalid_options", `${i} 番目：${JSON.stringify(options)}`);
      else assert.deepEqual(actual, { ok: true, value: { revision: REV, options: expected } }, `${i} 番目：${JSON.stringify(options)}`);
    }
    assert.ok(rejectedByChars > N * 0.1, `NUL・サロゲートで断られた選択肢が少なすぎる：${rejectedByChars}`);
  });

  it("組み込みの isWellFormed がない環境でも、main の代わりの正規表現と同じ結果", () => {
    const proto = String.prototype as { isWellFormed?: () => boolean };
    const original = proto.isWellFormed;
    const local = rng(8602);
    const samples = Array.from({ length: 3000 }, () => randomText(local, 20, 0.1));
    try {
      delete proto.isWellFormed;
      assert.equal(typeof proto.isWellFormed, "undefined", "isWellFormed を外せていない");
      samples.forEach((s, i) => {
        const expected = mainCleanText(s, QUESTION_MAX_LENGTH);
        const actual = parsePatchQuestionBody({ revision: REV, question: s });
        assert.equal(reasonOf(actual), expected === null ? "invalid_question" : "ok", `${i} 番目：${JSON.stringify(s)}`);
      });
    } finally {
      proto.isWellFormed = original;
    }
    assert.equal(typeof proto.isWellFormed, "function", "isWellFormed を戻せていない");
  });
});
