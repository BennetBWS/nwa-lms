import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DELETE_LOG_MESSAGE,
  deletedCommentKind,
  questionDeletedResponse,
  replyDeletedResponse,
} from "./admin-comment-delete";
import type { QuestionThreadView } from "./question-threads";

// #47 P1 講師の削除 API の純粋関数。DB・ネットワーク・DOM なし。データはすべてダミー。

describe("deletedCommentKind", () => {
  it("parentId が null なら質問", () => {
    assert.equal(deletedCommentKind({ parentId: null }), "question");
  });

  it("parentId があれば返信", () => {
    assert.equal(deletedCommentKind({ parentId: "q_1" }), "reply");
  });

  it("parentId が空文字でも返信として扱う（null だけを質問とする）", () => {
    assert.equal(deletedCommentKind({ parentId: "" }), "reply");
  });
});

describe("questionDeletedResponse / replyDeletedResponse", () => {
  it("質問の応答は kind・id・deletedReplies だけ", () => {
    assert.deepEqual(questionDeletedResponse("q_1", 3), { kind: "question", id: "q_1", deletedReplies: 3 });
  });

  it("返信の応答は kind・id・thread だけ", () => {
    const thread = {
      id: "q_1",
      content: "ダミーの質問",
      createdAt: "2026-10-14T00:00:00.000Z",
      author: { name: "受講生エー", isInstructor: false },
      mine: false,
      replies: [],
      lesson: { id: "lesson_1", title: "ダミーレッスン" },
      course: { id: "course_1", name: "ダミーコース" },
      replyCount: 0,
      lastReplyAt: null,
      answered: false,
    } as unknown as QuestionThreadView;
    const res = replyDeletedResponse("r_1", thread);
    assert.deepEqual(Object.keys(res).sort(), ["id", "kind", "thread"]);
    assert.equal(res.kind, "reply");
    assert.equal(res.id, "r_1");
    assert.ok("thread" in res && res.thread === thread, "thread をそのまま返す");
  });
});

describe("DELETE_LOG_MESSAGE", () => {
  it("固定文で、id や本文を埋め込む余地がない", () => {
    assert.deepEqual(DELETE_LOG_MESSAGE, { question: "[admin] question deleted", reply: "[admin] reply deleted" });
  });
});
