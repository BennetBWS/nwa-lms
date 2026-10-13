import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE,
  REPLY_SAVED_AFTER_UNKNOWN_MESSAGE,
  expandResolvedIds,
  nextReplyDrafts,
  nextReplyErrors,
  nextReplyNotices,
  nextUncertainReplies,
  resolveUncertainReplies,
} from "./admin-questions";
import {
  COMMENT_NETWORK_ERROR_MESSAGE,
  COMMENT_SERVER_ERROR_MESSAGE,
  COMMENT_SESSION_EXPIRED_MESSAGE,
  COMMENT_UNKNOWN_RESULT_MESSAGE,
  commentSubmitErrorMessage,
  isUncertainSubmitError,
} from "./comment-form";

// #32 A-2：回答の送信結果が分からないとき（通信エラー・2xx で応答を読めない）に、一覧を読み直して結果を確かめる純関数。

describe("isUncertainSubmitError", () => {
  it("通信エラー・結果不明の文言だけ true", () => {
    assert.equal(isUncertainSubmitError(COMMENT_NETWORK_ERROR_MESSAGE), true);
    assert.equal(isUncertainSubmitError(COMMENT_UNKNOWN_RESULT_MESSAGE), true);
    assert.equal(isUncertainSubmitError(commentSubmitErrorMessage({ httpStatus: null })), true);
  });

  it("400 / 401 / 403 / 404 / 5xx・空・文字列でない値は false", () => {
    for (const s of [400, 401, 403, 404, 500, 503]) {
      assert.equal(isUncertainSubmitError(commentSubmitErrorMessage({ httpStatus: s, reason: "not_a_question" })), false, String(s));
    }
    for (const v of [COMMENT_SERVER_ERROR_MESSAGE, COMMENT_SESSION_EXPIRED_MESSAGE, REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE, "", undefined, null, 1]) {
      assert.equal(isUncertainSubmitError(v), false, String(v));
    }
  });
});

const row = (id: string, answered: unknown) => ({ id, content: "ダミー", answered });

describe("resolveUncertainReplies", () => {
  it("記録より後に始めた読み込みで、回答済みは saved、未回答は notSaved", () => {
    const r = resolveUncertainReplies({ t1: 3, t2: 3 }, 4, [row("t1", true), row("t2", false), row("t3", true)]);
    assert.deepEqual(r, { saved: ["t1"], notSaved: ["t2"] });
  });

  it("記録した時点以前に始めた読み込み（pageSeq が同じ・小さい）では判定しない", () => {
    for (const seq of [2, 3]) {
      assert.deepEqual(resolveUncertainReplies({ t1: 3 }, seq, [row("t1", true)]), { saved: [], notSaved: [] }, String(seq));
    }
  });

  it("一覧にない・answered が boolean でない・行が壊れているときは判定しない", () => {
    const rows: unknown[] = [null, "t1", row("t2", "true"), row("t3", undefined), { id: "t4" }];
    assert.deepEqual(resolveUncertainReplies({ t1: 0, t2: 0, t3: 0, t4: 0, t5: 0 }, 1, rows), { saved: [], notSaved: [] });
  });

  it("結果不明の記録がなければ何もしない（通常の行は対象外）", () => {
    assert.deepEqual(resolveUncertainReplies({}, 9, [row("t1", true), row("t2", false)]), { saved: [], notSaved: [] });
  });

  it("同じ id の行が複数あれば最初の行で判定する", () => {
    assert.deepEqual(resolveUncertainReplies({ t1: 0 }, 1, [row("t1", false), row("t1", true)]), { saved: [], notSaved: ["t1"] });
  });
});

describe("判定の反映", () => {
  const r = { saved: ["t1"], notSaved: ["t2"] };

  it("結果不明の記録から判定した質問を外す（他は残す）", () => {
    assert.deepEqual(nextUncertainReplies({ t1: 1, t2: 1, t3: 1 }, r), { t3: 1 });
  });

  it("エラー：saved は消し、notSaved は「保存されていませんでした」、他の質問のエラーはそのまま", () => {
    const prev = { t1: COMMENT_NETWORK_ERROR_MESSAGE, t2: COMMENT_UNKNOWN_RESULT_MESSAGE, t3: COMMENT_SERVER_ERROR_MESSAGE };
    assert.deepEqual(nextReplyErrors(prev, r), { t2: REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE, t3: COMMENT_SERVER_ERROR_MESSAGE });
    assert.ok(REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE.includes("もう一度送信"), "再送の案内がない");
    assert.equal(isUncertainSubmitError(REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE), false);
  });

  it("書きかけ：saved だけ消し、notSaved と他の質問は残す", () => {
    assert.deepEqual(nextReplyDrafts({ t1: "a", t2: "b", t3: "c" }, r), { t2: "b", t3: "c" });
  });

  it("知らせ：saved に「保存されていました」、notSaved の知らせは消す", () => {
    assert.deepEqual(nextReplyNotices({ t2: "古い知らせ", t3: "x" }, r), { t1: REPLY_SAVED_AFTER_UNKNOWN_MESSAGE, t3: "x" });
    assert.ok(REPLY_SAVED_AFTER_UNKNOWN_MESSAGE.includes("保存されていました"), "保存の知らせでない");
  });

  it("前の値を書き換えない", () => {
    const errors = { t1: "e" };
    const drafts = { t1: "d" };
    const uncertain = { t1: 1 };
    nextReplyErrors(errors, r);
    nextReplyDrafts(drafts, r);
    nextUncertainReplies(uncertain, r);
    assert.deepEqual([errors, drafts, uncertain], [{ t1: "e" }, { t1: "d" }, { t1: 1 }]);
  });

  it("判定した質問を開く（順序を保ち重複させない）", () => {
    assert.deepEqual(expandResolvedIds(["t2", "t9"], r), ["t2", "t9", "t1"]);
    assert.deepEqual(expandResolvedIds([], { saved: [], notSaved: [] }), []);
  });
});
