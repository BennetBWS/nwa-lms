import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE,
  REPLY_SAVED_AFTER_UNKNOWN_MESSAGE,
  REPLY_SAVED_DRAFT_KEPT_AFTER_UNKNOWN_MESSAGE,
  REPLY_SAVED_MIXED_AFTER_UNKNOWN_MESSAGE,
  countMyInstructorReplies,
  expandResolvedIds,
  missingUncertainReplies,
  nextReplyDrafts,
  nextReplyErrors,
  nextReplyNotices,
  nextUncertainReplies,
  resolveUncertainReplies,
  savedDraftOutcome,
  savedReplyStatusMessage,
  uncertainReplyMissingMessage,
  uncertainReplyRecord,
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
  it("通信エラー・502 / 503 / 504・結果不明の文言だけ true", () => {
    assert.equal(isUncertainSubmitError(COMMENT_NETWORK_ERROR_MESSAGE), true);
    assert.equal(isUncertainSubmitError(COMMENT_UNKNOWN_RESULT_MESSAGE), true);
    assert.equal(isUncertainSubmitError(commentSubmitErrorMessage({ httpStatus: null })), true);
    for (const s of [502, 503, 504]) assert.equal(isUncertainSubmitError(commentSubmitErrorMessage({ httpStatus: s })), true, String(s));
  });

  it("400 / 401 / 403 / 404 / 500・空・文字列でない値は false", () => {
    for (const s of [400, 401, 403, 404, 500, 501]) {
      assert.equal(isUncertainSubmitError(commentSubmitErrorMessage({ httpStatus: s, reason: "not_a_question" })), false, String(s));
    }
    for (const v of [COMMENT_SERVER_ERROR_MESSAGE, COMMENT_SESSION_EXPIRED_MESSAGE, REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE, "", undefined, null, 1]) {
      assert.equal(isUncertainSubmitError(v), false, String(v));
    }
  });
});

type Reply = { content: unknown; mine?: unknown; isInstructor?: unknown };
const reply = (r: Reply, i: number) => ({
  id: `r${i}`,
  content: r.content,
  createdAt: "2026-10-01T00:00:00.000Z",
  author: { name: "講師ダミー", isInstructor: r.isInstructor ?? true },
  mine: r.mine ?? true,
});
const row = (id: string, replies: Reply[], answered = replies.some((r) => r.isInstructor !== false)) => ({
  id,
  content: "ダミー",
  answered,
  replies: replies.map(reply),
});
const rec = (seq: number, content: string, mineCount = 0) => ({ seq, content, mineCount });

describe("countMyInstructorReplies", () => {
  it("自分の（mine: true の）講師の返信で、本文が同じものだけを数える", () => {
    const r = row("t1", [
      { content: "回答" },
      { content: "回答" },
      { content: "回答", mine: false },
      { content: "回答", isInstructor: false },
      { content: "回答 " },
      { content: "別の回答" },
    ]);
    assert.equal(countMyInstructorReplies(r, "回答"), 2);
  });

  it("replies が配列でない・行でないときは null（数えられない）、返信がなければ 0", () => {
    for (const v of [null, undefined, "t1", { id: "t1" }, { id: "t1", replies: "x" }]) {
      assert.equal(countMyInstructorReplies(v, "回答"), null, JSON.stringify(v));
    }
    assert.equal(countMyInstructorReplies(row("t1", []), "回答"), 0);
  });

  it("壊れた返信（null・mine が文字列・author がない）は数えない", () => {
    const r = { id: "t1", replies: [null, { content: "回答", mine: "true", author: { isInstructor: true } }, { content: "回答", mine: true }] };
    assert.equal(countMyInstructorReplies(r, "回答"), 0);
  });
});

describe("uncertainReplyRecord", () => {
  it("送った本文の前後の空白を除き（サーバーと同じ）、送信した時点の行の件数を記録する", () => {
    const rows = [row("t0", [{ content: "回答" }]), row("t1", [{ content: "回答" }, { content: "前の回答" }])];
    assert.deepEqual(uncertainReplyRecord(5, "t1", " \n回答\u3000", rows), { seq: 5, content: "回答", mineCount: 1 });
  });

  it("行がない・数えられないときは 0 件、本文が文字列でなければ空", () => {
    assert.deepEqual(uncertainReplyRecord(1, "t9", "回答", [row("t1", [{ content: "回答" }])]), { seq: 1, content: "回答", mineCount: 0 });
    assert.deepEqual(uncertainReplyRecord(1, "t1", undefined, [{ id: "t1" }]), { seq: 1, content: "", mineCount: 0 });
  });
});

