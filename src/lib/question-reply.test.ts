import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMENT_MAX_LENGTH, commentLength, hasVisibleText, parseCreateComment, parseCommentContent } from "./lesson-comments";
import {
  REPLY_NOTIFICATION_TITLE,
  isValidQuestionId,
  parseReplyBody,
  replyNotificationMessage,
  shouldNotifyQuestionAuthor,
} from "./question-reply";

// #32 A-1 講師の回答 API の純粋関数。DB・ネットワーク・DOM なし。データはすべてダミー。

describe("replyNotificationMessage / REPLY_NOTIFICATION_TITLE", () => {
  it("タイトルは固定の文面", () => {
    assert.equal(REPLY_NOTIFICATION_TITLE, "質問に回答がありました");
  });

  it("本文はコース名とレッスン名だけを入れる", () => {
    assert.equal(replyNotificationMessage("STEP1 ダミー", "ダミーレッスン"), "STEP1 ダミー / ダミーレッスン の質問に講師が回答しました");
  });
});

describe("shouldNotifyQuestionAuthor", () => {
  const student = { id: "stu_1", role: "STUDENT", deactivatedAt: null };

  it("回答者以外の、有効な受講生の質問なら true", () => {
    assert.equal(shouldNotifyQuestionAuthor(student, "ins_1"), true);
  });

  it("投稿者が回答者本人なら false", () => {
    assert.equal(shouldNotifyQuestionAuthor({ ...student, id: "ins_1", role: "INSTRUCTOR" }, "ins_1"), false);
    // 役割に関係なく本人なら false
    assert.equal(shouldNotifyQuestionAuthor(student, "stu_1"), false);
  });

  it("投稿者が講師（別の講師）なら false", () => {
    assert.equal(shouldNotifyQuestionAuthor({ id: "ins_2", role: "INSTRUCTOR", deactivatedAt: null }, "ins_1"), false);
  });

  it("無効化された受講生なら false", () => {
    assert.equal(shouldNotifyQuestionAuthor({ ...student, deactivatedAt: new Date("2026-09-01T00:00:00.000Z") }, "ins_1"), false);
  });

  it("未知の役割なら false", () => {
    assert.equal(shouldNotifyQuestionAuthor({ ...student, role: "ADMIN" }, "ins_1"), false);
  });
});

describe("parseReplyBody", () => {
  for (const [label, body, reason] of [
    ["配列", [{ content: "回答" }], "invalid_body"],
    ["null", null, "invalid_body"],
    ["文字列", "回答", "invalid_body"],
    ["content なし", {}, "invalid_content"],
    ["content が数値", { content: 1 }, "invalid_content"],
    ["content が空", { content: "" }, "empty"],
    ["content が空白だけ", { content: " \n\t " }, "empty"],
    ["content が見えない文字だけ", { content: "\u200B\u3164" }, "empty"],
    ["content が 2001 文字", { content: "あ".repeat(2001) }, "too_long"],
  ] as Array<[string, unknown, string]>) {
    it(`${label} は ${reason}`, () => {
      assert.deepEqual(parseReplyBody(body), { ok: false, reason });
    });
  }

  it("前後の空白を除き、中の改行は残す", () => {
    assert.deepEqual(parseReplyBody({ content: "  1行目\n2行目  " }), { ok: true, value: { content: "1行目\n2行目" } });
  });

  it("2000 文字ちょうどは通る（絵文字は 1 文字として数える）", () => {
    const r = parseReplyBody({ content: "\u{1F600}".repeat(2000) });
    assert.equal(r.ok, true, "2000 文字は通る");
  });

  it("content 以外の項目（userId・lessonId・parentId）は値に含めない", () => {
    assert.deepEqual(parseReplyBody({ content: "回答", userId: "stu_1", lessonId: "l1", parentId: "c1" }), {
      ok: true,
      value: { content: "回答" },
    });
  });

  it("本文の規則は POST /api/comments（parseCreateComment）と同じ", () => {
    for (const content of ["", " ", "\u200B", "あ".repeat(2001), " ok ", 1, null]) {
      const a = parseCommentContent(content);
      const b = parseCreateComment({ lessonId: "l1", content });
      const c = parseReplyBody({ content });
      if ("reason" in a) {
        assert.deepEqual(b, { ok: false, reason: a.reason }, `parseCreateComment: ${String(content)}`);
        assert.deepEqual(c, { ok: false, reason: a.reason }, `parseReplyBody: ${String(content)}`);
      } else {
        assert.equal("value" in b ? b.value.content : null, a.value, `parseCreateComment: ${String(content)}`);
        assert.equal("value" in c ? c.value.content : null, a.value, `parseReplyBody: ${String(content)}`);
      }
    }
  });
});

