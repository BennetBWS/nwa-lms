import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMENT_MAX_LENGTH, parseCommentContent, parseCreateComment } from "./lesson-comments";
import { parseReplyBody } from "./question-reply";

// #86 質問・回答の本文に NUL・対になっていないサロゲートがあると、DB に送って 500 になっていた。
// parseCommentContent で 400 invalid_characters にする。DB・ネットワークなし。見えない文字は \u エスケープで書く

const reasonOf = (r: { ok: boolean }): string | null => ("reason" in r ? (r as { reason: string }).reason : null);

const UNSAFE: Array<[string, string]> = [
  ["NUL を含む", "質問\u0000です"],
  ["NUL だけ", "\u0000"],
  ["上位サロゲートだけ", "質問\uD800です"],
  ["上位サロゲートだけ（末尾）", "質問\uD83D"],
  ["下位サロゲートだけ", "質問\uDC00です"],
  ["下位サロゲートだけ（先頭）", "\uDE00質問"],
  ["逆順のサロゲート", "質問\uDE00\uD83Dです"],
];

describe("parseCommentContent：NUL・対になっていないサロゲートは invalid_characters", () => {
  for (const [label, s] of UNSAFE) {
    it(label, () => {
      assert.deepEqual(parseCommentContent(s), { ok: false, reason: "invalid_characters" }, label);
      assert.deepEqual(parseCreateComment({ lessonId: "l1", content: s }), { ok: false, reason: "invalid_characters" }, `parseCreateComment: ${label}`);
      assert.deepEqual(parseReplyBody({ content: s }), { ok: false, reason: "invalid_characters" }, `parseReplyBody: ${label}`);
    });
  }

  it("正しい絵文字（サロゲートペア・ZWJ・異体字セレクタ）は通り、本文を変えない", () => {
    for (const s of ["質問😀です", "\u{1F600}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "❤\uFE0F", "\u{1F1EF}\u{1F1F5}"]) {
      assert.deepEqual(parseCommentContent(s), { ok: true, value: s }, JSON.stringify(s));
    }
  });

  it("NUL 以外の制御文字（U+0001・DEL）は従来どおり断らない", () => {
    assert.deepEqual(parseCommentContent("a\u0001b\u007Fc"), { ok: true, value: "a\u0001b\u007Fc" });
  });
});

describe("parseCommentContent：理由の優先順位", () => {
  it("string でなければ invalid_content（文字の判定より先）", () => {
    for (const v of [undefined, null, 0, ["\u0000"], { a: "\u0000" }]) {
      assert.equal(reasonOf(parseCommentContent(v)), "invalid_content", JSON.stringify(v));
    }
  });

  it("空白・見えない文字だけでも、NUL・対になっていないサロゲートがあれば empty より先に invalid_characters", () => {
    for (const s of ["\u0000", "  \u0000  ", "\u200B\u0000", "\uD800", " \uDC00 ", "\n\uD83D\n"]) {
      assert.equal(reasonOf(parseCommentContent(s)), "invalid_characters", JSON.stringify(s));
    }
  });

  it("上限を超える長さでも too_long より先に invalid_characters", () => {
    const long = "あ".repeat(COMMENT_MAX_LENGTH + 1);
    assert.equal(reasonOf(parseCommentContent(long)), "too_long", "前提：上限超えは too_long");
    for (const s of [`${long}\u0000`, `\uD800${long}`, `${long}\uDC00`]) {
      assert.equal(reasonOf(parseCommentContent(s)), "invalid_characters", `長さ ${s.length}`);
    }
  });

  it("前後の空白の外側にあっても断る（trim では消えない）", () => {
    assert.equal(reasonOf(parseCommentContent("\u0000 質問 ")), "invalid_characters");
    assert.equal(reasonOf(parseCommentContent(" 質問 \uD800")), "invalid_characters");
  });

  it("parseCreateComment：lessonId の不正が先、parentId の不正より invalid_characters が先", () => {
    assert.equal(reasonOf(parseCreateComment({ lessonId: "", content: "\u0000" })), "invalid_lesson_id");
    assert.equal(reasonOf(parseCreateComment({ lessonId: "l1", content: "\u0000", parentId: 1 })), "invalid_characters");
    assert.equal(reasonOf(parseCreateComment({ lessonId: "l1", content: "ok", parentId: 1 })), "invalid_parent_id");
  });

  it("parseReplyBody：body が object でなければ invalid_body が先", () => {
    assert.equal(reasonOf(parseReplyBody("\u0000")), "invalid_body");
    assert.equal(reasonOf(parseReplyBody(["\u0000"])), "invalid_body");
  });
});

describe("JSON の body の中のエスケープ（\\u0000・\\ud800 など）も、解析後の文字として断る", () => {
  // request.json() と同じく JSON.parse した値を渡す。ソースの文字列は JSON のエスケープの形（バックスラッシュ u）
  const cases: Array<[string, string, string | null]> = [
    ["\\u0000", '{"lessonId":"l1","content":"質問\\u0000です"}', "invalid_characters"],
    ["\\ud800", '{"lessonId":"l1","content":"質問\\ud800です"}', "invalid_characters"],
    ["\\udc00", '{"lessonId":"l1","content":"質問\\udc00です"}', "invalid_characters"],
    ["\\ude00\\ud83d（逆順）", '{"lessonId":"l1","content":"質問\\ude00\\ud83dです"}', "invalid_characters"],
    ["\\ud83d\\ude00（正しいペア）", '{"lessonId":"l1","content":"質問\\ud83d\\ude00です"}', null],
  ];
  for (const [label, json, expected] of cases) {
    it(label, () => {
      assert.ok(!json.includes("\u0000") && !/[\uD800-\uDFFF]/.test(json), `ソースの JSON に生の文字が入っている：${label}`);
      const body: unknown = JSON.parse(json);
      assert.equal(reasonOf(parseCreateComment(body)), expected, `parseCreateComment: ${label}`);
      assert.equal(reasonOf(parseReplyBody(body)), expected, `parseReplyBody: ${label}`);
    });
  }

  it("JSON.stringify は対になっていないサロゲートを \\u エスケープで書き、往復しても断る", () => {
    const json = JSON.stringify({ lessonId: "l1", content: "質問\uD800" });
    assert.ok(json.includes("\\ud800"), "対になっていないサロゲートがエスケープされていない");
    assert.equal(reasonOf(parseCreateComment(JSON.parse(json))), "invalid_characters");
  });
});