describe("resolveUncertainReplies", () => {
  it("記録より後に始めた読み込みで、自分の同じ本文の回答が増えていれば saved、増えていなければ notSaved", () => {
    const r = resolveUncertainReplies(
      { t1: rec(3, "回答"), t2: rec(3, "回答") },
      4,
      [row("t1", [{ content: "回答" }]), row("t2", []), row("t3", [{ content: "回答" }])]
    );
    assert.deepEqual(r, { saved: ["t1"], notSaved: ["t2"] });
  });

  it("回答済みの質問への追加の回答：前からある自分の回答（別の本文・同じ本文）では saved にしない", () => {
    // 送信前から「前の回答」と「回答」が 1 件ずつあった
    const before = [{ content: "前の回答" }, { content: "回答" }];
    const uncertain = { t1: rec(3, "回答", 1) };
    assert.deepEqual(resolveUncertainReplies(uncertain, 4, [row("t1", before)]), { saved: [], notSaved: ["t1"] }, "増えていないのに saved");
    assert.deepEqual(resolveUncertainReplies(uncertain, 4, [row("t1", [...before, { content: "回答" }])]), { saved: ["t1"], notSaved: [] }, "増えたのに saved でない");
  });

  it("別の講師の回答・受講生の返信が増えても saved にしない（answered が true でも）", () => {
    const rows = [row("t1", [{ content: "回答", mine: false }, { content: "回答", isInstructor: false, mine: true }], true)];
    assert.deepEqual(resolveUncertainReplies({ t1: rec(3, "回答") }, 4, rows), { saved: [], notSaved: ["t1"] });
  });

  it("記録した時点以前に始めた読み込み（pageSeq が同じ・小さい）では判定しない", () => {
    for (const seq of [2, 3]) {
      assert.deepEqual(resolveUncertainReplies({ t1: rec(3, "回答") }, seq, [row("t1", [{ content: "回答" }])]), { saved: [], notSaved: [] }, String(seq));
    }
  });

  it("一覧にない・replies が配列でない・行が壊れているときは判定しない", () => {
    const rows: unknown[] = [null, "t1", { id: "t2", replies: "x" }, { id: "t3", answered: true }];
    const uncertain = { t1: rec(0, "回答"), t2: rec(0, "回答"), t3: rec(0, "回答"), t4: rec(0, "回答") };
    assert.deepEqual(resolveUncertainReplies(uncertain, 1, rows), { saved: [], notSaved: [] });
  });

  it("結果不明の記録がなければ何もしない（通常の行は対象外）", () => {
    assert.deepEqual(resolveUncertainReplies({}, 9, [row("t1", [{ content: "回答" }]), row("t2", [])]), { saved: [], notSaved: [] });
  });

  it("同じ id の行が複数あれば最初の行で判定する", () => {
    const rows = [row("t1", []), row("t1", [{ content: "回答" }])];
    assert.deepEqual(resolveUncertainReplies({ t1: rec(0, "回答") }, 1, rows), { saved: [], notSaved: ["t1"] });
  });
});

describe("missingUncertainReplies", () => {
  it("判定の対象なのに一覧にない（数えられない）質問だけを返す", () => {
    const uncertain = { t1: rec(3, "回答"), t2: rec(3, "回答"), t3: rec(5, "回答"), t4: rec(3, "回答") };
    const rows = [row("t1", []), { id: "t4", replies: null }];
    assert.deepEqual(missingUncertainReplies(uncertain, 4, rows), ["t2", "t4"]);
    assert.deepEqual(missingUncertainReplies({}, 4, rows), []);
  });

  it("知らせの文言：未回答タブは回答済みタブを案内し、他のタブは続きがあるときだけ「もっと見る」を案内する", () => {
    for (const hasMore of [true, false]) {
      assert.ok(uncertainReplyMissingMessage("unanswered", hasMore).includes("回答済みタブ"), `未回答タブの文言（hasMore=${hasMore}）`);
    }
    for (const t of ["answered", "all"] as const) {
      assert.ok(uncertainReplyMissingMessage(t, true).includes("もっと見る"), `続きがあるのに「もっと見る」の案内がない：${t}`);
      assert.ok(!uncertainReplyMissingMessage(t, false).includes("もっと見る"), `続きがないのに「もっと見る」を案内した：${t}`);
      assert.ok(uncertainReplyMissingMessage(t, false).includes("他のタブ"), `続きがないときに他のタブの案内がない：${t}`);
    }
  });
});

