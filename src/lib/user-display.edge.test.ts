import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { avatarInitial, displayName, greetingTitle } from "./user-display";

// #32 ユーザー名表示の境界値。名前はすべてダミー。

describe("displayName：空白の種類", () => {
  it("\\s に含まれる空白（NBSP・全角・改行・CRLF・BOM・行区切り）は詰めて 1 つの半角スペースになる", () => {
    assert.equal(displayName("山田 太郎"), "山田 太郎");
    assert.equal(displayName("　山田　　太郎　"), "山田 太郎");
    assert.equal(displayName("Taro\r\nYamada"), "Taro Yamada");
    assert.equal(displayName("﻿山田"), "山田");
    assert.equal(displayName("山  田"), "山 田");
    assert.equal(displayName("\v\f山田\v"), "山田");
  });

  it("空白だけ（全角・NBSP・改行の混在）は null", () => {
    assert.equal(displayName("　 \r\n\t﻿"), null);
    assert.equal(greetingTitle("　 \r\n"), "おかえりなさい");
    assert.equal(avatarInitial("　 \r\n"), null);
  });

  it("結果に改行・タブ・連続スペースが残らない", () => {
    const shown = displayName("  山田\n\n\t太郎　　花子  ");
    assert.equal(shown, "山田 太郎 花子");
    assert.doesNotMatch(shown ?? "", /\s{2,}|[\n\r\t　]/);
  });
});

describe("displayName：文字列以外の入力", () => {
  it("数値・真偽値・bigint・Symbol・配列・オブジェクト・String オブジェクト・関数は null", () => {
    for (const v of [0, 1, NaN, Infinity, true, false, BigInt(10), Symbol("x"), ["山田"], {}, { toString: () => "山田" }, new String("山田"), () => "山田", new Date(0)]) {
      assert.equal(displayName(v), null, String(typeof v));
      assert.equal(avatarInitial(v), null, String(typeof v));
      assert.equal(greetingTitle(v), "おかえりなさい", String(typeof v));
    }
  });
});

describe("displayName / greetingTitle：非常に長い名前", () => {
  it("1 万文字でも切り詰めず、そのまま見出しに入る（省略は CSS 側）", () => {
    const long = "あ".repeat(10_000);
    assert.equal(displayName(long), long);
    assert.equal(greetingTitle(long), `おかえりなさい、${long} さん`);
    assert.equal(avatarInitial(long), "あ");
  });

  it("空白を含む長い名前も正規化だけ行う", () => {
    const long = "Taro  ".repeat(2_000);
    const shown = displayName(long);
    assert.equal(shown, Array(2_000).fill("Taro").join(" "));
  });
});

describe("avatarInitial：文字の種類", () => {
  it("数字・記号で始まる名前はその 1 文字", () => {
    assert.equal(avatarInitial("1太郎"), "1");
    assert.equal(avatarInitial("@taro"), "@");
  });

  it("アクセント付きラテン文字は合成済み・結合文字どちらも 1 書記素で大文字化", () => {
    assert.equal(avatarInitial("émilie"), "É");
    assert.equal(avatarInitial("émilie"), "É");
  });

  it("ひらがな・カタカナ・ハングルはそのまま", () => {
    assert.equal(avatarInitial("やまだ"), "や");
    assert.equal(avatarInitial("ヤマダ"), "ヤ");
    assert.equal(avatarInitial("김민수"), "김");
  });

  it("異体字セレクタ付きの漢字は 1 書記素として扱う", () => {
    const katsuragi = "葛\u{E0100}"; // IVS
    assert.equal(avatarInitial(`${katsuragi}城`), katsuragi);
  });

  it("キーキャップ絵文字・旗（タグ列）も分割しない", () => {
    const keycap = "1️⃣";
    assert.equal(avatarInitial(`${keycap}taro`), keycap);
    const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    assert.equal(avatarInitial(`${england}太郎`), england);
  });

  it("サロゲートペアの半分（孤立サロゲート）でも例外にならない", () => {
    assert.doesNotThrow(() => avatarInitial("\uD800taro"));
    assert.equal(avatarInitial("\uD800taro"), "\uD800");
  });

  it("トルコ語ロケールに依存せず en で大文字化する（i → I）", () => {
    assert.equal(avatarInitial("ichiro"), "I");
  });

  // 大文字化で文字数が変わる文字（ß → SS）は元の文字のままにして、アバターを 1 文字に保つ
  it("ß は SS にせず ß のまま", () => {
    assert.equal(avatarInitial("ßtraße"), "ß");
  });
});

