import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMMENT_ALREADY_DELETED_MESSAGE,
  DELETE_QUOTE_MAX_CHARS,
  DELETE_UNKNOWN_RESULT_MESSAGE,
  REPLY_DELETED_MESSAGE,
  REPLY_DELETED_NOW_UNANSWERED_MESSAGE,
  adminCommentDeleteUrl,
  deleteConfirmMessage,
  deleteDialogTitle,
  deleteErrorMessage,
  deleteQuote,
  interpretDeleteResponse,
  isDeleteBlocked,
  questionDeletedMessage,
  removeReplyFromRow,
  removeThreadRow,
  replyDeleteLabel,
  replyDeletedMessage,
  resolveDeleteTarget,
  withoutThreadId,
  type DeleteTarget,
} from "./admin-questions";
import { COMMENT_SESSION_EXPIRED_MESSAGE } from "./comment-form";
import { isValidQuestionId } from "./question-reply";

// #47 P2 質問対応画面（AdminQuestions）の削除：URL・確認の文言・本文の引用・応答の判定・行の片付け。データはすべてダミー。

const Q: DeleteTarget = { kind: "question", id: "q1", threadId: "q1", replyCount: 2 };
const R: DeleteTarget = { kind: "reply", id: "r1", threadId: "q1" };

describe("adminCommentDeleteUrl", () => {
  it("DELETE /api/admin/comments/[id]。id はエンコードする", () => {
    assert.equal(adminCommentDeleteUrl("q1"), "/api/admin/comments/q1");
    assert.equal(adminCommentDeleteUrl("a/b?c"), "/api/admin/comments/a%2Fb%3Fc");
  });

  it("API の id の検証を通る id はそのまま使われる", () => {
    const id = "clx0000000000000000000000";
    assert.ok(isValidQuestionId(id), "ダミーの id が検証を通らない");
    assert.equal(adminCommentDeleteUrl(id), `/api/admin/comments/${id}`);
  });
});

describe("deleteConfirmMessage・deleteDialogTitle", () => {
  it("質問：返信の件数を出し、元に戻せないことを伝える", () => {
    assert.equal(deleteConfirmMessage(Q), "この質問と返信 2 件を削除します。元に戻せません。");
    assert.equal(deleteDialogTitle("question"), "質問を削除");
  });

  it("返信が 0 件（または壊れた数）の質問は件数を出さない", () => {
    for (const replyCount of [0, -1, 1.5, Number.NaN]) {
      assert.equal(deleteConfirmMessage({ ...Q, replyCount }), "この質問を削除します。元に戻せません。", String(replyCount));
    }
  });

  it("返信", () => {
    assert.equal(deleteConfirmMessage(R), "この返信を削除します。元に戻せません。");
    assert.equal(deleteDialogTitle("reply"), "返信を削除");
  });
});

describe("deleteQuote", () => {
  it("短い本文はそのまま。改行・連続した空白は 1 つの空白にまとめ、前後の空白を除く", () => {
    assert.equal(deleteQuote("  質問です\n\n2 行目\tです  "), "質問です 2 行目 です");
  });

  it("DELETE_QUOTE_MAX_CHARS 書記素で切り、末尾に「…」を付ける", () => {
    const long = "あ".repeat(DELETE_QUOTE_MAX_CHARS + 5);
    assert.equal(deleteQuote(long), `${"あ".repeat(DELETE_QUOTE_MAX_CHARS)}…`);
    assert.equal(deleteQuote("あ".repeat(DELETE_QUOTE_MAX_CHARS)), "あ".repeat(DELETE_QUOTE_MAX_CHARS));
  });

  it("絵文字（ZWJ でつないだもの・サロゲートペア）を途中で切らない", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const s = "あ".repeat(DELETE_QUOTE_MAX_CHARS - 1) + family + "い";
    assert.equal(deleteQuote(s), `${"あ".repeat(DELETE_QUOTE_MAX_CHARS - 1)}${family}…`);
  });

  it("見えない文字（幅のない空白・向きの制御文字・BOM）を除く", () => {
    assert.equal(deleteQuote("\u202Eabc\u200Bdef\uFEFF"), "abcdef");
  });

  it("見える文字が残らない・文字列でないときは空文字（画面は引用を出さない）", () => {
    for (const v of ["", "   ", "\u200B\u202E", "\u3164", null, undefined, 1]) {
      assert.equal(deleteQuote(v), "", String(v));
    }
  });
});

