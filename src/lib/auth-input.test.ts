import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_EMAIL_LENGTH,
  MAX_RESET_TOKEN_LENGTH,
  isValidEmailInput,
  isValidResetTokenInput,
} from "./auth-input";

// #87 未ログインで呼べる認証まわりの入力（email・リセットトークン）の形の確認。
// 見えない文字は \u エスケープで書く。アドレスはすべて example.com のダミー。

const NOT_STRINGS: Array<[string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["数値", 1],
  ["0", 0],
  ["true", true],
  ["配列", ["a@example.com"]],
  ["オブジェクト", { equals: "a@example.com" }],
  ["空のオブジェクト", {}],
];

/** 長さ n の email（"@example.com" の前を a で埋める） */
function emailOfLength(n: number): string {
  const domain = "@example.com";
  return "a".repeat(n - domain.length) + domain;
}

describe("isValidEmailInput", () => {
  it("上限は 254", () => {
    assert.equal(MAX_EMAIL_LENGTH, 254, "上限が変わった");
  });

  for (const [label, v] of NOT_STRINGS) {
    it(`string でない（${label}）は false`, () => {
      assert.equal(isValidEmailInput(v), false, label);
    });
  }

  const BAD: Array<[string, string]> = [
    ["空", ""],
    ["空白だけ", "   "],
    ["タブ・改行だけ", "\t\n"],
    ["全角空白だけ", "\u3000"],
    ["NUL", "a\u0000@example.com"],
    ["NUL だけ", "\u0000"],
    ["上位サロゲートだけ", "a\uD800@example.com"],
    ["下位サロゲートだけ", "\uDC00a@example.com"],
    ["逆順のサロゲート", "a\uDE00\uD83D@example.com"],
    ["255 文字", emailOfLength(255)],
    ["とても長い", emailOfLength(10_000)],
  ];
  for (const [label, v] of BAD) {
    it(`${label} は false`, () => {
      assert.equal(isValidEmailInput(v), false, label);
    });
  }

  const GOOD: Array<[string, string]> = [
    ["通常", "student@example.com"],
    ["1 文字", "a"],
    ["254 文字", emailOfLength(254)],
    ["前後に空白（正規化はしない）", " student@example.com "],
    ["絵文字（サロゲートペア）", "a\u{1F600}@example.com"],
    ["置換文字", "a\uFFFD@example.com"],
  ];
  for (const [label, v] of GOOD) {
    it(`${label} は true`, () => {
      assert.equal(isValidEmailInput(v), true, label);
    });
  }

  it("254 文字と 255 文字の境界", () => {
    assert.equal(emailOfLength(254).length, 254, "テストの値の長さが違う");
    assert.equal(isValidEmailInput(emailOfLength(254)), true, "254 文字は通す");
    assert.equal(isValidEmailInput(emailOfLength(255)), false, "255 文字は断る");
  });
});

describe("isValidResetTokenInput", () => {
  it("上限は 128（今のトークンは 36 文字の UUID）", () => {
    assert.equal(MAX_RESET_TOKEN_LENGTH, 128, "上限が変わった");
    assert.ok(MAX_RESET_TOKEN_LENGTH >= crypto.randomUUID().length, "今のトークンが上限を超える");
  });

  for (const [label, v] of NOT_STRINGS) {
    it(`string でない（${label}）は false`, () => {
      assert.equal(isValidResetTokenInput(v), false, label);
    });
  }

  const BAD: Array<[string, string]> = [
    ["空", ""],
    ["NUL", "x\u0000"],
    ["NUL だけ", "\u0000"],
    ["UUID の途中に NUL", "0f0e0d0c-0b0a-4908-8706-05040302\u00000100"],
    ["上位サロゲートだけ", "x\uD800"],
    ["下位サロゲートだけ", "\uDC00x"],
    ["逆順のサロゲート", "x\uDE00\uD83D"],
    ["129 文字", "a".repeat(129)],
    ["とても長い", "a".repeat(100_000)],
  ];
  for (const [label, v] of BAD) {
    it(`${label} は false`, () => {
      assert.equal(isValidResetTokenInput(v), false, label);
    });
  }

  const GOOD: Array<[string, string]> = [
    ["UUID", "0f0e0d0c-0b0a-4908-8706-050403020100"],
    ["新しく作った UUID", crypto.randomUUID()],
    ["1 文字", "a"],
    ["128 文字", "a".repeat(128)],
    ["形式の違う値（DB で見つからないだけ）", "tok-unknown"],
  ];
  for (const [label, v] of GOOD) {
    it(`${label} は true`, () => {
      assert.equal(isValidResetTokenInput(v), true, label);
    });
  }
});
