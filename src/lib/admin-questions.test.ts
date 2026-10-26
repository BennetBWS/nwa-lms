import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_QUESTION_TABS,
  DEFAULT_ADMIN_QUESTION_TAB,
  adminReplyUrl,
  adminThreadListUrl,
  adminThreadsEmptyMessage,
  adminThreadsMoreHint,
  interpretReplyResponse,
  replaceThreadRow,
  toCourseOptions,
} from "./admin-questions";
import { parseThreadListQuery } from "./question-threads";
import { COMMENT_SESSION_EXPIRED_MESSAGE, COMMENT_UNKNOWN_RESULT_MESSAGE, commentSubmitErrorMessage } from "./comment-form";

describe("タブ", () => {
  it("未回答（既定）／回答済み／すべての順", () => {
    assert.deepEqual(
      ADMIN_QUESTION_TABS.map((t) => [t.key, t.label]),
      [
        ["unanswered", "未回答"],
        ["answered", "回答済み"],
        ["all", "すべて"],
      ]
    );
    assert.equal(DEFAULT_ADMIN_QUESTION_TAB, "unanswered");
  });
});

describe("adminThreadListUrl", () => {
  it("タブ・コース・カーソルを付ける", () => {
    assert.equal(adminThreadListUrl("all", null, null), "/api/comments");
    assert.equal(adminThreadListUrl("unanswered", null, null), "/api/comments?status=unanswered");
    assert.equal(adminThreadListUrl("answered", "c1", null), "/api/comments?status=answered&courseId=c1");
    assert.equal(adminThreadListUrl("all", "c1", "123.t1"), "/api/comments?courseId=c1&cursor=123.t1");
  });

  it("courseId はエンコードする（& や / を含んでも別のパラメータにならない）", () => {
    const url = adminThreadListUrl("unanswered", "a&mine=1/b", null);
    const params = new URL(url, "https://example.com").searchParams;
    assert.equal(params.get("courseId"), "a&mine=1/b");
    assert.equal(params.get("mine"), null);
  });

  it("作った URL は GET /api/comments の検証を通り、mine は付けない", () => {
    for (const t of ADMIN_QUESTION_TABS) {
      const url = adminThreadListUrl(t.key, "course_1", "1700000000000.t1");
      const parsed = parseThreadListQuery(new URL(url, "https://example.com").searchParams);
      assert.ok(parsed.ok, `検証で拒否された：${url}`);
      if (parsed.ok) {
        assert.equal(parsed.value.status, t.key);
        assert.equal(parsed.value.mine, false);
        assert.equal(parsed.value.courseId, "course_1");
      }
    }
  });
});

describe("adminReplyUrl", () => {
  it("id を URL エンコードする", () => {
    assert.equal(adminReplyUrl("t1"), "/api/admin/comments/t1/replies");
    assert.equal(adminReplyUrl("a/b?c"), "/api/admin/comments/a%2Fb%3Fc/replies");
  });
});

describe("文言", () => {
  it("空の文言（コースで絞っているときは「このコースに」）", () => {
    assert.equal(adminThreadsEmptyMessage("unanswered", false), "未回答の質問はありません");
    assert.equal(adminThreadsEmptyMessage("answered", false), "回答済みの質問はありません");
    assert.equal(adminThreadsEmptyMessage("all", false), "質問はありません");
    assert.equal(adminThreadsEmptyMessage("unanswered", true), "このコースに未回答の質問はありません");
    assert.equal(adminThreadsEmptyMessage("all", true), "このコースに質問はありません");
  });

  it("0 件で続きがあるときの説明", () => {
    assert.equal(adminThreadsMoreHint("unanswered"), "ここまでに未回答の質問はありません。古い質問を続けて確認できます");
    assert.equal(adminThreadsMoreHint("answered"), "ここまでに回答済みの質問はありません。古い質問を続けて確認できます");
    assert.equal(adminThreadsMoreHint("all"), "ここまでに質問はありません。古い質問を続けて確認できます");
  });
});

describe("toCourseOptions", () => {
  it("配列でなければ null", () => {
    for (const v of [null, undefined, {}, "x", { error: "Forbidden" }]) assert.equal(toCourseOptions(v), null, String(v));
  });

  it("id・name だけを順序のまま。壊れた要素・空・重複を除く", () => {
    const out = toCourseOptions([
      { id: "c1", name: "STEP1 ダミー", description: "x", _count: { sections: 2 } },
      { id: "c1", name: "重複" },
      { id: "", name: "空の id" },
      { id: "c3", name: "" },
      { id: 4, name: "数値の id" },
      null,
      "c5",
      { id: "c2", name: "STEP2 ダミー" },
    ]);
    assert.deepEqual(out, [
      { id: "c1", name: "STEP1 ダミー" },
      { id: "c2", name: "STEP2 ダミー" },
    ]);
  });
});

describe("interpretReplyResponse", () => {
  const thread = { id: "t1", content: "質問", answered: true, replies: [] };

  it("201 で同じ質問の thread なら成功", () => {
    const out = interpretReplyResponse({ ok: true, status: 201, redirected: false, body: { thread }, threadId: "t1" });
    assert.deepEqual(out, { kind: "success", thread });
  });

  it("2xx でも thread が読めない・別の質問なら、再送ではなく再読み込みを案内する", () => {
    for (const body of [null, {}, { thread: null }, { thread: { id: "t2", content: "x" } }, { thread: { id: "t1" } }, [thread]]) {
      const out = interpretReplyResponse({ ok: true, status: 201, redirected: false, body, threadId: "t1" });
      assert.deepEqual(out, { kind: "error", message: COMMENT_UNKNOWN_RESULT_MESSAGE }, JSON.stringify(body));
    }
  });

  it("リダイレクト（ログイン画面を 200 で受けた）は期限切れ", () => {
    const out = interpretReplyResponse({ ok: true, status: 200, redirected: true, body: null, threadId: "t1" });
    assert.deepEqual(out, { kind: "error", message: COMMENT_SESSION_EXPIRED_MESSAGE });
  });

  it("失敗は status と reason から comment-form の文言", () => {
    for (const [status, body] of [
      [400, { reason: "too_long" }],
      [400, { reason: "invalid_characters" }],
      [400, { reason: "not_a_question" }],
      [400, null],
      [401, null],
      [403, { error: "Forbidden" }],
      [404, { error: "Question not found" }],
      [500, null],
      [502, null],
      [504, { error: "Gateway Timeout" }],
    ] as Array<[number, unknown]>) {
      const out = interpretReplyResponse({ ok: false, status, redirected: false, body, threadId: "t1" });
      const reason = body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
      assert.deepEqual(out, { kind: "error", message: commentSubmitErrorMessage({ httpStatus: status, reason, redirected: false }) }, String(status));
    }
  });
});

describe("replaceThreadRow", () => {
  it("同じ id の行をその位置で置き換える（他の行・壊れた行はそのまま）", () => {
    const rows: unknown[] = [{ id: "t0" }, null, { id: "t1", answered: false }, { id: "t2" }];
    const next = { id: "t1", answered: true };
    const out = replaceThreadRow(rows, next);
    assert.deepEqual(out, [{ id: "t0" }, null, next, { id: "t2" }]);
    assert.notEqual(out, rows, "新しい配列を返していない");
    assert.deepEqual(rows[2], { id: "t1", answered: false }, "元の配列を書き換えている");
  });

  it("該当がなければ同じ配列を返す", () => {
    const rows: unknown[] = [{ id: "t0" }];
    assert.equal(replaceThreadRow(rows, { id: "zz" }), rows);
  });
});