describe("deleteErrorMessage", () => {
  it("ステータスごとの文言", () => {
    assert.equal(deleteErrorMessage(null), DELETE_UNKNOWN_RESULT_MESSAGE);
    assert.equal(deleteErrorMessage(401), COMMENT_SESSION_EXPIRED_MESSAGE);
    assert.equal(deleteErrorMessage(200, true), COMMENT_SESSION_EXPIRED_MESSAGE);
    assert.equal(deleteErrorMessage(403), "この操作を行う権限がありません。");
    assert.match(deleteErrorMessage(400), /対象が正しくありません/);
    for (const s of [502, 503, 504]) assert.equal(deleteErrorMessage(s), DELETE_UNKNOWN_RESULT_MESSAGE, String(s));
    assert.match(deleteErrorMessage(500), /サーバーでエラー/);
  });
});

describe("interpretDeleteResponse", () => {
  const ok = (body: unknown, target: DeleteTarget = Q) => interpretDeleteResponse({ ok: true, status: 200, redirected: false, body, target });
  const thread = { id: "q1", content: "質問", replies: [], answered: false };

  it("質問：kind と id が合えば成功。deletedReplies が読めなければ null", () => {
    assert.deepEqual(ok({ kind: "question", id: "q1", deletedReplies: 3 }), { kind: "question_deleted", deletedReplies: 3 });
    assert.deepEqual(ok({ kind: "question", id: "q1", deletedReplies: "3" }), { kind: "question_deleted", deletedReplies: null });
    assert.deepEqual(ok({ kind: "question", id: "q1", deletedReplies: -1 }), { kind: "question_deleted", deletedReplies: null });
  });

  it("返信：thread が根の質問（threadId）で、content が文字列・replies が配列なら成功", () => {
    assert.deepEqual(ok({ kind: "reply", id: "r1", thread }, R), { kind: "reply_deleted", thread });
  });

  it("2xx でも id・kind・thread が合わなければ、削除できたか分からない", () => {
    const unknown = { kind: "error", message: DELETE_UNKNOWN_RESULT_MESSAGE };
    assert.deepEqual(ok({ kind: "question", id: "other" }), unknown);
    assert.deepEqual(ok({ kind: "reply", id: "q1", thread }), unknown);
    assert.deepEqual(ok(null), unknown);
    assert.deepEqual(ok("<html>"), unknown);
    assert.deepEqual(ok({ kind: "reply", id: "r1", thread: { ...thread, id: "other" } }, R), unknown);
    assert.deepEqual(ok({ kind: "reply", id: "r1", thread: { ...thread, replies: null } }, R), unknown);
    assert.deepEqual(ok({ kind: "reply", id: "r1" }, R), unknown);
    assert.deepEqual(ok({ kind: "question", id: "r1", deletedReplies: 0 }, R), unknown);
  });

  it("404 はすでに削除されている。リダイレクトされた応答は 404 でもセッション切れ", () => {
    assert.deepEqual(interpretDeleteResponse({ ok: false, status: 404, redirected: false, body: { error: "Comment not found" }, target: R }), { kind: "gone" });
    assert.deepEqual(interpretDeleteResponse({ ok: true, status: 200, redirected: true, body: { kind: "question", id: "q1" }, target: Q }), {
      kind: "error",
      message: COMMENT_SESSION_EXPIRED_MESSAGE,
    });
  });

  it("それ以外の失敗は deleteErrorMessage の文言", () => {
    for (const status of [400, 401, 403, 500, 502]) {
      assert.deepEqual(interpretDeleteResponse({ ok: false, status, redirected: false, body: null, target: Q }), { kind: "error", message: deleteErrorMessage(status) }, String(status));
    }
  });
});

describe("知らせ", () => {
  it("質問：消した返信の件数を出す（0 件・読めないときは出さない）", () => {
    assert.equal(questionDeletedMessage(2), "質問と返信 2 件を削除しました");
    assert.equal(questionDeletedMessage(0), "質問を削除しました");
    assert.equal(questionDeletedMessage(null), "質問を削除しました");
  });

  it("返信：回答済みから未回答に戻ったときだけ、そのことを伝える", () => {
    assert.equal(replyDeletedMessage(true, { answered: false }), REPLY_DELETED_NOW_UNANSWERED_MESSAGE);
    assert.equal(replyDeletedMessage(true, { answered: true }), REPLY_DELETED_MESSAGE);
    assert.equal(replyDeletedMessage(false, { answered: false }), REPLY_DELETED_MESSAGE);
    assert.equal(COMMENT_ALREADY_DELETED_MESSAGE, "すでに削除されています");
  });
});

