import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAuthFailure } from "./client-session";

// #32 レッスン画面：page.tsx（// @ts-nocheck）の LessonView を検査する。
// 1) ソースの文字列検査：見本データ・投稿欄が残っていないこと、配線・文言
// 2) loadComments の本文をソースから取り出し、偽の useState / useRef / authFetch と
//    本物の classifyAuthFailure で動かして状態遷移を確かめる（notifications.page.edge.test.ts と同じ方式）
// レンダリング・DB・ネットワークなし。データはすべてダミー。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const lessonView = component("LessonView");
const loadSrc = lessonView.slice(lessonView.indexOf("const loadComments"), lessonView.indexOf("useEffect(() => { loadComments("));
const commentsTab = lessonView.slice(lessonView.indexOf('<TabsContent value="comments"'), lessonView.indexOf("</Tabs>"));
const resourcesTab = lessonView.slice(lessonView.indexOf('<TabsContent value="resources"'), lessonView.indexOf('<TabsContent value="comments"'));
const contentTab = lessonView.slice(lessonView.indexOf('<TabsContent value="content"'), lessonView.indexOf('<TabsContent value="resources"'));

// ───────────── ソース検査 ─────────────

describe("LessonView：見本データ・投稿欄を残さない", () => {
  const banned: Array<[string, RegExp]> = [
    ["見本の投稿者（佐藤 太郎）", /佐藤 太郎/],
    ["見本の頭文字（佐）", />佐</],
    ["見本の質問文", /ブレイクポイントを768px/],
    ["見本の時刻（3h ago）", /3h ago/],
    ["固定のタブ名（質問 (3)）", /質問 \(3\)/],
    ["見本の教材（レスポンシブ実装ガイド.pdf）", /レスポンシブ実装ガイド\.pdf/],
    ["見本の教材（サンプルコード.zip）", /サンプルコード\.zip/],
    ["Download ボタン", /Download/],
    ["投稿欄の placeholder（Write a question）", /Write a question/],
    ["投稿欄の input", /<input\b/],
    ["投稿欄の textarea", /<textarea\b/i],
    ["Input コンポーネント", /<Input\b/],
    ["送信ボタン（Send アイコン）", /<Send\b/],
    ["固定の頭文字 T", />T<\/AvatarFallback>/],
    ['type の既定値（|| "TEXT"）', /\|\| "TEXT"/],
    ["教材リンクに content をそのまま渡す", /href=\{activeLesson\.content\}/],
  ];
  for (const [label, re] of banned) {
    it(`${label} がない`, () => {
      assert.doesNotMatch(lessonView, re);
    });
  }

  it("質問を投稿する API（POST /api/comments）を画面から呼ばない", () => {
    assert.doesNotMatch(src, /authFetch\(\s*["'`]\/api\/comments["'`]/);
    assert.doesNotMatch(lessonView, /method: "POST"[^)]*comments/);
  });
});

describe("LessonView：配線", () => {
  it("lesson-comments から必要な関数を import する", () => {
    const m = src.match(/import \{([^}]*)\} from "@\/lib\/lesson-comments";/);
    assert.ok(m, "import がない");
    const names = m[1].split(",").map((s) => s.trim());
    for (const n of ["commentsTabLabel", "lessonTypeLabel", "safeExternalUrl", "toCommentItems"]) assert.ok(names.includes(n), n);
  });

  it("lucide-react から使わなくなった Send を import しない（User は使うので残す）", () => {
    const m = src.match(/import \{([^}]*)\} from "lucide-react";/);
    assert.ok(m, "lucide-react の import がない");
    const names = m[1].split(",").map((s) => s.trim());
    assert.ok(!names.includes("Send"), "Send が残っている");
    assert.ok(names.includes("User"), "User がない");
    assert.doesNotMatch(src, /\bSend\b/);
  });

  it("state は comments(null) / commentsLoading(true) / commentsFailedLessonId(null)、ref は null", () => {
    assert.match(lessonView, /const \[comments, setComments\] = useState\(null\);/);
    assert.match(lessonView, /const \[commentsLoading, setCommentsLoading\] = useState\(true\);/);
    assert.match(lessonView, /const \[commentsFailedLessonId, setCommentsFailedLessonId\] = useState\(null\);/);
    assert.match(lessonView, /const commentsInFlight = useRef\(null\);/);
  });

  it("activeLesson.id が変わったときに読み込む", () => {
    assert.match(lessonView, /useEffect\(\(\) => \{ loadComments\(activeLesson\?\.id\); \}, \[activeLesson\?\.id\]\);/);
  });

  it("/api/comments/<lessonId> を authFetch で読み、失効は classifyAuthFailure で判定する", () => {
    assert.match(loadSrc, /authFetch\(`\/api\/comments\/\$\{encodeURIComponent\(lessonId\)\}`\)/);
    assert.match(loadSrc, /classifyAuthFailure\(\{ status: res\.status, redirected: res\.redirected, url: res\.url \}\) === "expired"/);
    assert.match(loadSrc, /if \(!res\.ok \|\| res\.redirected\) return null;/);
  });

  it("タブ名は commentsTabLabel（件数は読み込みが終わって成功したときだけ）", () => {
    assert.match(lessonView, /l: commentsTabLabel\(commentsReady \? commentItems\.length : null\)/);
    assert.match(lessonView, /const commentRows = comments && activeLesson\?\.id && comments\.lessonId === activeLesson\.id \? comments\.rows : null;/);
    assert.match(lessonView, /const commentsReady = !!activeLesson\?\.id && !commentsLoading && !commentsFailed && Array\.isArray\(commentRows\);/);
    assert.match(lessonView, /const commentItems = toCommentItems\(commentRows, new Date\(\)\);/);
  });

  it("失敗は今のレッスンについてだけ見る（失敗したレッスンの id を持ち、今の activeLesson.id と比べる）", () => {
    assert.match(lessonView, /const commentsFailed = !!activeLesson\?\.id && commentsFailedLessonId === activeLesson\.id;/);
    assert.doesNotMatch(lessonView, /\bsetCommentsFailed\(/);
    assert.equal((loadSrc.match(/setCommentsFailedLessonId\(lessonId\)/g) ?? []).length, 2);
    assert.equal((loadSrc.match(/setCommentsFailedLessonId\(null\)/g) ?? []).length, 2);
  });

  it("成功した応答は { lessonId, rows } の形で setComments する", () => {
    assert.match(loadSrc, /if \(Array\.isArray\(data\)\) setComments\(\{ lessonId, rows: data \}\);/);
  });
});

describe("LessonView：質問タブの表示", () => {
  it("読み込み中 → 失敗 → 0 件 → 一覧 の順に判定する（読み込み中・失敗は今のレッスンについての値で見る）", () => {
    const iLoading = commentsTab.indexOf("{commentsWaiting ? (");
    const iFailed = commentsTab.indexOf(") : commentsShowFailed ? (");
    const iEmpty = commentsTab.indexOf(") : commentItems.length === 0 ? (");
    const iList = commentsTab.indexOf("commentItems.map(c =>");
    assert.ok(iLoading >= 0 && iLoading < iFailed && iFailed < iEmpty && iEmpty < iList);
  });

  it("失敗は role=alert・文言・再読み込みボタン", () => {
    assert.match(commentsTab, /role="alert"/);
    assert.ok(commentsTab.includes("質問を読み込めませんでした"));
    assert.match(commentsTab, /onClick=\{\(\) => loadComments\(activeLesson\?\.id\)\} disabled=\{commentsLoading\}/);
    assert.ok(commentsTab.includes("再読み込み"));
  });

  it("0 件は「まだ質問はありません」", () => {
    assert.ok(commentsTab.includes("まだ質問はありません"));
  });

  it("名前・頭文字（なければ User アイコン）・講師バッジ・相対時刻・本文", () => {
    assert.ok(commentsTab.includes("{x.name}"));
    assert.ok(commentsTab.includes("{x.initial ?? <User "));
    assert.match(commentsTab, /\{x\.isInstructor && <Badge[^>]*>講師<\/Badge>\}/);
    assert.ok(commentsTab.includes("{x.time}"));
    assert.ok(commentsTab.includes("{x.content}"));
  });

  it("本文は改行を残し（pre-wrap）、長い語で崩れない（overflowWrap: anywhere）", () => {
    assert.match(commentsTab, /whiteSpace: "pre-wrap", overflowWrap: "anywhere" \}\}>\{x\.content\}/);
  });

  it("返信は親の下に字下げして表示し、key は id", () => {
    assert.ok(commentsTab.includes("[c, ...c.replies].map((x, xi) =>"));
    assert.match(commentsTab, /marginLeft: xi === 0 \? 0 : 46/);
    assert.ok(commentsTab.includes("key={c.id}"));
    assert.ok(commentsTab.includes("key={x.id}"));
  });

  it("メールアドレス・avatar・userId を画面で読まない", () => {
    for (const k of ["email", "avatar", "userId", ".author."]) assert.ok(!commentsTab.includes(k), k);
  });
});