describe("isValidQuestionId", () => {
  it("空でない 64 文字以内の string だけ", () => {
    assert.equal(isValidQuestionId("c1"), true);
    assert.equal(isValidQuestionId("a".repeat(64)), true);
    assert.equal(isValidQuestionId("a".repeat(65)), false);
    assert.equal(isValidQuestionId(""), false);
    assert.equal(isValidQuestionId(1), false);
    assert.equal(isValidQuestionId(undefined), false);
  });
});

// ───────────── 追加の観点（#32 A-1 テスト担当） ─────────────

// 切り出し前（main d78b186）の parseCreateComment の content 部分を、そのまま写したもの
function legacyContent(content: unknown): { ok: false; reason: string } | { ok: true; value: string } {
  if (typeof content !== "string") return { ok: false, reason: "invalid_content" };
  const trimmed = content.trim();
  if (trimmed === "" || !hasVisibleText(trimmed)) return { ok: false, reason: "empty" };
  if (commentLength(trimmed) > COMMENT_MAX_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, value: trimmed };
}

const CONTENT_CASES: Array<[string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["数値", 0],
  ["true", true],
  ["配列", ["a"]],
  ["オブジェクト", { a: 1 }],
  ["空", ""],
  ["半角空白", "   "],
  ["改行とタブ", "\n\t\r\n"],
  ["全角空白", "\u3000"],
  ["NBSP", "\u00A0\u00A0"],
  ["ゼロ幅文字", "\u200B\u200C\u200D"],
  ["WORD JOINER と BOM", "\u2060\uFEFF"],
  ["ハングルフィラー", "\u3164\u115F\u1160\uFFA0"],
  ["異体字セレクタだけ", "\uFE0F\uFE0F"],
  ["結合文字だけ", "\u0301\u0308"],
  ["ソフトハイフン", "\u00AD"],
  ["見えない文字＋a", "\u200Ba"],
  ["前後空白・中の改行", "  1行目\n\n2行目  "],
  ["1 文字", "a"],
  ["記号だけ", "?"],
  ["絵文字だけ", "\u{1F600}"],
  ["2000 文字", "あ".repeat(2000)],
  ["2001 文字", "あ".repeat(2001)],
  ["絵文字 2000 個", "\u{1F600}".repeat(2000)],
  ["絵文字 2001 個", "\u{1F600}".repeat(2001)],
  ["1999 文字＋絵文字", `${"あ".repeat(1999)}\u{1F600}`],
  ["2000 文字＋絵文字", `${"あ".repeat(2000)}\u{1F600}`],
  ["前後空白つき 2000 文字", ` ${"あ".repeat(2000)} `],
  ["結合文字で 2001 コードポイント", `${"e".repeat(1000)}${"\u0301".repeat(1001)}`],
  ["家族の絵文字（ZWJ）×400", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}".repeat(400)],
  ["家族の絵文字（ZWJ）×401", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}".repeat(401)],
  // 孤立したサロゲートは #86 で invalid_characters に変えた（下の「#86」の describe で確かめる）
];

