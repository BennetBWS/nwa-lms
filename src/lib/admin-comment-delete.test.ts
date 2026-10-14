import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DELETE_LOG_MESSAGE,
  MAX_REPLY_DEPTH,
  ReplyTreeCycleError,
  ReplyTreeTooDeepError,
  collectDescendantIds,
  findRootQuestionId,
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

describe("collectDescendantIds", () => {
  /** parentId の対応表から findChildIds を作る（呼ばれた引数も記録する） */
  function tree(parentOf: Record<string, string | null>) {
    const asked: string[][] = [];
    const find = async (parentIds: string[]) => {
      asked.push([...parentIds]);
      return Object.entries(parentOf)
        .filter(([, p]) => p !== null && parentIds.includes(p))
        .map(([id]) => id);
    };
    return { find, asked };
  }

  it("子がなければ空で、1 回だけ問い合わせる", async () => {
    const t = tree({ q: null });
    assert.deepEqual(await collectDescendantIds("q", t.find), []);
    assert.deepEqual(t.asked, [["q"]]);
  });

  it("子・孫・ひ孫を浅い順に集め、root 自身は含めない", async () => {
    const t = tree({ q: null, a: "q", b: "q", a1: "a", a1x: "a1", other: null, o1: "other" });
    assert.deepEqual(await collectDescendantIds("q", t.find), ["a", "b", "a1", "a1x"]);
    assert.deepEqual(t.asked, [["q"], ["a", "b"], ["a1"], ["a1x"]], "1 段ずつ parentId の in で問い合わせる");
  });

  it("返信を root にしても、その下だけを集める（親や兄弟は含めない）", async () => {
    const t = tree({ q: null, a: "q", b: "q", a1: "a" });
    assert.deepEqual(await collectDescendantIds("a", t.find), ["a1"]);
  });

  it("ちょうど上限の深さまでは集められる", async () => {
    const parentOf: Record<string, string | null> = { r0: null };
    for (let i = 1; i <= 3; i++) parentOf[`r${i}`] = `r${i - 1}`;
    assert.deepEqual(await collectDescendantIds("r0", tree(parentOf).find, 3), ["r1", "r2", "r3"]);
  });

  it("上限より 1 段深いと ReplyTreeTooDeepError", async () => {
    const parentOf: Record<string, string | null> = { r0: null };
    for (let i = 1; i <= 4; i++) parentOf[`r${i}`] = `r${i - 1}`;
    await assert.rejects(collectDescendantIds("r0", tree(parentOf).find, 3), (e: unknown) => {
      assert.ok(e instanceof ReplyTreeTooDeepError, "ReplyTreeTooDeepError を投げる");
      assert.equal((e as Error).name, "ReplyTreeTooDeepError");
      return true;
    });
  });

  it("既定の上限は MAX_REPLY_DEPTH（10 段）", async () => {
    assert.equal(MAX_REPLY_DEPTH, 10);
    const ok: Record<string, string | null> = { r0: null };
    for (let i = 1; i <= 10; i++) ok[`r${i}`] = `r${i - 1}`;
    assert.equal((await collectDescendantIds("r0", tree(ok).find)).length, 10);
    await assert.rejects(collectDescendantIds("r0", tree({ ...ok, r11: "r10" }).find), ReplyTreeTooDeepError);
  });

  it("parentId が循環していても止まり、同じ id を二度数えない", async () => {
    // a → b → c → a の循環が root の下にある（a の親は q と c の両方を返す偽物）
    const find = async (parentIds: string[]) => {
      const edges: Array<[string, string]> = [["a", "q"], ["b", "a"], ["c", "b"], ["a", "c"]];
      return edges.filter(([, p]) => parentIds.includes(p)).map(([id]) => id);
    };
    assert.deepEqual(await collectDescendantIds("q", find), ["a", "b", "c"]);
  });

  it("root 自身が子として返ってきても数えない（root を含む循環）", async () => {
    const find = async (parentIds: string[]) => (parentIds.includes("r") ? ["x"] : parentIds.includes("x") ? ["r"] : []);
    assert.deepEqual(await collectDescendantIds("r", find), ["x"]);
  });

  it("同じ段で重複して返ってきても 1 回だけ数える", async () => {
    const find = async (parentIds: string[]) => (parentIds.includes("q") ? ["a", "a", "b"] : []);
    assert.deepEqual(await collectDescendantIds("q", find), ["a", "b"]);
  });

  it("findChildIds の例外はそのまま伝える", async () => {
    const boom = new Error("boom");
    await assert.rejects(collectDescendantIds("q", async () => { throw boom; }), (e: unknown) => e === boom);
  });
});

describe("findRootQuestionId", () => {
  function reader(parentOf: Record<string, string | null>) {
    const asked: string[] = [];
    const read = async (id: string) => {
      asked.push(id);
      return id in parentOf ? { parentId: parentOf[id] } : null;
    };
    return { read, asked };
  }

  it("質問から始めればその id を返し、1 回だけ読む", async () => {
    const r = reader({ q: null });
    assert.equal(await findRootQuestionId("q", r.read), "q");
    assert.deepEqual(r.asked, ["q"]);
  });

  it("返信への返信から、根の質問までたどる", async () => {
    const r = reader({ q: null, a: "q", a1: "a", a2: "a1" });
    assert.equal(await findRootQuestionId("a2", r.read), "q");
    assert.deepEqual(r.asked, ["a2", "a1", "a", "q"]);
  });

  it("途中の行がなければ null", async () => {
    assert.equal(await findRootQuestionId("a1", reader({ a1: "a" }).read), null);
  });

  it("読む回数が上限ちょうどなら根を返し、上限を超えると ReplyTreeTooDeepError", async () => {
    const chain: Record<string, string | null> = { r0: null };
    for (let i = 1; i <= 3; i++) chain[`r${i}`] = `r${i - 1}`;
    assert.equal(await findRootQuestionId("r2", reader(chain).read, 3), "r0", "r2→r1→r0 の 3 回");
    await assert.rejects(findRootQuestionId("r3", reader(chain).read, 3), ReplyTreeTooDeepError);
  });

  it("既定の上限は MAX_REPLY_DEPTH 回", async () => {
    const chain: Record<string, string | null> = { r0: null };
    for (let i = 1; i <= 10; i++) chain[`r${i}`] = `r${i - 1}`;
    assert.equal(await findRootQuestionId("r9", reader(chain).read), "r0");
    await assert.rejects(findRootQuestionId("r10", reader(chain).read), ReplyTreeTooDeepError);
  });

  it("parentId が循環していたら ReplyTreeCycleError（読む回数は有限）", async () => {
    const r = reader({ a: "b", b: "c", c: "a" });
    await assert.rejects(findRootQuestionId("a", r.read), (e: unknown) => {
      assert.ok(e instanceof ReplyTreeCycleError, "ReplyTreeCycleError を投げる");
      assert.equal((e as Error).name, "ReplyTreeCycleError");
      return true;
    });
    assert.deepEqual(r.asked, ["a", "b", "c"]);
  });

  it("自己参照も ReplyTreeCycleError", async () => {
    await assert.rejects(findRootQuestionId("s", reader({ s: "s" }).read), ReplyTreeCycleError);
  });

  it("readParent の例外はそのまま伝える", async () => {
    const boom = new Error("boom");
    await assert.rejects(findRootQuestionId("q", async () => { throw boom; }), (e: unknown) => e === boom);
  });
});