describe("判定の反映", () => {
  const r = { saved: ["t1"], notSaved: ["t2"] };

  it("結果不明の記録から判定した質問を外す（他は残す）", () => {
    assert.deepEqual(nextUncertainReplies({ t1: rec(1, "a"), t2: rec(1, "b"), t3: rec(1, "c") }, r), { t3: rec(1, "c") });
  });

  it("エラー：saved は消し、notSaved は「保存されていない可能性が高い」、他の質問のエラーはそのまま", () => {
    const prev = { t1: COMMENT_NETWORK_ERROR_MESSAGE, t2: COMMENT_UNKNOWN_RESULT_MESSAGE, t3: COMMENT_SERVER_ERROR_MESSAGE };
    assert.deepEqual(nextReplyErrors(prev, r), { t2: REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE, t3: COMMENT_SERVER_ERROR_MESSAGE });
    assert.ok(REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE.includes("送信してください"), "再送の案内がない");
    assert.ok(REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE.includes("可能性"), "保存されていないと言い切っている（サーバーが処理中かもしれない）");
    assert.ok(REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE.includes("再読み込み"), "待ってから読み直す案内がない");
    assert.ok(REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE.includes("スレッドに自分の回答が出ていないか確かめて"), "再送の前にスレッドを確かめる案内がない（遅れて保存された回答は検出しない）");
    assert.equal(isUncertainSubmitError(REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE), false);
  });

  it("書きかけ：saved のうち送った本文のまま（cleared）だけ消し、書き直したもの・notSaved・他の質問は残す", () => {
    assert.deepEqual(nextReplyDrafts({ t1: "a", t2: "b", t3: "c" }, { cleared: ["t1"], kept: [] }), { t2: "b", t3: "c" });
    assert.deepEqual(nextReplyDrafts({ t1: "a", t2: "b", t3: "c" }, { cleared: [], kept: ["t1"] }), { t1: "a", t2: "b", t3: "c" });
  });

  it("知らせ：書きかけを消した saved に「入力欄は空にしました」、残した saved に「残してあります」、notSaved の知らせは消す", () => {
    assert.deepEqual(nextReplyNotices({ t2: "古い知らせ", t3: "x" }, r, { cleared: ["t1"], kept: [] }), { t1: REPLY_SAVED_AFTER_UNKNOWN_MESSAGE, t3: "x" });
    assert.deepEqual(nextReplyNotices({ t2: "古い知らせ", t3: "x" }, r, { cleared: [], kept: ["t1"] }), { t1: REPLY_SAVED_DRAFT_KEPT_AFTER_UNKNOWN_MESSAGE, t3: "x" });
    for (const m of [REPLY_SAVED_AFTER_UNKNOWN_MESSAGE, REPLY_SAVED_DRAFT_KEPT_AFTER_UNKNOWN_MESSAGE, REPLY_SAVED_MIXED_AFTER_UNKNOWN_MESSAGE]) {
      assert.ok(m.includes("保存されていました"), `保存の知らせでない：${m}`);
    }
    assert.ok(REPLY_SAVED_AFTER_UNKNOWN_MESSAGE.includes("入力欄は空にしました"), "消したのに空にした旨がない");
    assert.ok(!REPLY_SAVED_DRAFT_KEPT_AFTER_UNKNOWN_MESSAGE.includes("空にしました"), "残したのに空にしたと言っている");
    assert.ok(REPLY_SAVED_DRAFT_KEPT_AFTER_UNKNOWN_MESSAGE.includes("残してあります"), "残した旨がない");
    assert.ok(!REPLY_SAVED_MIXED_AFTER_UNKNOWN_MESSAGE.includes("空にしました"), "混在なのに空にしたと言い切っている");
  });

  it("読み上げの知らせ：消しただけ・残しただけ・混在・saved なしで分ける", () => {
    assert.equal(savedReplyStatusMessage({ cleared: ["t1"], kept: [] }), REPLY_SAVED_AFTER_UNKNOWN_MESSAGE);
    assert.equal(savedReplyStatusMessage({ cleared: [], kept: ["t1"] }), REPLY_SAVED_DRAFT_KEPT_AFTER_UNKNOWN_MESSAGE);
    assert.equal(savedReplyStatusMessage({ cleared: ["t1"], kept: ["t2"] }), REPLY_SAVED_MIXED_AFTER_UNKNOWN_MESSAGE);
    assert.equal(savedReplyStatusMessage({ cleared: [], kept: [] }), null);
  });

  it("前の値を書き換えない", () => {
    const errors = { t1: "e" };
    const drafts = { t1: "d" };
    const uncertain = { t1: rec(1, "a") };
    nextReplyErrors(errors, r);
    nextReplyDrafts(drafts, { cleared: ["t1"], kept: [] });
    nextUncertainReplies(uncertain, r);
    assert.deepEqual([errors, drafts, uncertain], [{ t1: "e" }, { t1: "d" }, { t1: rec(1, "a") }]);
  });

  it("判定した質問を開く（順序を保ち重複させない）", () => {
    assert.deepEqual(expandResolvedIds(["t2", "t9"], r), ["t2", "t9", "t1"]);
    assert.deepEqual(expandResolvedIds([], { saved: [], notSaved: [] }), []);
  });
});

