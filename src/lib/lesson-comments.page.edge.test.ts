import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAuthFailure } from "./client-session";
import { commentsTabLabel, toCommentItems } from "./lesson-comments";

// #32 レッスン画面（page.tsx の LessonView、// @ts-nocheck）の補強（lesson-comments.page.test.ts の続き）。
// loadComments と、描画で使う式（commentsReady・タブ名）をソースから取り出して実行する。
// レンダリング・DB・ネットワークなし。データはすべてダミー。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");
const start = src.indexOf("const LessonView = (");
const end = src.indexOf("\nconst AdminDashboard = (");
assert.ok(start >= 0 && end > start, "LessonView が見つからない");
const lessonView = src.slice(start, end);
const loadSrc = lessonView.slice(lessonView.indexOf("const loadComments"), lessonView.indexOf("useEffect(() => { loadComments("));

type FakeRes = { status: number; ok: boolean; redirected: boolean; url: string; json: () => Promise<unknown> };
const ORIGIN = "https://nwa-lms.example.com";
const ROW = { id: "c1", content: "ダミー", createdAt: "2026-10-06T12:00:00.000Z", author: { name: "ダミー", isInstructor: false }, mine: false, replies: [] };
const okRes = (body: unknown): FakeRes => ({ status: 200, ok: true, redirected: false, url: `${ORIGIN}/api/comments/x`, json: () => Promise.resolve(body) });
const expiredRes = (): FakeRes => ({ status: 200, ok: true, redirected: true, url: `${ORIGIN}/login?callbackUrl=%2F`, json: () => Promise.resolve(null) });
const failRes = (): FakeRes => ({ status: 500, ok: false, redirected: false, url: `${ORIGIN}/api/comments/x`, json: () => Promise.resolve({}) });
const settle = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let release!: (r: FakeRes) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<FakeRes>((r, j) => {
    release = r;
    fail = j;
  });
  return { promise, release, fail };
}

/** loadComments を偽の state・ref・authFetch で動かす。各リクエストは手で解決する */
function harness() {
  const st = { comments: null as unknown, loading: true, failed: false, inFlight: null as unknown, urls: [] as string[], log: [] as string[] };
  const reqs: Array<ReturnType<typeof deferred>> = [];
  const ref = {
    get current() {
      return st.inFlight;
    },
    set current(v: unknown) {
      st.inFlight = v;
    },
  };
  const authFetch = (url: string) => {
    st.urls.push(url);
    const d = deferred();
    reqs.push(d);
    return d.promise;
  };
  const make = new Function("authFetch", "classifyAuthFailure", "commentsInFlight", "setComments", "setCommentsLoading", "setCommentsFailed", `${loadSrc}\nreturn loadComments;`);
  const load = make(
    authFetch,
    classifyAuthFailure,
    ref,
    (v: unknown) => {
      st.comments = v;
      st.log.push(`comments:${Array.isArray(v) ? v.map((x: { id: string }) => x.id).join(",") : String(v)}`);
    },
    (v: boolean) => (st.loading = v),
    (v: boolean) => (st.failed = v)
  ) as (lessonId?: string) => void;
  return { st, load, reqs };
}