describe("見えない文字（制御文字・書式文字）", () => {
  it("ゼロ幅スペースや ZWJ だけの名前は null（名前なし）", () => {
    assert.equal(displayName("\u200B"), null);
    assert.equal(displayName("\u200B\u200D"), null);
    assert.equal(avatarInitial("\u200B\u200D"), null);
    assert.equal(greetingTitle("\u200B"), "おかえりなさい");
  });

  it("先頭のゼロ幅スペースを飛ばして頭文字を取る", () => {
    assert.equal(avatarInitial("\u200B山田"), "山");
    assert.equal(displayName("\u200B山田\u200B 太郎"), "山田 太郎");
  });

  it("双方向制御文字（U+202E など）とその他の制御文字を取り除く", () => {
    assert.equal(displayName("山田\u202E太郎"), "山田太郎");
    assert.equal(displayName("\u2066山田\u2069"), "山田");
    assert.equal(displayName("山\u0000田"), "山田");
  });

  it("名前の中の ZWJ は残し、絵文字の組み合わせを壊さない", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    assert.equal(displayName(family + " 家"), family + " 家");
    assert.equal(avatarInitial(family + " 家"), family);
  });

  it("前後の ZWJ は取り除く", () => {
    assert.equal(displayName("\u200D山田\u200D"), "山田");
  });
});

describe("Intl.Segmenter がない環境（Array.from による代替）", () => {
  const intl = globalThis.Intl as unknown as Record<string, unknown>;
  let saved: PropertyDescriptor | undefined;

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(intl, "Segmenter");
    Object.defineProperty(intl, "Segmenter", { value: undefined, configurable: true, writable: true });
  });

  afterEach(() => {
    if (saved) Object.defineProperty(intl, "Segmenter", saved);
    else delete intl.Segmenter;
  });

  it("前提：Segmenter が undefined になっている", () => {
    assert.equal(Intl.Segmenter, undefined);
  });

  it("コードポイント単位の先頭を返す（サロゲートペアは分割しない）", () => {
    assert.equal(avatarInitial("山田 太郎"), "山");
    assert.equal(avatarInitial("  taro"), "T");
    assert.equal(avatarInitial("𠮷田"), "𠮷");
    assert.equal(avatarInitial("\u{1F600}taro"), "\u{1F600}");
  });

  it("ZWJ 列・肌色修飾・国旗・結合文字は先頭のコードポイントだけになる", () => {
    assert.equal(avatarInitial("\u{1F468}‍\u{1F469}‍\u{1F467}さん"), "\u{1F468}");
    assert.equal(avatarInitial("\u{1F44D}\u{1F3FD}taro"), "\u{1F44D}");
    assert.equal(avatarInitial("\u{1F1EF}\u{1F1F5}太郎"), "\u{1F1EF}");
    assert.equal(avatarInitial("がくと"), "か");
  });

  it("名前がないときは null のまま", () => {
    assert.equal(avatarInitial(null), null);
    assert.equal(avatarInitial("　"), null);
  });

  it("displayName / greetingTitle は Segmenter に依存しない", () => {
    assert.equal(displayName(" 山田　太郎 "), "山田 太郎");
    assert.equal(greetingTitle("山田"), "おかえりなさい、山田 さん");
  });
});

describe("Intl.Segmenter の後始末", () => {
  it("代替分岐のテスト後に Segmenter が元に戻っている", () => {
    assert.equal(typeof Intl.Segmenter, "function");
    assert.equal(avatarInitial("\u{1F468}‍\u{1F469}‍\u{1F467}"), "\u{1F468}‍\u{1F469}‍\u{1F467}");
  });
});
