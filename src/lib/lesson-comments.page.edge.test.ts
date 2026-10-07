import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAuthFailure } from "./client-session";
import { commentsTabLabel, toCommentItems } from "./lesson-comments";

// #32 レッスン画面（page.tsx の LessonView、// @ts-nocheck）の補強（lesson-comments.page.test.ts の続き）。
// loadComments と、描画で使う式（commentRows・commentsFailed・commentsReady・commentsWaiting・commentsShowFailed・タブ名）をソースから取り出して実行する。
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
  const st = { comments: null as unknown, loading: true, failedLessonId: null as string | null, inFlight: null as unknown, urls: [] as string[], log: [] as string[] };
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
  const make = new Function("authFetch", "classifyAuthFailure", "commentsInFlight", "setComments", "setCommentsLoading", "setCommentsFailedLessonId", `${loadSrc}\nreturn loadComments;`);
  const load = make(
    authFetch,
    classifyAuthFailure,
    ref,
    (v: unknown) => {
      st.comments = v;
      const c = v as { lessonId: string; rows: Array<{ id: string }> } | null;
      st.log.push(`comments:${c ? `${c.lessonId}:${c.rows.map((x) => x.id).join(",")}` : String(c)}`);
    },
    (v: boolean) => (st.loading = v),
    (v: string | null) => (st.failedLessonId = v)
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
    assert.deepEqual(st.comments, { lessonId: "A", rows: [{ ...ROW, id: "a2" }] });
    assert.equal(st.loading, false);
    assert.equal(st.failedLessonId, null);
    assert.equal(st.inFlight, null);
  });

  it("A → B（B 失敗）→ 古い A の成功が届いても、失敗の表示のまま", async () => {
    const { st, load, reqs } = harness();
    load("A");
    load("B");
    reqs[1].release(failRes());
    await settle();
    assert.equal(st.failedLessonId, "B");
    reqs[0].release(okRes([ROW]));
    await settle();
    assert.equal(st.failedLessonId, "B");
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
    assert.deepEqual(st.comments, { lessonId: "B", rows: [ROW] });
    assert.equal(st.loading, false);
    assert.equal(st.inFlight, null);
  });

  it("A の例外が B に切り替えたあとに届いても、B を失敗にしない", async () => {
    const { st, load, reqs } = harness();
    load("A");
    load("B");
    reqs[0].fail(new TypeError("Failed to fetch"));
    await settle();
    assert.equal(st.failedLessonId, null);
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
    assert.deepEqual(st.comments, { lessonId: "B", rows: [] });
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
    assert.deepEqual(st.comments, { lessonId: "A", rows: [{ ...ROW, id: "new" }] });
  });

  it("空文字の id は id なしと同じ（取得しない）", () => {
    const { st, load } = harness();
    load("");
    assert.deepEqual(st.urls, []);
    assert.equal(st.loading, false);
    assert.equal(st.failedLessonId, null);
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
    assert.deepEqual(st.comments, { lessonId: "A", rows: [] });
  });

  it("切り替えた瞬間に前のレッスンの一覧を消す（setComments(null) を先に呼ぶ）", async () => {
    const { st, load, reqs } = harness();
    load("A");
    reqs[0].release(okRes([ROW]));
    await settle();
    load("B");
    assert.equal(st.comments, null);
    assert.equal(st.loading, true);
    assert.deepEqual(st.log, ["comments:null", "comments:A:c1", "comments:null"]);
  });
});

