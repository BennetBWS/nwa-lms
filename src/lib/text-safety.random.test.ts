import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasDbUnsafeChars, isWellFormedText } from "./text-safety";

// #86 テスト担当の追加：text-safety の判定を、シード固定の乱数の文字列で
// 組み込みの String.prototype.isWellFormed と照合する。長い入力でも止まらないこと（線形）も確かめる。
// 時間の値で assert はしない（止まったときに気づけるよう、node:test の timeout だけを付ける）。
// 見えない文字・サロゲートはソースに直接書かず、\u エスケープで書く。

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

/** サロゲートの境界と、よく使う文字を多めに混ぜる */
const UNITS = [
  "a",
  "あ",
  " ",
  "\n",
  "\u0000",
  "\u0001",
  "\uD7FF",
  "\uD800",
  "\uDBFF",
  "\uDC00",
  "\uDFFF",
  "\uE000",
  "\uD83D",
  "\uDE00",
  "😀",
  "\u200D",
  "\u0301",
  "\uFE0F",
  "\uFFFD",
  "\uFFFF",
];

function randomString(next: () => number, maxLen: number): string {
  const len = Math.floor(next() * (maxLen + 1));
  let s = "";
  for (let i = 0; i < len; i++) {
    const r = next();
    if (r < 0.3) s += String.fromCharCode(Math.floor(next() * 0x10000));
    else if (r < 0.4) s += String.fromCharCode(0xd800 + Math.floor(next() * 0x800));
    else s += UNITS[Math.floor(next() * UNITS.length)];
  }
  return s;
}

const native = (s: string): boolean => (s as unknown as { isWellFormed: () => boolean }).isWellFormed();

/** String.prototype.isWellFormed を外した状態で fn を動かす（終わったら必ず戻す） */
function withoutNativeIsWellFormed<T>(fn: () => T): T {
  const proto = String.prototype as { isWellFormed?: () => boolean };
  const original = proto.isWellFormed;
  assert.equal(typeof original, "function", "前提：この Node には isWellFormed がある");
  try {
    delete proto.isWellFormed;
    assert.equal(typeof proto.isWellFormed, "undefined", "isWellFormed を外せていない");
    return fn();
  } finally {
    proto.isWellFormed = original;
    assert.equal(typeof proto.isWellFormed, "function", "isWellFormed を戻せていない");
  }
}