describe("parseCommentContent の切り出しで挙動が変わっていない", () => {
  for (const [label, content] of CONTENT_CASES) {
    it(`${label}：切り出し前と同じ結果`, () => {
      const expected = legacyContent(content);
      assert.deepEqual(parseCommentContent(content), expected, `parseCommentContent: ${label}`);
      const b = parseCreateComment({ lessonId: "l1", content });
      const c = parseReplyBody({ content });
      if (expected.ok) {
        assert.deepEqual(b, { ok: true, value: { lessonId: "l1", content: expected.value, parentId: null } }, `parseCreateComment: ${label}`);
        assert.deepEqual(c, { ok: true, value: { content: expected.value } }, `parseReplyBody: ${label}`);
      } else {
        assert.deepEqual(b, expected, `parseCreateComment: ${label}`);
        assert.deepEqual(c, expected, `parseReplyBody: ${label}`);
      }
    });
  }

  it("境界の期待値（固定）", () => {
    assert.deepEqual(parseCommentContent("\u{1F600}".repeat(2000)), { ok: true, value: "\u{1F600}".repeat(2000) });
    assert.deepEqual(parseCommentContent("\u{1F600}".repeat(2001)), { ok: false, reason: "too_long" });
    assert.deepEqual(parseCommentContent(` ${"あ".repeat(2000)} `), { ok: true, value: "あ".repeat(2000) });
    assert.deepEqual(parseCommentContent("\u200B\u3164"), { ok: false, reason: "empty" });
    assert.deepEqual(parseCommentContent(["a"]), { ok: false, reason: "invalid_content" });
  });

  it("parseCreateComment の理由の優先順位は変わらない（body → lessonId → content → parentId）", () => {
    assert.deepEqual(parseCreateComment(null), { ok: false, reason: "invalid_body" });
    assert.deepEqual(parseCreateComment([]), { ok: false, reason: "invalid_body" });
    assert.deepEqual(parseCreateComment({ content: "" }), { ok: false, reason: "invalid_lesson_id" });
    assert.deepEqual(parseCreateComment({ lessonId: "", content: 1, parentId: 1 }), { ok: false, reason: "invalid_lesson_id" });
    assert.deepEqual(parseCreateComment({ lessonId: "l1", content: "", parentId: 1 }), { ok: false, reason: "empty" });
    assert.deepEqual(parseCreateComment({ lessonId: "l1", content: "a".repeat(2001), parentId: "" }), { ok: false, reason: "too_long" });
    assert.deepEqual(parseCreateComment({ lessonId: "l1", content: "a", parentId: "" }), { ok: false, reason: "invalid_parent_id" });
    assert.deepEqual(parseCreateComment({ lessonId: "l1", content: "a", parentId: "p".repeat(65) }), { ok: false, reason: "invalid_parent_id" });
    assert.deepEqual(parseCreateComment({ lessonId: "l1", content: " a ", parentId: "p1" }), { ok: true, value: { lessonId: "l1", content: "a", parentId: "p1" } });
  });
});

describe("parseReplyBody（追加）", () => {
  it("body の検証は content より先（配列の中に content があっても invalid_body）", () => {
    assert.deepEqual(parseReplyBody([]), { ok: false, reason: "invalid_body" });
    assert.deepEqual(parseReplyBody(Object.assign([], { content: "回答" })), { ok: false, reason: "invalid_body" });
    assert.deepEqual(parseReplyBody(1), { ok: false, reason: "invalid_body" });
    assert.deepEqual(parseReplyBody(undefined), { ok: false, reason: "invalid_body" });
  });

  it("__proto__ や constructor を送っても content だけを返す", () => {
    const body = JSON.parse('{"content":"回答","__proto__":{"userId":"stu_1"},"constructor":{"x":1}}');
    const r = parseReplyBody(body);
    assert.deepEqual(r, { ok: true, value: { content: "回答" } });
    assert.deepEqual(Object.keys((r as { value: object }).value), ["content"], "value の項目は content だけ");
  });
});

describe("replyNotificationMessage・shouldNotifyQuestionAuthor（追加）", () => {
  it("コース名・レッスン名をそのまま入れ、他の情報を足さない", () => {
    const m = replyNotificationMessage("STEP8 ダミー", "最後のレッスン");
    assert.equal(m, "STEP8 ダミー / 最後のレッスン の質問に講師が回答しました");
    assert.ok(!/講師ビー|@|stu_|ins_/.test(m), "講師名・ID・メールを含めない");
  });

  it("小文字の student・空の role は通知しない（STUDENT と完全一致だけ）", () => {
    for (const role of ["student", " STUDENT", "", "INSTRUCTOR"]) {
      assert.equal(shouldNotifyQuestionAuthor({ id: "stu_1", role, deactivatedAt: null }, "ins_1"), false, `role=${JSON.stringify(role)}`);
    }
  });

  it("無効化日時が未来でも、無効化済みとして通知しない", () => {
    assert.equal(shouldNotifyQuestionAuthor({ id: "stu_1", role: "STUDENT", deactivatedAt: new Date("2999-01-01T00:00:00.000Z") }, "ins_1"), false);
  });
});