describe("行の片付け", () => {
  it("removeThreadRow：id が同じ行だけを除き、該当がなければ同じ配列を返す", () => {
    const rows = [{ id: "q1" }, { id: "q2" }, "broken"];
    assert.deepEqual(removeThreadRow(rows, "q1"), [{ id: "q2" }, "broken"]);
    assert.equal(removeThreadRow(rows, "zz"), rows);
  });

  it("removeReplyFromRow：返信を除き、replyCount を 1 減らし、answered を残った講師の返信で決め直す", () => {
    const rows = [
      {
        id: "q1",
        replyCount: 2,
        answered: true,
        replies: [
          { id: "r1", author: { isInstructor: true } },
          { id: "r2", author: { isInstructor: false } },
        ],
      },
      { id: "q2", replies: [{ id: "r1" }] },
    ];
    const next = removeReplyFromRow(rows, "q1", "r1") as Array<Record<string, unknown>>;
    assert.deepEqual(next[0], { id: "q1", replyCount: 1, answered: false, replies: [{ id: "r2", author: { isInstructor: false } }] });
    assert.equal(next[1], rows[1], "別の質問の行は変えない");
    assert.equal(removeReplyFromRow(rows, "q1", "zz"), rows);
    assert.equal(removeReplyFromRow(rows, "zz", "r1"), rows);
  });

  it("removeReplyFromRow：replyCount が壊れていれば残った返信の数、0 未満にしない", () => {
    const a = removeReplyFromRow([{ id: "q1", replyCount: "x", replies: [{ id: "r1" }, { id: "r2" }] }], "q1", "r1") as Array<Record<string, unknown>>;
    assert.equal(a[0].replyCount, 1);
    const b = removeReplyFromRow([{ id: "q1", replyCount: 0, replies: [{ id: "r1" }] }], "q1", "r1") as Array<Record<string, unknown>>;
    assert.equal(b[0].replyCount, 0);
  });

  it("withoutThreadId：その id だけを除き、なければ同じオブジェクトを返す", () => {
    const prev = { q1: "a", q2: "b" };
    assert.deepEqual(withoutThreadId(prev, "q1"), { q2: "b" });
    assert.deepEqual(prev, { q1: "a", q2: "b" }, "元のオブジェクトを書き換えない");
    assert.equal(withoutThreadId(prev, "zz"), prev);
    assert.equal(withoutThreadId(prev, "toString"), prev, "プロトタイプのキーで誤判定しない");
  });

  it("isDeleteBlocked：回答の送信中・結果不明の間は止める", () => {
    assert.equal(isDeleteBlocked({ sending: false, awaitingCheck: false }), false);
    assert.equal(isDeleteBlocked({ sending: true, awaitingCheck: false }), true);
    assert.equal(isDeleteBlocked({ sending: false, awaitingCheck: true }), true);
  });
});

// ───────────── 追加（tester）：境界値・形の違う応答 ─────────────

describe("追加：deleteConfirmMessage の件数", () => {
  it("1 件・2 桁でも「返信 N 件」（半角数字の前後に空白）。返信の確認は件数に左右されない", () => {
    assert.equal(deleteConfirmMessage({ ...Q, replyCount: 1 }), "この質問と返信 1 件を削除します。元に戻せません。");
    assert.equal(deleteConfirmMessage({ ...Q, replyCount: 12 }), "この質問と返信 12 件を削除します。元に戻せません。");
    for (const replyCount of [Number.POSITIVE_INFINITY, "3" as unknown as number, undefined as unknown as number]) {
      assert.equal(deleteConfirmMessage({ ...Q, replyCount }), "この質問を削除します。元に戻せません。", String(replyCount));
    }
  });
});

