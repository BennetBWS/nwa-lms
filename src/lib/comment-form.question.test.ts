import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMMENT_SERVER_ERROR_MESSAGE,
  COMMENT_SESSION_EXPIRED_MESSAGE,
  QUESTION_COURSE_LOCKED_MESSAGE,
  QUESTION_DUPLICATE_MESSAGE,
  QUESTION_POST_URL,
  QUESTION_POSTED_MESSAGE,
  QUESTION_RATE_LIMITED_MESSAGE,
  QUESTION_UNKNOWN_RESULT_MESSAGE,
  commentSubmitErrorMessage,
  interpretQuestionPostResponse,
  questionPostBody,
  questionSubmitErrorMessage,
  retryAfterHint,
} from "./comment-form";

// #46 B-2 受講生の質問の投稿欄：comment-form.ts に足した受講生向けの文言と応答の解釈。
// DB・ネットワークなし。

describe("questionSubmitErrorMessage：受講生向けの文言", () => {
  it("通信エラー（null）と 502 / 503 / 504 は結果不明", () => {
    for (const s of [null, 502, 503, 504]) {
      assert.equal(questionSubmitErrorMessage({ httpStatus: s }), QUESTION_UNKNOWN_RESULT_MESSAGE, String(s));
    }
  });

  it("結果不明の文言は一覧の確認と再送を案内し、二重投稿にならない旨は「直後」に限って書く", () => {
    assert.ok(QUESTION_UNKNOWN_RESULT_MESSAGE.includes("一覧"), "一覧の確認の案内がない");
    assert.ok(QUESTION_UNKNOWN_RESULT_MESSAGE.includes("もう一度送信"), "再送の案内がない");
    assert.ok(QUESTION_UNKNOWN_RESULT_MESSAGE.includes("直後に同じ内容"), "409 で守られる範囲（直後・同じ内容）の説明がない");
    assert.ok(QUESTION_UNKNOWN_RESULT_MESSAGE.includes("送信済み"), "送信済みの知らせの説明がない");
    assert.doesNotMatch(QUESTION_UNKNOWN_RESULT_MESSAGE, /二重に投稿されることはありません|必ず/);
  });

  it("401・リダイレクトはログインの期限切れ", () => {
    assert.equal(questionSubmitErrorMessage({ httpStatus: 401 }), COMMENT_SESSION_EXPIRED_MESSAGE);
    assert.equal(questionSubmitErrorMessage({ httpStatus: 200, redirected: true }), COMMENT_SESSION_EXPIRED_MESSAGE);
  });

  it("403 は reason ごと", () => {
    assert.equal(questionSubmitErrorMessage({ httpStatus: 403, reason: "course_locked" }), "このコースはまだ解放されていません。");
    assert.equal(QUESTION_COURSE_LOCKED_MESSAGE, "このコースはまだ解放されていません。");
    assert.ok(questionSubmitErrorMessage({ httpStatus: 403, reason: "forbidden_role" }).includes("質問対応"), "forbidden_role の文言");
    assert.ok(questionSubmitErrorMessage({ httpStatus: 403, reason: "reply_not_allowed" }).includes("返信は投稿できません"), "reply_not_allowed の文言");
    for (const reason of [undefined, null, "unknown", "toString", "__proto__", "constructor"]) {
      assert.equal(questionSubmitErrorMessage({ httpStatus: 403, reason }), "この操作を行う権限がありません。", String(reason));
    }
  });

  it("409 duplicate は「同じ内容の質問を送信済みです」。reason のない 409 はサーバーのエラー", () => {
    assert.equal(questionSubmitErrorMessage({ httpStatus: 409, reason: "duplicate" }), QUESTION_DUPLICATE_MESSAGE);
    assert.ok(QUESTION_DUPLICATE_MESSAGE.startsWith("同じ内容の質問を送信済みです"), "409 の文言");
    assert.equal(questionSubmitErrorMessage({ httpStatus: 409 }), COMMENT_SERVER_ERROR_MESSAGE);
  });

  it("429 は待ち時間を言い切らず、retryAfterSeconds を目安として添える", () => {
    assert.equal(QUESTION_RATE_LIMITED_MESSAGE, "続けて投稿できません。しばらく待ってからもう一度お試しください。");
    assert.equal(
      questionSubmitErrorMessage({ httpStatus: 429, reason: "rate_limited", retryAfterSeconds: 12 }),
      `${QUESTION_RATE_LIMITED_MESSAGE}（目安：約 12 秒後）`
    );
    // 目安がない・不正なら文言だけ（reason がなくても 429 は同じ扱い）
    for (const v of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, "30"]) {
      assert.equal(questionSubmitErrorMessage({ httpStatus: 429, retryAfterSeconds: v }), QUESTION_RATE_LIMITED_MESSAGE, String(v));
    }
    assert.doesNotMatch(QUESTION_RATE_LIMITED_MESSAGE, /\d+ ?秒後に/);
  });

  it("400：本文の検証は講師の回答欄と同じ文言、invalid_lesson_id は再読み込みの案内、それ以外は invalid_body と同じ", () => {
    for (const reason of ["empty", "too_long", "invalid_content", "invalid_body"]) {
      assert.equal(questionSubmitErrorMessage({ httpStatus: 400, reason }), commentSubmitErrorMessage({ httpStatus: 400, reason }), reason);
    }
    assert.ok(questionSubmitErrorMessage({ httpStatus: 400, reason: "invalid_lesson_id" }).includes("再読み込み"), "invalid_lesson_id の文言");
    const bodyMsg = commentSubmitErrorMessage({ httpStatus: 400, reason: "invalid_body" });
    // 講師の回答欄だけの reason（not_a_question・invalid_id）は受講生には出さない
    for (const reason of [undefined, "invalid_parent_id", "not_a_question", "invalid_id", "toString", "__proto__"]) {
      assert.equal(questionSubmitErrorMessage({ httpStatus: 400, reason }), bodyMsg, String(reason));
    }
  });

  it("404 はレッスンが見つからない、500 などはサーバーのエラー", () => {
    assert.ok(questionSubmitErrorMessage({ httpStatus: 404 }).includes("レッスンが見つかりません"), "404 の文言");
    for (const s of [500, 501, 505, 418]) {
      assert.equal(questionSubmitErrorMessage({ httpStatus: s }), COMMENT_SERVER_ERROR_MESSAGE, String(s));
    }
  });

  it("講師の回答欄の文言は変えていない（409・429 は従来どおりサーバーのエラー）", () => {
    assert.equal(commentSubmitErrorMessage({ httpStatus: 409, reason: "duplicate" }), COMMENT_SERVER_ERROR_MESSAGE);
    assert.equal(commentSubmitErrorMessage({ httpStatus: 429, reason: "rate_limited" }), COMMENT_SERVER_ERROR_MESSAGE);
    assert.equal(commentSubmitErrorMessage({ httpStatus: 403, reason: "course_locked" }), "この操作を行う権限がありません。");
  });

  it("文言は日本語で、英語の既定文言を含まない", () => {
    const samples: Array<Parameters<typeof questionSubmitErrorMessage>[0]> = [
      { httpStatus: null },
      { httpStatus: 400 },
      { httpStatus: 401 },
      { httpStatus: 403, reason: "forbidden_role" },
      { httpStatus: 403, reason: "reply_not_allowed" },
      { httpStatus: 403, reason: "course_locked" },
      { httpStatus: 404 },
      { httpStatus: 409, reason: "duplicate" },
      { httpStatus: 429, retryAfterSeconds: 30 },
      { httpStatus: 500 },
      { httpStatus: 503 },
    ];
    for (const s of samples) {
      assert.doesNotMatch(questionSubmitErrorMessage(s), /Error|error|Unauthorized|Forbidden|Too many|Conflict/, JSON.stringify(s));
    }
  });
});

