import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCreateComment, parseCommentContent } from "./lesson-comments";
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
    ["content が見えない文字だけ", { content: "​ㅤ" }, "empty"],
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
    for (const content of ["", " ", "​", "あ".repeat(2001), " ok ", 1, null]) {
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