describe("loadComments：切り替えの組み合わせ", () => {
  it("A → B → A：B と最初の A の応答はどちらも捨て、最後の A だけを表示する（届く順が逆でも）", async () => {
    const { st, load, reqs } = harness();
    load("A");
    load("B");
    load("A");
    assert.deepEqual(st.urls, ["/api/comments/A", "/api/comments/B", "/api/comments/A"]);
    reqs[2].release(okRes([{ ...ROW, id: "a2" }]));
    await settle();
    reqs[1].release(okRes([{ ...ROW, id: "b" }]));
    reqs[0].release(okRes([{ ...ROW, id: "a1" }]));
    await settle();
    assert.deepEqual(st.comments, [{ ...ROW, id: "a2" }]);
    assert.equal(st.loading, false);
    assert.equal(st.failed, false);
    assert.equal(st.inFlight, null);
  });

  it("A → B（B 失敗）→ 古い A の成功が届いても、失敗の表示のまま", async () => {
    const { st, load, reqs } = harness();
    load("A");
    load("B");
    reqs[1].release(failRes());
    await settle();
    assert.equal(st.failed, true);
    reqs[0].release(okRes([ROW]));
    await settle();
    assert.equal(st.failed, true);
    assert.equal(st.comments, null);
    assert.equal(st.loading, false);
  });

  it("A の失効（リダイレクト）が B に切り替えたあとに届いても、B の読み込みを止めない", async () => {
    const { st, load, reqs } = harness();
    load("A");
    load("B");
    reqs[0].release(expiredRes());
    await settle();
    assert.equal(st.loading, true);
    reqs[1].release(okRes([ROW]));
    await settle();
    assert.deepEqual(st.comments, [ROW]);
    assert.equal(st.loading, false);
    assert.equal(st.inFlight, null);
  });

  it("A の例外が B に切り替えたあとに届いても、B を失敗にしない", async () => {
    const { st, load, reqs } = harness();
    load("A");
    load("B");
    reqs[0].fail(new TypeError("Failed to fetch"));
    await settle();
    assert.equal(st.failed, false);
    assert.equal(st.loading, true);
  });

  it("A が失効したあと（読み込み中のまま）でも、B に切り替えれば取得し、A に戻ればまた取得する", async () => {
    const { st, load, reqs } = harness();
    load("A");
    reqs[0].release(expiredRes());
    await settle();
    load("B");
    assert.equal(st.urls.length, 2);
    reqs[1].release(okRes([]));
    await settle();
    assert.deepEqual(st.comments, []);
    load("A");
    assert.equal(st.urls.length, 3);
  });

  it("A → id なし → A：最初の A の応答は捨て、2 回目の A を使う", async () => {
    const { st, load, reqs } = harness();
    load("A");
    load(undefined);
    load("A");
    assert.equal(st.urls.length, 2);
    reqs[0].release(okRes([{ ...ROW, id: "old" }]));
    await settle();
    assert.equal(st.loading, true);
    reqs[1].release(okRes([{ ...ROW, id: "new" }]));
    await settle();
    assert.deepEqual(st.comments, [{ ...ROW, id: "new" }]);
  });

  it("空文字の id は id なしと同じ（取得しない）", () => {
    const { st, load } = harness();
    load("");
    assert.deepEqual(st.urls, []);
    assert.equal(st.loading, false);
    assert.equal(st.failed, false);
  });

  it("成功のあとに同じレッスンをもう一度読むと取得し直し、その間は前の一覧を消す", async () => {
    const { st, load, reqs } = harness();
    load("A");
    reqs[0].release(okRes([ROW]));
    await settle();
    load("A");
    assert.equal(st.urls.length, 2);
    assert.equal(st.comments, null);
    assert.equal(st.loading, true);
    reqs[1].release(okRes([]));
    await settle();
    assert.deepEqual(st.comments, []);
  });

  it("切り替えた瞬間に前のレッスンの一覧を消す（setComments(null) を先に呼ぶ）", async () => {
    const { st, load, reqs } = harness();
    load("A");
    reqs[0].release(okRes([ROW]));
    await settle();
    load("B");
    assert.equal(st.comments, null);
    assert.equal(st.loading, true);
    assert.deepEqual(st.log, ["comments:null", "comments:c1", "comments:null"]);
  });
});

describe("描画で使う式（commentsReady・タブ名）", () => {
  const readyLine = lessonView.match(/const commentsReady = ([^;]+);/);
  assert.ok(readyLine, "commentsReady がない");
  const ready = new Function("activeLesson", "commentsLoading", "commentsFailed", "comments", `return ${readyLine[1]};`) as (
    activeLesson: unknown,
    loading: boolean,
    failed: boolean,
    comments: unknown
  ) => boolean;
  const label = (activeLesson: unknown, loading: boolean, failed: boolean, comments: unknown) =>
    commentsTabLabel(ready(activeLesson, loading, failed, comments) ? toCommentItems(comments, new Date()).length : null);

  it("成功して配列があるときだけ件数を出す", () => {
    assert.equal(label({ id: "A" }, false, false, [ROW, { ...ROW, id: "c2" }]), "質問 (2)");
    assert.equal(label({ id: "A" }, false, false, []), "質問 (0)");
  });

  it("読み込み中・失敗・未取得・レッスンなし・id なしは「質問」", () => {
    assert.equal(label({ id: "A" }, true, false, null), "質問");
    assert.equal(label({ id: "A" }, false, true, null), "質問");
    assert.equal(label({ id: "A" }, false, false, null), "質問");
    assert.equal(label(null, false, false, null), "質問");
    assert.equal(label({ id: "" }, false, false, []), "質問");
    assert.equal(label({}, false, false, []), "質問");
  });

  it("壊れた要素は件数に入れない", () => {
    assert.equal(label({ id: "A" }, false, false, [ROW, null, { id: 1 }, ROW]), "質問 (1)");
  });
});

describe("@ts-nocheck の取り違え防止", () => {
  it("質問タブまわりの state・値はすべて宣言後に使われている（使わない state を残していない）", () => {
    for (const name of ["comments", "setComments", "commentsLoading", "setCommentsLoading", "commentsFailed", "setCommentsFailed", "commentsInFlight", "commentItems", "commentsReady", "lessonTypeText", "lessonDocUrl", "loadComments"]) {
      const n = (lessonView.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
      assert.ok(n >= 2, `${name} が使われていない（${n} 回）`);
    }
  });

  it("loadComments の中で使う名前は、引数・ローカル・注入した関数だけ（未定義の名前を参照しない）", () => {
    // new Function で注入した名前以外を参照すると ReferenceError になるので、harness の実行で確認済み。
    // ここでは JSX 側で質問タブの変数名の打ち間違い（comment / commentItem / commentLoading など）がないことを見る
    for (const typo of [/\bcommentItem\b/, /\bcommentLoading\b/, /\bcommentFailed\b/, /\bsetComment\b/, /\bcommentsItems\b/, /\bcomentsReady\b/]) {
      assert.doesNotMatch(lessonView, typo);
    }
  });

  it("このファイルのソースに見えない文字を直接書いていない", () => {
    const text = readFileSync(__filename, "utf8");
    assert.doesNotMatch(text, new RegExp("[\\u0300-\\u036F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u3164\\u00A0]", "u"));
  });
});