describe("retryAfterHint：目安の文言", () => {
  it("秒・分・時間（切り上げ）", () => {
    assert.equal(retryAfterHint(1), "（目安：約 1 秒後）");
    assert.equal(retryAfterHint(29.2), "（目安：約 30 秒後）");
    assert.equal(retryAfterHint(59), "（目安：約 59 秒後）");
    assert.equal(retryAfterHint(60), "（目安：約 1 分後）");
    assert.equal(retryAfterHint(61), "（目安：約 2 分後）");
    assert.equal(retryAfterHint(3599), "（目安：約 60 分後）");
    assert.equal(retryAfterHint(3600), "（目安：約 1 時間後）");
    assert.equal(retryAfterHint(86400), "（目安：約 24 時間後）");
  });

  it("正の有限な数でなければ空文字", () => {
    for (const v of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "10", {}]) {
      assert.equal(retryAfterHint(v), "", String(v));
    }
  });
});

describe("interpretQuestionPostResponse：応答の解釈", () => {
  const base = { ok: false, status: 500, redirected: false, expired: false, body: null as unknown };

  it("通信エラー（null）は結果不明で、一覧を読み直す", () => {
    assert.deepEqual(interpretQuestionPostResponse(null), { kind: "error", message: QUESTION_UNKNOWN_RESULT_MESSAGE, reload: true });
  });

  it("2xx（リダイレクトなし）は成功。本文は見ない", () => {
    for (const body of [null, {}, { id: "c1" }, "x"]) {
      assert.deepEqual(interpretQuestionPostResponse({ ...base, ok: true, status: 201, body }), { kind: "success" });
    }
  });

  it("期限切れ（401・/login へのリダイレクト）はログインの期限切れで、読み直さない", () => {
    assert.deepEqual(interpretQuestionPostResponse({ ...base, status: 401, expired: true }), {
      kind: "error",
      message: COMMENT_SESSION_EXPIRED_MESSAGE,
      reload: false,
    });
    assert.deepEqual(interpretQuestionPostResponse({ ...base, ok: true, status: 200, redirected: true, expired: true }), {
      kind: "error",
      message: COMMENT_SESSION_EXPIRED_MESSAGE,
      reload: false,
    });
  });

  it("ログイン以外へのリダイレクトは結果不明", () => {
    assert.deepEqual(interpretQuestionPostResponse({ ...base, ok: true, status: 200, redirected: true }), {
      kind: "error",
      message: QUESTION_UNKNOWN_RESULT_MESSAGE,
      reload: true,
    });
  });

  it("502 / 503 / 504 は結果不明で読み直す。409 duplicate も読み直す", () => {
    for (const status of [502, 503, 504]) {
      const o = interpretQuestionPostResponse({ ...base, status });
      assert.deepEqual(o, { kind: "error", message: QUESTION_UNKNOWN_RESULT_MESSAGE, reload: true }, String(status));
    }
    assert.deepEqual(interpretQuestionPostResponse({ ...base, status: 409, body: { reason: "duplicate" } }), {
      kind: "error",
      message: QUESTION_DUPLICATE_MESSAGE,
      reload: true,
    });
  });

  it("reason・retryAfterSeconds を本文から読む。それ以外の失敗は読み直さない", () => {
    assert.deepEqual(interpretQuestionPostResponse({ ...base, status: 429, body: { reason: "rate_limited", retryAfterSeconds: 25 } }), {
      kind: "error",
      message: `${QUESTION_RATE_LIMITED_MESSAGE}（目安：約 25 秒後）`,
      reload: false,
    });
    assert.deepEqual(interpretQuestionPostResponse({ ...base, status: 403, body: { reason: "course_locked" } }), {
      kind: "error",
      message: QUESTION_COURSE_LOCKED_MESSAGE,
      reload: false,
    });
    for (const status of [400, 403, 404, 500]) {
      const o = interpretQuestionPostResponse({ ...base, status });
      assert.equal(o.kind, "error", String(status));
      assert.equal(o.kind === "error" && o.reload, false, `${status} で読み直している`);
    }
  });

  it("本文が JSON でない・配列のときはステータスだけで決める", () => {
    for (const body of [null, "x", ["duplicate"], 1]) {
      const o = interpretQuestionPostResponse({ ...base, status: 409, body });
      assert.deepEqual(o, { kind: "error", message: COMMENT_SERVER_ERROR_MESSAGE, reload: false }, JSON.stringify(body));
    }
  });
});

describe("questionPostBody・定数", () => {
  it("lessonId と content だけを送り、parentId は送らない。content は加工しない（検証はサーバー）", () => {
    const parsed = JSON.parse(questionPostBody("l1", "  質問です\n"));
    assert.deepEqual(parsed, { lessonId: "l1", content: "  質問です\n" });
    assert.ok(!("parentId" in parsed), "parentId を送っている");
  });

  it("URL と成功の文言", () => {
    assert.equal(QUESTION_POST_URL, "/api/comments");
    assert.equal(QUESTION_POSTED_MESSAGE, "質問を投稿しました。");
  });
});
