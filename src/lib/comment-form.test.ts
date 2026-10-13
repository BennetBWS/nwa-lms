import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMMENT_MAX_LENGTH,
  COMMENT_NETWORK_ERROR_MESSAGE,
  COMMENT_SERVER_ERROR_MESSAGE,
  COMMENT_SESSION_EXPIRED_MESSAGE,
  commentFormState,
  commentSubmitErrorMessage,
} from "./comment-form";
import { parseCommentContent } from "./lesson-comments";

describe("commentFormState：文字数と送信の可否", () => {
  it("上限は 2000（サーバーと同じ）", () => {
    assert.equal(COMMENT_MAX_LENGTH, 2000);
  });

  it("空・空白だけ・見えない文字だけは送れない", () => {
    for (const v of ["", "   ", "\n\n", "\u200B", "\u3000\u200B\uFEFF", "\u00A0"]) {
      const s = commentFormState(v, false);
      assert.equal(s.empty, true, JSON.stringify(v));
      assert.equal(s.canSubmit, false, JSON.stringify(v));
    }
  });

  it("string でない値は空", () => {
    for (const v of [undefined, null, 1, {}]) {
      const s = commentFormState(v, false);
      assert.equal(s.empty, true, String(v));
      assert.equal(s.length, 0, String(v));
      assert.equal(s.canSubmit, false, String(v));
    }
  });

  it("前後の空白は数えず、中の改行は数える", () => {
    const s = commentFormState("  あ\nい  ", false);
    assert.equal(s.length, 3);
    assert.equal(s.counterLabel, "3 / 2000");
    assert.equal(s.canSubmit, true);
  });

  it("サロゲートペア（絵文字）は 1 文字", () => {
    assert.equal(commentFormState("\u{1F600}\u{1F600}", false).length, 2);
  });

  it("2000 字ちょうどは送れる、2001 字は送れない（超えた数を表示）", () => {
    const ok = commentFormState("あ".repeat(2000), false);
    assert.equal(ok.tooLong, false);
    assert.equal(ok.canSubmit, true);
    assert.equal(ok.counterLabel, "2000 / 2000");
    const ng = commentFormState("あ".repeat(2001), false);
    assert.equal(ng.tooLong, true);
    assert.equal(ng.canSubmit, false);
    assert.equal(ng.counterLabel, "2001 / 2000（1 文字オーバー）");
  });

  it("絵文字 2000 個（UTF-16 では 4000）も送れる", () => {
    assert.equal(commentFormState("\u{1F600}".repeat(2000), false).canSubmit, true);
  });

  it("送信中は送れない", () => {
    assert.equal(commentFormState("質問です", true).canSubmit, false);
  });

  it("送れる判定はサーバーの parseCommentContent と一致する", () => {
    const samples = ["", " ", "\u200B", "あ", " a ", "x".repeat(2000), "x".repeat(2001), " " + "y".repeat(2000) + " ", "\u{1F600}"];
    for (const v of samples) {
      const server = parseCommentContent(v);
      assert.equal(commentFormState(v, false).canSubmit, server.ok, `不一致：${JSON.stringify(v.slice(0, 10))}…（${v.length}）`);
    }
  });
});

describe("commentSubmitErrorMessage", () => {
  it("通信エラー（null）は再読み込みで確かめるよう案内する", () => {
    assert.equal(commentSubmitErrorMessage({ httpStatus: null }), COMMENT_NETWORK_ERROR_MESSAGE);
    assert.ok(COMMENT_NETWORK_ERROR_MESSAGE.includes("再読み込み"), "再読み込みの案内がない");
  });

  it("401・リダイレクトはログインの期限切れ", () => {
    assert.equal(commentSubmitErrorMessage({ httpStatus: 401 }), COMMENT_SESSION_EXPIRED_MESSAGE);
    assert.equal(commentSubmitErrorMessage({ httpStatus: 200, redirected: true }), COMMENT_SESSION_EXPIRED_MESSAGE);
  });

  it("400 は reason ごと", () => {
    assert.equal(commentSubmitErrorMessage({ httpStatus: 400, reason: "empty" }), "本文を入力してください。");
    assert.equal(commentSubmitErrorMessage({ httpStatus: 400, reason: "too_long" }), "本文は 2000 文字以内で入力してください。");
    assert.ok(commentSubmitErrorMessage({ httpStatus: 400, reason: "not_a_question" }).includes("回答できません"), "not_a_question の文言");
    assert.ok(commentSubmitErrorMessage({ httpStatus: 400, reason: "invalid_id" }).includes("再読み込み"), "invalid_id の文言");
    const bodyMsg = commentSubmitErrorMessage({ httpStatus: 400, reason: "invalid_body" });
    assert.equal(commentSubmitErrorMessage({ httpStatus: 400, reason: "invalid_content" }), bodyMsg);
  });

  it("400 の知らない reason・reason なし・prototype の名前は invalid_body と同じ文言", () => {
    const bodyMsg = commentSubmitErrorMessage({ httpStatus: 400, reason: "invalid_body" });
    for (const reason of [undefined, null, 1, "unknown", "toString", "__proto__", "constructor"]) {
      assert.equal(commentSubmitErrorMessage({ httpStatus: 400, reason }), bodyMsg, String(reason));
    }
  });

  it("403・404・5xx・その他", () => {
    assert.equal(commentSubmitErrorMessage({ httpStatus: 403 }), "この操作を行う権限がありません。");
    assert.ok(commentSubmitErrorMessage({ httpStatus: 404 }).includes("見つかりません"), "404 の文言");
    for (const s of [500, 502, 503, 409, 429, 200]) {
      assert.equal(commentSubmitErrorMessage({ httpStatus: s }), COMMENT_SERVER_ERROR_MESSAGE, String(s));
    }
  });

  it("文言は日本語で、英語の既定文言を含まない", () => {
    for (const s of [null, 400, 401, 403, 404, 500]) {
      const m = commentSubmitErrorMessage({ httpStatus: s });
      assert.doesNotMatch(m, /Error|error|Unauthorized|Forbidden/, String(s));
    }
  });
});