describe("描画で使う式（commentRows・commentsFailed・commentsReady・commentsWaiting・commentsShowFailed・タブ名）", () => {
  const exprs = ["commentRows", "commentsFailed", "commentsReady", "commentsWaiting", "commentsShowFailed"].map((name) => {
    const m = lessonView.match(new RegExp(`const ${name} = ([^;]+);`));
    assert.ok(m, `${name} がない`);
    return `const ${name} = ${m[1]};`;
  });
  type View = { rows: unknown; ready: boolean; waiting: boolean; showFailed: boolean; label: string; shown: string };
  type Input = { activeLesson: unknown; comments: unknown; loading: boolean; failedLessonId: string | null; allLessons?: unknown[] };
  const evalExprs = new Function(
    "activeLesson",
    "comments",
    "commentsLoading",
    "commentsFailedLessonId",
    "allLessons",
    `${exprs.join("\n")}\nreturn { rows: commentRows, ready: commentsReady, waiting: commentsWaiting, showFailed: commentsShowFailed };`
  ) as (a: unknown, c: unknown, l: boolean, f: string | null, all: unknown[]) => Omit<View, "label" | "shown">;
  /** 描画と同じ判定：タブ名と、質問タブに出るもの（読み込み中 / 失敗 / 空 / 一覧の id） */
  const view = ({ activeLesson, comments, loading, failedLessonId, allLessons }: Input): View => {
    const v = evalExprs(activeLesson, comments, loading, failedLessonId, allLessons ?? [activeLesson].filter(Boolean));
    const items = toCommentItems(v.rows, new Date());
    const label = commentsTabLabel(v.ready ? items.length : null);
    const shown = v.waiting ? "loading" : v.showFailed ? "failed" : items.length === 0 ? "empty" : items.map((x) => x.id).join(",");
    return { ...v, label, shown };
  };
  const A = { id: "A" };
  const B = { id: "B" };

  it("成功して今のレッスンの rows があるときだけ件数と一覧を出す", () => {
    let v = view({ activeLesson: A, comments: { lessonId: "A", rows: [ROW, { ...ROW, id: "c2" }] }, loading: false, failedLessonId: null });
    assert.equal(v.label, "質問 (2)");
    assert.equal(v.shown, "c1,c2");
    v = view({ activeLesson: A, comments: { lessonId: "A", rows: [] }, loading: false, failedLessonId: null });
    assert.equal(v.label, "質問 (0)");
    assert.equal(v.shown, "empty");
  });

  it("切り替え直後の最初の描画（comments は前のレッスン A のまま、読み込み中でも失敗でもない）：前のレッスンの一覧・件数を出さず、読み込み中", () => {
    const v = view({ activeLesson: B, comments: { lessonId: "A", rows: [ROW, { ...ROW, id: "c2" }] }, loading: false, failedLessonId: null });
    assert.equal(v.rows, null);
    assert.equal(v.ready, false);
    assert.equal(v.label, "質問");
    assert.equal(v.shown, "loading");
  });

  it("loadComments を実際に動かして、A の成功 → B に切り替えた直後（effect 前）→ B の読み込み中 → B の成功 で前の一覧を一度も出さない", async () => {
    const { st, load, reqs } = harness();
    const at = (activeLesson: unknown) => view({ activeLesson, comments: st.comments, loading: st.loading, failedLessonId: st.failedLessonId, allLessons: [A, B] });
    load("A");
    reqs[0].release(okRes([ROW]));
    await settle();
    assert.equal(at(A).shown, "c1");
    assert.equal(at(A).label, "質問 (1)");
    // activeLesson だけ B に変わり、effect（load("B")）はまだ
    assert.equal(at(B).shown, "loading");
    assert.equal(at(B).label, "質問");
    load("B");
    assert.equal(at(B).shown, "loading");
    assert.equal(at(B).label, "質問");
    reqs[1].release(okRes([{ ...ROW, id: "b1" }]));
    await settle();
    assert.equal(at(B).shown, "b1");
    assert.equal(at(B).label, "質問 (1)");
    // A に戻した直後も B の一覧は出さない
    assert.equal(at(A).shown, "loading");
    assert.equal(at(A).label, "質問");
  });

  it("切り替え直後の最初の描画（前のレッスン A が失敗のまま）：A の失敗を出さず読み込み中", () => {
    const v = view({ activeLesson: B, comments: null, loading: false, failedLessonId: "A" });
    assert.equal(v.showFailed, false);
    assert.equal(v.ready, false);
    assert.equal(v.label, "質問");
    assert.equal(v.shown, "loading");
  });

  it("loadComments を実際に動かして、A の失敗 → B に切り替えた直後（effect 前）→ B の読み込み中 → B の成功 で A の失敗を一度も出さない", async () => {
    const { st, load, reqs } = harness();
    const at = (activeLesson: unknown) => view({ activeLesson, comments: st.comments, loading: st.loading, failedLessonId: st.failedLessonId, allLessons: [A, B] });
    load("A");
    reqs[0].release(failRes());
    await settle();
    assert.equal(at(A).shown, "failed");
    // activeLesson だけ B に変わり、effect（load("B")）はまだ
    assert.equal(at(B).shown, "loading");
    assert.equal(at(B).label, "質問");
    load("B");
    assert.equal(at(B).shown, "loading");
    reqs[1].release(okRes([{ ...ROW, id: "b1" }]));
    await settle();
    assert.equal(at(B).shown, "b1");
    assert.equal(at(B).label, "質問 (1)");
  });

  it("A の失敗のあと B に切り替え、B 自身が失敗したら失敗を出す（例外でも同じ）", async () => {
    for (const settleB of ["fail", "throw"] as const) {
      const { st, load, reqs } = harness();
      const at = (activeLesson: unknown) => view({ activeLesson, comments: st.comments, loading: st.loading, failedLessonId: st.failedLessonId, allLessons: [A, B] });
      load("A");
      reqs[0].release(failRes());
      await settle();
      load("B");
      assert.equal(at(B).shown, "loading", settleB);
      if (settleB === "fail") reqs[1].release(failRes());
      else reqs[1].fail(new TypeError("Failed to fetch"));
      await settle();
      assert.equal(st.failedLessonId, "B", settleB);
      assert.equal(at(B).shown, "failed", settleB);
      assert.equal(at(B).label, "質問", settleB);
      // A に戻した直後（effect 前）は B の失敗を出さない
      assert.equal(at(A).shown, "loading", settleB);
    }
  });

  it("失敗のあとの再読み込みで失敗表示を解除し、読み込み中 → 成功で一覧を出す", async () => {
    const { st, load, reqs } = harness();
    const at = (activeLesson: unknown) => view({ activeLesson, comments: st.comments, loading: st.loading, failedLessonId: st.failedLessonId, allLessons: [A, B] });
    load("B");
    reqs[0].release(failRes());
    await settle();
    assert.equal(at(B).shown, "failed");
    load("B");
    assert.equal(st.failedLessonId, null);
    assert.equal(at(B).shown, "loading");
    reqs[1].release(okRes([]));
    await settle();
    assert.equal(at(B).shown, "empty");
    assert.equal(at(B).label, "質問 (0)");
  });

  it("lessonId が一致しない・形が違う comments は使わない", () => {
    for (const comments of [{ lessonId: "", rows: [ROW] }, { lessonId: undefined, rows: [ROW] }, { rows: [ROW] }, [ROW], { lessonId: "a", rows: [ROW] }]) {
      const v = view({ activeLesson: A, comments, loading: false, failedLessonId: null });
      assert.equal(v.label, "質問", JSON.stringify(comments));
      assert.equal(v.shown, "loading", JSON.stringify(comments));
    }
  });

  it("今のレッスンの読み込み中・失効（読み込み中のまま）は読み込み中、失敗は失敗", () => {
    assert.equal(view({ activeLesson: A, comments: null, loading: true, failedLessonId: null }).shown, "loading");
    assert.equal(view({ activeLesson: A, comments: null, loading: false, failedLessonId: "A" }).shown, "failed");
    assert.equal(view({ activeLesson: A, comments: null, loading: false, failedLessonId: "A" }).label, "質問");
  });

  it("activeLesson がない：コースにレッスンがある間（最初のレッスンを選ぶ前）は読み込み中、レッスン 0 件なら空の案内", () => {
    let v = view({ activeLesson: null, comments: null, loading: false, failedLessonId: null, allLessons: [A, B] });
    assert.equal(v.shown, "loading");
    assert.equal(v.label, "質問");
    // コースを切り替えた直後（前のコースの comments・失敗が残っていても）
    v = view({ activeLesson: null, comments: { lessonId: "A", rows: [ROW] }, loading: false, failedLessonId: "A", allLessons: [A] });
    assert.equal(v.shown, "loading");
    assert.equal(v.label, "質問");
    v = view({ activeLesson: null, comments: null, loading: false, failedLessonId: null, allLessons: [] });
    assert.equal(v.shown, "empty");
    assert.equal(v.label, "質問");
    v = view({ activeLesson: null, comments: { lessonId: "A", rows: [ROW] }, loading: false, failedLessonId: "A", allLessons: [] });
    assert.equal(v.shown, "empty");
  });

  it("id が空・ない activeLesson は、レッスンなしと同じ扱い（件数は出さない）", () => {
    assert.equal(view({ activeLesson: { id: "" }, comments: { lessonId: "", rows: [ROW] }, loading: false, failedLessonId: null }).label, "質問");
    assert.equal(view({ activeLesson: {}, comments: { lessonId: undefined, rows: [ROW] }, loading: false, failedLessonId: null }).label, "質問");
  });

  it("壊れた要素は件数に入れない", () => {
    assert.equal(view({ activeLesson: A, comments: { lessonId: "A", rows: [ROW, null, { id: 1 }, ROW] }, loading: false, failedLessonId: null }).label, "質問 (1)");
  });
});

