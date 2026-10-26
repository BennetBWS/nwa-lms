import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasDbUnsafeChars, isWellFormedText } from "./text-safety";

// #86 Postgres に送れない文字の判定。見えない文字は \u エスケープで書く

const UNSAFE: Array<[string, string]> = [
  ["NUL だけ", "\u0000"],
  ["NUL を含む", "質問\u0000です"],
  ["上位サロゲートだけ（末尾）", "質問\uD800"],
  ["上位サロゲートだけ（途中）", "質問\uD800です"],
  ["下位サロゲートだけ（先頭）", "\uDC00質問"],
  ["下位サロゲートだけ（途中）", "質問\uDC00です"],
  ["逆順のサロゲート", "質問\uDE00\uD83Dです"],
  ["上位が 2 つ続く", "\uD83D😀"],
];

const SAFE: Array<[string, string]> = [
  ["空", ""],
  ["日本語", "質問です"],
  ["絵文字（サロゲートペア）", "質問😀です"],
  ["家族の絵文字（ZWJ）", "\u{1F468}‍\u{1F469}‍\u{1F467}"],
  ["その他の制御文字（U+0001・DEL）", "a\u0001b\u007Fc"],
  ["BMP の最後", "￿"],
  ["置換文字", "�"],
];

describe("hasDbUnsafeChars", () => {
  for (const [label, s] of UNSAFE) {
    it(`${label} は true`, () => {
      assert.equal(hasDbUnsafeChars(s), true, label);
    });
  }
  for (const [label, s] of SAFE) {
    it(`${label} は false`, () => {
      assert.equal(hasDbUnsafeChars(s), false, label);
    });
  }
});

describe("isWellFormedText：isWellFormed がない環境の代わりの正規表現も同じ結果", () => {
  it("String.prototype.isWellFormed を外しても結果が変わらない", () => {
    const proto = String.prototype as { isWellFormed?: () => boolean };
    const original = proto.isWellFormed;
    const cases = [...UNSAFE, ...SAFE].filter(([, s]) => !s.includes("\u0000"));
    const native = cases.map(([, s]) => isWellFormedText(s));
    try {
      delete proto.isWellFormed;
      assert.equal(typeof proto.isWellFormed, "undefined", "isWellFormed を外せていない");
      cases.forEach(([label, s], i) => {
        assert.equal(isWellFormedText(s), native[i], `正規表現の結果が違う：${label}`);
      });
    } finally {
      if (original !== undefined) proto.isWellFormed = original;
    }
    assert.ok(typeof original !== "function" || typeof proto.isWellFormed === "function", "isWellFormed を戻せていない");
  });
});