describe("LessonView：教材タブ・概要タブ", () => {
  it("教材タブは「教材は準備中です」だけ", () => {
    assert.ok(resourcesTab.includes("教材は準備中です"));
    assert.doesNotMatch(resourcesTab, /\.map\(|<Button|<a /);
  });

  it("種類のバッジは lessonTypeLabel、未知の値なら出さない", () => {
    assert.match(lessonView, /const lessonTypeText = lessonTypeLabel\(activeLesson\?\.type\);/);
    assert.match(contentTab, /\{lessonTypeText && <Badge[^>]*>.*\{lessonTypeText\}<\/Badge>\}/);
  });

  it("教材リンクは safeExternalUrl の結果があるときだけ", () => {
    assert.match(lessonView, /const lessonDocUrl = safeExternalUrl\(activeLesson\?\.content\);/);
    assert.match(contentTab, /\{lessonDocUrl && \(\s*<a href=\{lessonDocUrl\} target="_blank" rel="noopener noreferrer"/);
  });

  it("説明文の「上のリンク」は、TEXT でリンクを出すとき（lessonDocUrl があるとき）だけ", () => {
    const m = contentTab.match(/<p [^>]*>\s*\{([^{}]*"テキストレッスンです。上のリンクから[^{}]*)\}\s*<\/p>/);
    assert.ok(m, "説明文の式が見つからない");
    assert.equal((contentTab.match(/上のリンク/g) ?? []).length, 1);
    const text = new Function("activeLesson", "lessonDocUrl", `return ${m[1]};`) as (activeLesson: unknown, lessonDocUrl: string | null) => string;
    const linked = "テキストレッスンです。上のリンクからGoogle Docsを開いて学習してください。";
    const plain = "レッスン内容をご確認ください。";
    assert.equal(text({ type: "TEXT" }, "https://docs.example.com/d/1"), linked);
    // http / https 以外・空などで safeExternalUrl が null を返し、リンクを出さないとき
    assert.equal(text({ type: "TEXT" }, null), plain);
    assert.equal(text({ type: "TEXT" }, ""), plain);
    assert.equal(text({ type: "VIDEO" }, "https://docs.example.com/d/1"), plain);
    assert.equal(text({ type: "VIDEO" }, null), plain);
    assert.equal(text(null, null), plain);
  });

  it("ヒーローの再生ボタンは変えていない", () => {
    assert.ok(lessonView.includes('{activeLesson?.type === "TEXT" ? <FileText size={32} style={{ color: "white" }} /> : <Play size={34} fill="white" style={{ color: "white", marginLeft: 4 }} />}'));
  });
});

describe("LessonView：使っている識別子はすべて page.tsx で import か定義がある", () => {
  it("JSX のコンポーネントと関数", () => {
    const defined = new Set<string>();
    for (const m of Array.from(src.matchAll(/^import\s+([\s\S]*?)\s+from\s+"[^"]+";/gm))) {
      const def = m[1].match(/^(\w+)/);
      if (def) defined.add(def[1]);
      const braces = m[1].match(/\{([\s\S]*?)\}/);
      if (braces) for (const part of braces[1].split(",")) {
        const n = part.trim().split(/\s+as\s+/).pop();
        if (n) defined.add(n);
      }
    }
    for (const m of Array.from(src.matchAll(/^(?:export\s+)?(?:const|let|var|function)\s+(\w+)/gm))) defined.add(m[1]);
    // LessonView の中のローカル定数（サイドバーの const Icon = ... など）
    for (const m of Array.from(lessonView.matchAll(/\bconst (\w+) = /g))) defined.add(m[1]);
    for (const n of ["authFetch", "classifyAuthFailure", "toCommentItems", "commentsTabLabel", "lessonTypeLabel", "safeExternalUrl", "glassStyle", "T", "User", "Badge", "Avatar", "AvatarFallback", "Button"]) {
      assert.ok(defined.has(n), `${n} が未定義`);
    }
    const used = Array.from(new Set(Array.from(lessonView.matchAll(/<([A-Z]\w*)[\s/>]/g), (m) => m[1])));
    assert.deepEqual(used.filter((n) => !defined.has(n)), []);
  });
});

// ───────────── loadComments の実行 ─────────────

type FakeRes = { status: number; ok: boolean; redirected: boolean; url: string; json: () => Promise<unknown> };
type State = { comments: unknown; loading: boolean; failedLessonId: string | null; inFlight: unknown; urls: string[]; jsonReads: number };

/** loadComments を実際に動かすハーネス。respond は URL ごとの応答（例外を返すなら reject） */
function harness(respond: (url: string) => Promise<FakeRes>) {
  const st: State = { comments: null, loading: true, failedLessonId: null, inFlight: null, urls: [], jsonReads: 0 };
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
    return respond(url).then((r) => ({
      ...r,
      json: () => {
        st.jsonReads++;
        return r.json();
      },
    }));
  };
  const make = new Function(
    "authFetch",
    "classifyAuthFailure",
    "commentsInFlight",
    "setComments",
    "setCommentsLoading",
    "setCommentsFailedLessonId",
    `${loadSrc}\nreturn loadComments;`
  );
  const load = make(
    authFetch,
    classifyAuthFailure,
    ref,
    (v: unknown) => (st.comments = v),
    (v: boolean) => (st.loading = v),
    (v: string | null) => (st.failedLessonId = v)
  ) as (lessonId?: string) => void;
  return { st, load };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const ORIGIN = "https://nwa-lms.example.com";
const ROW = { id: "c1", content: "ダミーの質問", createdAt: "2026-10-06T12:00:00.000Z", author: { name: "ダミー", isInstructor: false }, mine: false, replies: [] };

function res(p: Partial<FakeRes> & { body?: unknown }): () => Promise<FakeRes> {
  const { body, ...rest } = p;
  return () =>
    Promise.resolve({
      status: 200,
      ok: true,
      redirected: false,
      url: `${ORIGIN}/api/comments/l1`,
      json: () => Promise.resolve(body),
      ...rest,
    });
}

/** 手で解決する応答 */
function deferred() {
  let release!: (r: FakeRes) => void;
  const promise = new Promise<FakeRes>((r) => (release = r));
  return { promise, release };
}
const okRes = (body: unknown, url = `${ORIGIN}/api/comments/l1`): FakeRes => ({ status: 200, ok: true, redirected: false, url, json: () => Promise.resolve(body) });

describe("LessonView：loadComments の状態遷移（実行）", () => {
  it("成功：/api/comments/<id> を読み、配列を setComments、loading=false・失敗なし・ref が戻る", async () => {
    const { st, load } = harness(res({ body: [ROW] }));
    load("l1");
    assert.deepEqual(st.urls, ["/api/comments/l1"]);
    assert.equal(st.loading, true);
    assert.ok(st.inFlight);
    await settle();
    assert.deepEqual(st.comments, { lessonId: "l1", rows: [ROW] });
    assert.equal(st.loading, false);
    assert.equal(st.failedLessonId, null);
    assert.equal(st.inFlight, null);
  });

  it("lessonId は URL エンコードする", () => {
    const { st, load } = harness(res({ body: [] }));
    load("a/b?c");
    assert.deepEqual(st.urls, ["/api/comments/a%2Fb%3Fc"]);
  });

  it("空（0 件）：comments は [] で失敗にしない", async () => {
    const { st, load } = harness(res({ body: [] }));
    load("l1");
    await settle();
    assert.deepEqual(st.comments, { lessonId: "l1", rows: [] });
    assert.equal(st.failedLessonId, null);
    assert.equal(st.loading, false);
  });

  it("レッスンがない（id なし）：取得せず、読み込み中を解除する", () => {
    const { st, load } = harness(res({ body: [ROW] }));
    load(undefined);
    assert.deepEqual(st.urls, []);
    assert.equal(st.loading, false);
    assert.equal(st.failedLessonId, null);
    assert.equal(st.comments, null);
  });

  for (const [label, r] of [
    ["/login へのリダイレクト", { status: 200, ok: true, redirected: true, url: `${ORIGIN}/login?callbackUrl=%2F` }],
    ["401", { status: 401, ok: false, redirected: false, url: `${ORIGIN}/api/comments/l1` }],
  ] as Array<[string, Partial<FakeRes>]>) {
    it(`失効（${label}）：JSON を読まず、読み込み中のまま・失敗にしない・同じレッスンを再取得しない`, async () => {
      const { st, load } = harness(res(r));
      load("l1");
      await settle();
      assert.equal(st.jsonReads, 0);
      assert.equal(st.loading, true);
      assert.equal(st.failedLessonId, null);
      assert.equal(st.comments, null);
      assert.ok(st.inFlight);
      load("l1");
      await settle();
      assert.equal(st.urls.length, 1);
    });
  }

  for (const [label, r] of [
    ["/ へのリダイレクト", { status: 200, ok: true, redirected: true, url: `${ORIGIN}/` }],
    ["400", { status: 400, ok: false, redirected: false, url: `${ORIGIN}/api/comments/l1` }],
    ["403", { status: 403, ok: false, redirected: false, url: `${ORIGIN}/api/comments/l1` }],
    ["500", { status: 500, ok: false, redirected: false, url: `${ORIGIN}/api/comments/l1`, body: { error: "Internal server error" } }],
  ] as Array<[string, Partial<FakeRes> & { body?: unknown }]>) {
    it(`失敗（${label}）：JSON を読まず失敗のレッスン id を持ち、loading=false、ref が戻る`, async () => {
      const { st, load } = harness(res(r));
      load("l1");
      await settle();
      assert.equal(st.jsonReads, 0);
      assert.equal(st.failedLessonId, "l1");
      assert.equal(st.loading, false);
      assert.equal(st.comments, null);
      assert.equal(st.inFlight, null);
    });
  }

  for (const [label, body] of [
    ["オブジェクト", { error: "x" }],
    ["null", null],
    ["文字列", "[]"],
  ] as Array<[string, unknown]>) {
    it(`200 でも配列でない応答（${label}）は失敗`, async () => {
      const { st, load } = harness(res({ body }));
      load("l1");
      await settle();
      assert.equal(st.failedLessonId, "l1");
      assert.equal(st.loading, false);
      assert.equal(st.inFlight, null);
    });
  }

  it("JSON の解析失敗・ネットワークの例外は失敗", async () => {
    for (const respond of [
      res({ json: () => Promise.reject(new SyntaxError("bad json")) }),
      () => Promise.reject(new TypeError("Failed to fetch")),
    ]) {
      const { st, load } = harness(respond);
      load("l1");
      await settle();
      assert.equal(st.failedLessonId, "l1");
      assert.equal(st.loading, false);
      assert.equal(st.inFlight, null);
    }
  });

  it("同じレッスンの読み込み中に呼んでも 1 回しか取得しない", async () => {
    const d = deferred();
    const { st, load } = harness(() => d.promise);
    load("l1");
    load("l1");
    load("l1");
    assert.equal(st.urls.length, 1);
    d.release(okRes([ROW]));
    await settle();
    assert.deepEqual(st.comments, { lessonId: "l1", rows: [ROW] });
    assert.equal(st.inFlight, null);
  });

  it("再読み込み：失敗のあとに呼ぶと loading=true・失敗のレッスン id を null に戻して取得し直す", async () => {
    let n = 0;
    const { st, load } = harness(() => (++n === 1 ? res({ status: 500, ok: false })() : res({ body: [ROW] })()));
    load("l1");
    await settle();
    assert.equal(st.failedLessonId, "l1");
    load("l1");
    assert.equal(st.loading, true);
    assert.equal(st.failedLessonId, null);
    await settle();
    assert.equal(st.urls.length, 2);
    assert.deepEqual(st.comments, { lessonId: "l1", rows: [ROW] });
    assert.equal(st.failedLessonId, null);
  });

  it("素早くレッスンを切り替えたら、古いレッスンの応答（後から届いても）を捨てる", async () => {
    const a = deferred();
    const b = deferred();
    const { st, load } = harness((url) => (url.endsWith("/A") ? a.promise : b.promise));
    load("A");
    load("B");
    assert.deepEqual(st.urls, ["/api/comments/A", "/api/comments/B"]);
    const B_ROW = { ...ROW, id: "b1" };
    b.release(okRes([B_ROW]));
    await settle();
    assert.deepEqual(st.comments, { lessonId: "B", rows: [B_ROW] });
    assert.equal(st.loading, false);
    // A の応答が後から届いても、表示（B）も状態も変えない・JSON も読まない
    const reads = st.jsonReads;
    a.release(okRes([{ ...ROW, id: "a1" }]));
    await settle();
    assert.deepEqual(st.comments, { lessonId: "B", rows: [B_ROW] });
    assert.equal(st.loading, false);
    assert.equal(st.failedLessonId, null);
    assert.equal(st.jsonReads, reads);
  });

  it("古いレッスンの失敗・失効は、新しいレッスンの読み込み中の状態を変えない", async () => {
    const b = deferred();
    let calls = 0;
    const { st, load } = harness(() => {
      calls++;
      if (calls === 1) return res({ status: 500, ok: false })();
      if (calls === 2) return b.promise;
      return Promise.reject(new Error("unexpected"));
    });
    load("A");
    load("B");
    await settle();
    assert.equal(st.failedLessonId, null);
    assert.equal(st.loading, true);
    assert.ok(st.inFlight);
    b.release(okRes([]));
    await settle();
    assert.deepEqual(st.comments, { lessonId: "B", rows: [] });
    assert.equal(st.loading, false);
  });

  it("A → B → A と戻ったとき、最初の A の応答は捨てて、最後の A の応答だけを使う", async () => {
    const reqs: Array<ReturnType<typeof deferred>> = [];
    const { st, load } = harness(() => {
      const d = deferred();
      reqs.push(d);
      return d.promise;
    });
    load("A");
    load("B");
    load("A");
    assert.equal(reqs.length, 3);
    reqs[0].release(okRes([{ ...ROW, id: "old" }]));
    await settle();
    assert.equal(st.comments, null);
    assert.equal(st.loading, true);
    reqs[2].release(okRes([{ ...ROW, id: "new" }]));
    await settle();
    assert.deepEqual(st.comments, { lessonId: "A", rows: [{ ...ROW, id: "new" }] });
    assert.equal(st.loading, false);
    reqs[1].release(okRes([{ ...ROW, id: "b" }]));
    await settle();
    assert.deepEqual(st.comments, { lessonId: "A", rows: [{ ...ROW, id: "new" }] });
  });

  it("レッスンがなくなったら（id なし）、読み込み中の応答を捨てる", async () => {
    const a = deferred();
    const { st, load } = harness(() => a.promise);
    load("A");
    load(undefined);
    a.release(okRes([ROW]));
    await settle();
    assert.equal(st.comments, null);
    assert.equal(st.loading, false);
  });
});