describe("追加：deleteQuote の境界", () => {
  it("ちょうど上限なら「…」を付けず、1 書記素でも超えたら付ける", () => {
    const at = "x".repeat(DELETE_QUOTE_MAX_CHARS);
    assert.equal(deleteQuote(at), at);
    assert.equal(deleteQuote(`${at}y`), `${at}…`);
  });

  it("切った位置の直前の空白は残さない（「…」の前に空白を置かない）", () => {
    const s = `${"あ".repeat(DELETE_QUOTE_MAX_CHARS - 1)} いいい`;
    assert.equal(deleteQuote(s), `${"あ".repeat(DELETE_QUOTE_MAX_CHARS - 1)}…`);
  });

  it("CRLF・タブ・全角空白の続きも 1 つの空白にまとめる", () => {
    assert.equal(deleteQuote("一行目\r\n\r\n\t二行目\u3000\u3000三"), "一行目 二行目 三");
  });

  it("国旗・肌の色・結合文字は 1 書記素として数え、途中で切らない", () => {
    const flag = "\u{1F1EF}\u{1F1F5}";
    const thumb = "\u{1F44D}\u{1F3FD}";
    const ga = "か\u3099";
    for (const g of [flag, thumb, ga]) {
      const s = g.repeat(DELETE_QUOTE_MAX_CHARS + 1);
      const q = deleteQuote(s);
      assert.equal(q, `${g.repeat(DELETE_QUOTE_MAX_CHARS)}…`, `途中で切った：${JSON.stringify(q)}`);
    }
  });

  it("向きの制御文字（RLO・LRI・PDI など）で引用の外側の表示を崩さない", () => {
    const q = deleteQuote("\u202Babc\u2066def\u2069\u202C");
    assert.equal(q, "abcdef");
    assert.doesNotMatch(q, /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/);
  });
});

describe("追加：deleteErrorMessage・interpretDeleteResponse", () => {
  it("想定外のステータス（429・501・418）はサーバーのエラー。リダイレクトはステータスによらずセッション切れ", () => {
    for (const s of [418, 429, 501]) assert.match(deleteErrorMessage(s), /サーバーでエラー/, String(s));
    for (const s of [200, 302, 404, 500]) assert.equal(deleteErrorMessage(s, true), COMMENT_SESSION_EXPIRED_MESSAGE, String(s));
  });

  it("2xx の空の応答（204 など、body が null）は成功としない", () => {
    assert.deepEqual(interpretDeleteResponse({ ok: true, status: 204, redirected: false, body: null, target: Q }), {
      kind: "error",
      message: DELETE_UNKNOWN_RESULT_MESSAGE,
    });
  });

  it("404 は本文がオブジェクト（API の JSON）のときだけ「すでに削除されている」。HTML・読めない本文は削除できたか分からない（質問・返信とも）", () => {
    for (const target of [Q, R]) {
      for (const body of [{ error: "Comment not found" }, {}]) {
        assert.deepEqual(interpretDeleteResponse({ ok: false, status: 404, redirected: false, body, target }), { kind: "gone" }, JSON.stringify(body));
      }
      for (const body of [null, "<html>", ["x"], 404]) {
        assert.deepEqual(
          interpretDeleteResponse({ ok: false, status: 404, redirected: false, body, target }),
          { kind: "error", message: DELETE_UNKNOWN_RESULT_MESSAGE },
          JSON.stringify(body)
        );
      }
    }
  });

  it("質問の deletedReplies が整数でない（1.5・NaN・Infinity）ときは件数を出さない", () => {
    for (const n of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const o = interpretDeleteResponse({ ok: true, status: 200, redirected: false, body: { kind: "question", id: "q1", deletedReplies: n }, target: Q });
      assert.deepEqual(o, { kind: "question_deleted", deletedReplies: null }, String(n));
    }
  });

  it("返信：thread の content が文字列でない・thread が配列なら成功としない", () => {
    const base = { id: "q1", content: "質問", replies: [] };
    for (const thread of [{ ...base, content: null }, [base], "q1"]) {
      assert.deepEqual(
        interpretDeleteResponse({ ok: true, status: 200, redirected: false, body: { kind: "reply", id: "r1", thread }, target: R }),
        { kind: "error", message: DELETE_UNKNOWN_RESULT_MESSAGE },
        JSON.stringify(thread)
      );
    }
  });
});