describe("text-safety：乱数の文字列で組み込みの isWellFormed と照合する（シード固定）", () => {
  const SEED = 86;
  const N = 20000;
  const next = rng(SEED);
  const samples = Array.from({ length: N }, () => randomString(next, 24));

  it("前提：乱数の文字列に、正しいものと壊れたものの両方が十分に含まれる", () => {
    const bad = samples.filter((s) => !native(s)).length;
    const nul = samples.filter((s) => s.includes("\u0000")).length;
    assert.ok(bad > N * 0.1, `壊れた文字列が少なすぎる：${bad}`);
    assert.ok(N - bad > N * 0.1, `正しい文字列が少なすぎる：${N - bad}`);
    assert.ok(nul > N * 0.05, `NUL を含む文字列が少なすぎる：${nul}`);
  });

  it("組み込みがある環境：isWellFormedText は isWellFormed と同じ", () => {
    samples.forEach((s, i) => {
      assert.equal(isWellFormedText(s), native(s), `${i} 番目：${JSON.stringify(s)}`);
    });
  });

  it("組み込みがない環境（代わりの正規表現）：isWellFormedText は isWellFormed と同じ", () => {
    const expected = samples.map(native);
    const actual = withoutNativeIsWellFormed(() => samples.map((s) => isWellFormedText(s)));
    samples.forEach((s, i) => {
      assert.equal(actual[i], expected[i], `${i} 番目：${JSON.stringify(s)}`);
    });
  });

  it("hasDbUnsafeChars は「NUL を含む、または isWellFormed が false」と同じ（組み込みあり・なしの両方）", () => {
    const expected = samples.map((s) => s.includes("\u0000") || !native(s));
    samples.forEach((s, i) => {
      assert.equal(hasDbUnsafeChars(s), expected[i], `${i} 番目：${JSON.stringify(s)}`);
    });
    const fallback = withoutNativeIsWellFormed(() => samples.map((s) => hasDbUnsafeChars(s)));
    samples.forEach((s, i) => {
      assert.equal(fallback[i], expected[i], `組み込みなし ${i} 番目：${JSON.stringify(s)}`);
    });
  });

  it("正規表現は状態を持たない（同じ値を続けて判定しても結果が変わらない。g フラグの lastIndex の影響がない）", () => {
    for (const s of ["\uD800", "a\uDC00", "\u0000", "ok"]) {
      const first = hasDbUnsafeChars(s);
      const wellFormed = native(s);
      for (let i = 0; i < 5; i++) assert.equal(hasDbUnsafeChars(s), first, `${JSON.stringify(s)} の ${i} 回目`);
      withoutNativeIsWellFormed(() => {
        for (let i = 0; i < 5; i++) assert.equal(isWellFormedText(s), wellFormed, `組み込みなし ${JSON.stringify(s)} の ${i} 回目`);
      });
    }
  });

  it("1 文字ずつ（すべての UTF-16 の単位）：単独の 1 単位はサロゲートだけが壊れていて、NUL だけが DB に送れない BMP の文字", () => {
    const fallback: boolean[] = withoutNativeIsWellFormed(() => {
      const out: boolean[] = [];
      for (let c = 0; c <= 0xffff; c++) out.push(isWellFormedText(String.fromCharCode(c)));
      return out;
    });
    for (let c = 0; c <= 0xffff; c++) {
      const s = String.fromCharCode(c);
      const isSurrogate = c >= 0xd800 && c <= 0xdfff;
      assert.equal(isWellFormedText(s), !isSurrogate, `U+${c.toString(16)}`);
      assert.equal(fallback[c], !isSurrogate, `組み込みなし U+${c.toString(16)}`);
      assert.equal(hasDbUnsafeChars(s), isSurrogate || c === 0, `hasDbUnsafeChars U+${c.toString(16)}`);
    }
  });
});

describe("text-safety：長い入力でも止まらない（線形。時間の値では assert しない）", () => {
  const N = 1 << 20; // 約 100 万単位
  const cases: Array<[string, () => string, boolean]> = [
    ["上位サロゲートだけが続く", () => "\uD800".repeat(N), true],
    ["下位サロゲートだけが続く", () => "\uDC00".repeat(N), true],
    ["逆順のサロゲートが続く", () => "\uDC00\uD800".repeat(N / 2), true],
    ["正しいペアが続く", () => "😀".repeat(N / 2), false],
    ["正しいペアが続き、最後だけ上位", () => "😀".repeat(N / 2) + "\uD83D", true],
    ["上位が 1 つ多くずれて続く（最初だけ壊れている）", () => "\uD83D" + "😀".repeat(N / 2), true],
    ["普通の文字が続き、最後だけ NUL", () => "a".repeat(N) + "\u0000", true],
    ["普通の文字が続き、最後だけ下位", () => "あ".repeat(N) + "\uDC00", true],
    ["普通の文字だけ", () => "あ".repeat(N), false],
  ];
  for (const [label, make, unsafe] of cases) {
    it(label, { timeout: 60_000 }, () => {
      const s = make();
      assert.equal(hasDbUnsafeChars(s), unsafe, `組み込みあり：${label}`);
      withoutNativeIsWellFormed(() => {
        assert.equal(hasDbUnsafeChars(s), unsafe, `組み込みなし：${label}`);
        // 同じ長さを何度判定しても終わる（指数的な後戻りがない）
        for (let i = 0; i < 3; i++) assert.equal(hasDbUnsafeChars(s), unsafe, `組み込みなし ${i} 回目：${label}`);
      });
    });
  }
});