describe("@ts-nocheck の取り違え防止", () => {
  it("質問タブまわりの state・値はすべて宣言後に使われている（使わない state を残していない）", () => {
    for (const name of ["comments", "setComments", "commentsLoading", "setCommentsLoading", "commentsFailedLessonId", "setCommentsFailedLessonId", "commentsFailed", "commentsInFlight", "commentRows", "commentItems", "commentsReady", "commentsWaiting", "commentsShowFailed", "lessonTypeText", "lessonDocUrl", "loadComments"]) {
      const n = (lessonView.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
      assert.ok(n >= 2, `${name} が使われていない（${n} 回）`);
    }
  });

  it("loadComments の中で使う名前は、引数・ローカル・注入した関数だけ（未定義の名前を参照しない）", () => {
    // new Function で注入した名前以外を参照すると ReferenceError になるので、harness の実行で確認済み。
    // ここでは JSX 側で質問タブの変数名の打ち間違い（comment / commentItem / commentLoading など）がないことを見る
    for (const typo of [/\bcommentItem\b/, /\bcommentLoading\b/, /\bcommentFailed\b/, /\bsetComment\b/, /\bsetCommentsFailed\b/, /\bcommentFailedLessonId\b/, /\bcommentsItems\b/, /\bcomentsReady\b/]) {
      assert.doesNotMatch(lessonView, typo);
    }
  });

  it("このファイルのソースに見えない文字を直接書いていない", () => {
    const text = readFileSync(__filename, "utf8");
    assert.doesNotMatch(text, new RegExp("[\\u0300-\\u036F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u3164\\u00A0]", "u"));
  });
});