describe("savedDraftOutcome", () => {
  const uncertain = { t1: rec(1, "送った回答"), t2: rec(1, "送った回答") };

  it("結果不明の間に書き直した書きかけは残す（kept）", () => {
    assert.deepEqual(savedDraftOutcome({ t1: "書き直した回答" }, uncertain, { saved: ["t1"], notSaved: [] }), { cleared: [], kept: ["t1"] });
  });

  it("送った本文と同じ書きかけは消す（cleared）", () => {
    assert.deepEqual(savedDraftOutcome({ t1: "送った回答" }, uncertain, { saved: ["t1"], notSaved: [] }), { cleared: ["t1"], kept: [] });
  });

  it("前後の空白だけが違う書きかけは同じとみなして消す（String.prototype.trim と同じ）", () => {
    // 全角空白（U+3000）・改行・タブも trim で除かれる
    const drafts = { t1: "  送った回答\n", t2: "\u3000\t送った回答\u3000" };
    assert.deepEqual(savedDraftOutcome(drafts, uncertain, { saved: ["t1", "t2"], notSaved: [] }), { cleared: ["t1", "t2"], kept: [] });
    // 本文の途中の空白の違いは書き直しとみなす
    assert.deepEqual(savedDraftOutcome({ t1: "送った 回答" }, uncertain, { saved: ["t1"], notSaved: [] }), { cleared: [], kept: ["t1"] });
  });

  it("書きかけがない・空白だけのときは消す（残すものがない）", () => {
    assert.deepEqual(savedDraftOutcome({ t2: " \n" }, uncertain, { saved: ["t1", "t2"], notSaved: [] }), { cleared: ["t1", "t2"], kept: [] });
  });

  it("notSaved は対象にしない。saved の順序を保つ", () => {
    const drafts = { t1: "書き直し", t2: "送った回答", t3: "x" };
    assert.deepEqual(savedDraftOutcome(drafts, uncertain, { saved: ["t2", "t1"], notSaved: ["t3"] }), { cleared: ["t2"], kept: ["t1"] });
  });

  it("前の値を書き換えない", () => {
    const drafts = { t1: "書き直し" };
    savedDraftOutcome(drafts, uncertain, { saved: ["t1"], notSaved: [] });
    assert.deepEqual([drafts, uncertain], [{ t1: "書き直し" }, { t1: rec(1, "送った回答"), t2: rec(1, "送った回答") }]);
  });
});