describe("追加：replyDeletedMessage・removeReplyFromRow", () => {
  it("answered が true 以外（文字列 \"true\"・欠落）なら、回答済みだった質問は未回答に戻ったと知らせる", () => {
    assert.equal(replyDeletedMessage(true, { answered: "true" }), REPLY_DELETED_NOW_UNANSWERED_MESSAGE);
    assert.equal(replyDeletedMessage(true, {}), REPLY_DELETED_NOW_UNANSWERED_MESSAGE);
    assert.equal(replyDeletedMessage(false, { answered: true }), REPLY_DELETED_MESSAGE);
  });

  it("講師の返信が残っていれば回答済みのまま。author が壊れた返信は講師として数えない", () => {
    const rows = [
      {
        id: "q1",
        replyCount: 3,
        answered: true,
        replies: [
          { id: "r1", author: { isInstructor: true } },
          { id: "r2", author: { isInstructor: true } },
          { id: "r3", author: "講師" },
        ],
      },
    ];
    const a = removeReplyFromRow(rows, "q1", "r1") as Array<Record<string, unknown>>;
    assert.equal(a[0].answered, true, "講師の返信が残っているのに未回答にした");
    assert.equal(a[0].replyCount, 2);
    const b = removeReplyFromRow(a, "q1", "r2") as Array<Record<string, unknown>>;
    assert.equal(b[0].answered, false, "author が文字列の返信を講師として数えた");
  });

  it("replies が配列でない行・壊れた行は変えない（元の配列を返す）", () => {
    const rows = [{ id: "q1", replies: null }, null, "q1"];
    assert.equal(removeReplyFromRow(rows, "q1", "r1"), rows);
  });

  it("removeThreadRow：同じ id の行が重複していれば両方とも除く", () => {
    assert.deepEqual(removeThreadRow([{ id: "q1" }, { id: "q2" }, { id: "q1" }], "q1"), [{ id: "q2" }]);
  });
});

describe("resolveDeleteTarget（確認ダイアログの対象を今の一覧から求める）", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "q1",
    content: "質問の本文",
    replyCount: 1,
    answered: true,
    replies: [{ id: "r1", content: "\u202E回答\u200Bです" }],
    ...over,
  });

  it("質問：今の行の返信の件数・回答済み・引用を使う", () => {
    assert.deepEqual(resolveDeleteTarget([row()], { kind: "question", id: "q1", threadId: "q1" }), {
      kind: "question",
      id: "q1",
      threadId: "q1",
      replyCount: 1,
      wasAnswered: true,
      quote: "質問の本文",
    });
    const later = resolveDeleteTarget([row({ replyCount: 3, answered: false })], { kind: "question", id: "q1", threadId: "q1" });
    assert.equal(later?.kind === "question" ? later.replyCount : null, 3, "件数が今の行の値でない");
    assert.equal(later?.wasAnswered, false, "回答済みが今の行の値でない");
  });

  it("返信：行の中の返信を探し、引用は見えない文字を除く。wasAnswered は質問の回答済み", () => {
    assert.deepEqual(resolveDeleteTarget([row()], { kind: "reply", id: "r1", threadId: "q1" }), {
      kind: "reply",
      id: "r1",
      threadId: "q1",
      wasAnswered: true,
      quote: "回答です",
    });
  });

  it("行・返信が見つからない、または質問の id と threadId が食い違うときは null", () => {
    assert.equal(resolveDeleteTarget([row()], { kind: "question", id: "q2", threadId: "q2" }), null);
    assert.equal(resolveDeleteTarget([row()], { kind: "reply", id: "r9", threadId: "q1" }), null);
    assert.equal(resolveDeleteTarget([row()], { kind: "reply", id: "r1", threadId: "q2" }), null);
    assert.equal(resolveDeleteTarget([row()], { kind: "question", id: "r1", threadId: "q1" }), null);
    assert.equal(resolveDeleteTarget([], { kind: "question", id: "q1", threadId: "q1" }), null);
  });
});

describe("replyDeleteLabel（返信の削除ボタンの読み上げ名）", () => {
  it("本文の先頭（20 書記素まで・見えない文字を除く）を添え、末尾は「を削除」", () => {
    assert.equal(replyDeleteLabel("講師ビー", "  回答\nです\u200B ", "5分前"), "講師ビー の返信「回答 です」を削除");
    const long = "あ".repeat(25);
    assert.equal(replyDeleteLabel("講師ビー", long, "5分前"), `講師ビー の返信「${"あ".repeat(20)}…」を削除`);
  });

  it("同じ名前・同じ時刻でも本文が違えば読み上げ名が違う", () => {
    assert.notEqual(replyDeleteLabel("受講生", "最初の返信", "1分前"), replyDeleteLabel("受講生", "二つ目の返信", "1分前"));
  });

  it("本文に見える文字がなければ投稿日時を添え、それもなければ名前だけ", () => {
    assert.equal(replyDeleteLabel("受講生", "\u200B\u202E", "1分前"), "受講生 の返信（1分前）を削除");
    assert.equal(replyDeleteLabel("受講生", "\u200B", ""), "受講生 の返信を削除");
  });
});
