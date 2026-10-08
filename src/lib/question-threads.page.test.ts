import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import ts from "typescript";
import { classifyAuthFailure } from "./client-session";
import {
  addedThreadCount,
  firstPageRowCount,
  QUESTION_TABS,
  readThreadPage,
  THREADS_PAGE_SIZE,
  threadListUrl,
  threadRowDelay,
  threadsAddedMessage,
  threadsEmptyMessage,
  threadsMoreHint,
  toQuestionThreadItems,
} from "./question-threads";

// #32 質問スレッド一覧のページ：page.tsx（// @ts-nocheck）の Questions を
// 1. ソースで検査する（見本データが残っていない・配線・読み取りだけ）
// 2. typescript（devDependencies）の transpileModule で JSX から変換し、偽の React で「描画」して
//    表示・状態遷移・リクエストを確かめる（quiz-page.render.page.test.ts と同じ器）
// DOM・DB・ネットワークなし。データはすべてダミー。
//
// テストの範囲：本物の React ではなく偽の React で描画する。そのため次のことは検証しない。
// - useEffect の依存配列（最初の描画の後に 1 回だけ実行する）と cleanup（呼ばない）
// - setState による再描画（state を書き換えるだけ。描画はテストが render() を呼んだときだけ）
// - key の重複や欠け、hook の呼び出し順
// - CSS（3 行で切る表示）が実際にどう見えるか（style の値だけを見る）

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const questionsSrc = component("Questions");

// ───────────── ソースの検査 ─────────────

describe("Questions：見本データを残さない", () => {
  for (const [label, re] of [
    ["見本（佐藤）", /佐藤/],
    ["見本（鈴木）", /鈴木/],
    ["見本（田中）", /田中/],
    ["見本の質問", /タブレット表示が崩れる|Flexboxで縦中央揃え|模擬案件挑戦の進め方/],
    ["Resolved / Open", /Resolved|"Open"/],
    ["英語の replies 表記", / replies</],
    ["key に index", /key=\{i\}/],
  ] as Array<[string, RegExp]>) {
    it(`${label} がない`, () => {
      assert.doesNotMatch(questionsSrc, re);
    });
  }
});

describe("Questions：配線・読み取りだけ", () => {
  it("question-threads から必要な関数を import する", () => {
    const m = src.match(/import \{([^}]*)\} from "@\/lib\/question-threads";/);
    assert.ok(m, "import がない");
    const names = m[1].split(",").map((s) => s.trim());
    for (const n of ["addedThreadCount", "firstPageRowCount", "QUESTION_TABS", "readThreadPage", "threadListUrl", "threadRowDelay", "threadsAddedMessage", "threadsEmptyMessage", "threadsMoreHint", "toQuestionThreadItems"]) {
      assert.ok(names.includes(n), n);
    }
  });

  it("authFetch で読み、失効は classifyAuthFailure で判定する。素の fetch は使わない", () => {
    assert.match(questionsSrc, /authFetch\(url\)/);
    assert.match(questionsSrc, /classifyAuthFailure\(\{ status: res\.status, redirected: res\.redirected, url: res\.url \}\) === "expired"/);
    assert.doesNotMatch(questionsSrc, /(?<![\w$.])fetch\s*\(/);
    assert.match(questionsSrc, /if \(!res\.ok \|\| res\.redirected\) return null;/);
  });

  it("useRef で二重読み込みを防ぐ", () => {
    assert.match(questionsSrc, /const threadsInFlight = useRef\(false\);/);
  });

  it("投稿欄を作らない（POST・入力欄なし。#46）", () => {
    assert.doesNotMatch(questionsSrc, /method:\s*"POST"/);
    assert.doesNotMatch(questionsSrc, /<Input\b|<textarea\b|<input\b|<form\b/);
  });

  it("メールアドレス・avatar・userId を参照しない", () => {
    assert.doesNotMatch(questionsSrc, /\.email\b|\.avatar\b|userId/);
  });
});

// ───────────── 偽の React ─────────────

const transpiled = ts.transpileModule(questionsSrc, {
  fileName: "Questions.jsx",
  reportDiagnostics: true,
  compilerOptions: {
    jsx: ts.JsxEmit.React,
    jsxFactory: "h",
    jsxFragmentFactory: "Frag",
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
  },
});
const compiled = transpiled.outputText;
const STATE_NAMES = Array.from(questionsSrc.matchAll(/const \[(\w+), set\w+\] = useState\(/g)).map((m) => m[1]);

type El = { type: unknown; props: Record<string, unknown>; children: Node[] };
type Node = El | string | number;

function stub(name: string) {
  const f = () => null;
  Object.defineProperty(f, "name", { value: name });
  return f;
}

const Button = stub("Button");
const Badge = stub("Badge");
const COMPONENTS = {
  ScrollArea: stub("ScrollArea"),
  FadeIn: stub("FadeIn"),
  Button,
  Badge,
  Avatar: stub("Avatar"),
  AvatarFallback: stub("AvatarFallback"),
  User: stub("User"),
  BookOpen: stub("BookOpen"),
  MessageSquare: stub("MessageSquare"),
};

function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
  const flat = (children.flat(Infinity) as unknown[]).filter(
    (c) => c !== null && c !== undefined && c !== false && c !== true && c !== ""
  ) as Node[];
  return { type, props: props ?? {}, children: flat };
}
const Frag = "Frag";

function assertRenderable(n: Node) {
  if (typeof n === "string" || typeof n === "number") return;
  assert.ok(n && typeof n === "object" && "type" in n && Array.isArray(n.children), `描画できない子: ${inspect(n)}`);
  for (const c of n.children) assertRenderable(c);
}

type FakeRes = { status: number; ok: boolean; redirected: boolean; url: string; json: () => Promise<unknown> };
const ORIGIN = "https://nwa-lms.example.com";
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function res(body: unknown, p: Partial<FakeRes> = {}): FakeRes {
  return { status: 200, ok: true, redirected: false, url: `${ORIGIN}/api/comments`, json: () => Promise.resolve(body), ...p };
}

type Req = { url: string; init?: RequestInit; release: (r: FakeRes) => void; fail: (e: unknown) => void };

function mount() {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  let si = 0;
  let ri = 0;
  let first = true;
  const effects: Array<() => void> = [];
  const reqs: Req[] = [];

  const useState = (init: unknown) => {
    const i = si++;
    if (!(i in states)) states[i] = init;
    const set = (v: unknown) => {
      states[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(states[i]) : v;
    };
    return [states[i], set];
  };
  const useRef = (init: unknown) => {
    const i = ri++;
    if (!(i in refs)) refs[i] = { current: init };
    return refs[i];
  };
  const useEffect = (fn: () => void) => {
    if (first) effects.push(fn);
  };
  const authFetch = (url: string, init?: RequestInit) =>
    new Promise<FakeRes>((release, fail) => reqs.push({ url, init, release, fail }));

  const T = new Proxy({}, { get: () => "#000000" });
  const scope: Record<string, unknown> = {
    h,
    Frag,
    useState,
    useRef,
    useEffect,
    authFetch,
    classifyAuthFailure,
    addedThreadCount,
    firstPageRowCount,
    QUESTION_TABS,
    readThreadPage,
    threadListUrl,
    threadRowDelay,
    threadsAddedMessage,
    threadsEmptyMessage,
    threadsMoreHint,
    toQuestionThreadItems,
    T,
    glassStyle: () => ({}),
    ...COMPONENTS,
  };
  const names = Object.keys(scope);
  const Questions = new Function(...names, `${compiled}\nreturn Questions;`)(...names.map((n) => scope[n])) as () => El;

  const render = (): El => {
    si = 0;
    ri = 0;
    const tree = Questions();
    assertRenderable(tree);
    if (first) {
      first = false;
      for (const e of effects) e();
    }
    return tree;
  };
  const state = (name: string) => states[STATE_NAMES.indexOf(name)];
  return { render, reqs, state };
}

// ───────────── 木の検索 ─────────────

function text(n: Node | undefined): string {
  if (n === undefined) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  return n.children.map(text).join("");
}

function findAll(n: Node, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (typeof n === "object") {
    if (pred(n)) out.push(n);
    for (const c of n.children) findAll(c, pred, out);
  }
  return out;
}

const buttons = (tree: El) => findAll(tree, (e) => e.type === Button || e.type === "button");
const buttonLabels = (tree: El) => buttons(tree).map((b) => text(b).trim());
function button(tree: El, label: string): El {
  const hit = buttons(tree).filter((b) => text(b).trim() === label);
  assert.equal(hit.length, 1, `ボタン「${label}」が 1 つでない：${buttonLabels(tree).join(" / ")}`);
  return hit[0];
}
const threadButtons = (tree: El) => findAll(tree, (e) => e.type === "button" && "aria-expanded" in e.props);
const tabButtons = (tree: El) => findAll(tree, (e) => e.type === "button" && "aria-pressed" in e.props);
const tab = (tree: El, label: string) => {
  const hit = tabButtons(tree).filter((b) => text(b).trim() === label);
  assert.equal(hit.length, 1, label);
  return hit[0];
};
const click = (b: El) => (b.props.onClick as (e?: unknown) => void)({ preventDefault() {} });
const byRole = (tree: El, role: string) => findAll(tree, (e) => e.props.role === role);
// 空の案内の要素（文言がちょうど一致するもの。0 件で続きがあるときの説明は、未回答タブの空の案内を部分に含むため部分一致では見ない）
const emptyNotices = (tree: El, key: "all" | "mine" | "unanswered") =>
  findAll(tree, (e) => typeof e.type === "string" && text(e) === threadsEmptyMessage(key));

// ───────────── データ（ダミー） ─────────────

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const thread = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  content: `${id} の質問本文`,
  createdAt: ago(120),
  author: { name: "受講生エー", isInstructor: false },
  mine: false,
  replies: [],
  lesson: { id: "l1", title: "レッスン1" },
  course: { id: "co1", name: "STEP1" },
  replyCount: 0,
  lastReplyAt: null,
  answered: false,
  ...over,
});

const PAGE1 = {
  threads: [
    thread("t1", {
      content: "1行目\n2行目\n3行目\n4行目",
      author: { name: null, isInstructor: false },
      replies: [
        { id: "r1", content: "講師の回答", createdAt: ago(30), author: { name: "講師ビー", isInstructor: true }, mine: false },
        { id: "r2", content: "ありがとうございます", createdAt: ago(10), author: { name: null, isInstructor: false }, mine: false },
      ],
      replyCount: 2,
      answered: true,
      createdAt: ago(180),
    }),
    thread("t2", { author: { name: "講師シー", isInstructor: true }, mine: true }),
  ],
  nextCursor: null as string | null,
};

async function loaded(body: unknown = PAGE1) {
  const m = mount();
  m.render();
  assert.equal(m.reqs.length, 1);
  m.reqs[0].release(res(body));
  await settle();
  return m;
}

// ───────────── 描画 ─────────────

describe("Questions 描画：前提", () => {
  it("JSX の変換：診断なしで、import / export を含まない", () => {
    assert.deepEqual(transpiled.diagnostics ?? [], []);
    assert.doesNotMatch(compiled, /^\s*(import|export)\b/m);
  });

  it("useState の並びが取れている", () => {
    for (const n of ["tab", "threadRows", "nextCursor", "loading", "loadFailed", "loadingMore", "moreFailed", "expandedIds", "firstPageCount", "moreStatus"]) {
      assert.ok(STATE_NAMES.includes(n), n);
    }
  });
});

describe("Questions 描画：読み込み", () => {
  it("最初は読み込み中で、/api/comments を 1 回だけ読む", () => {
    const m = mount();
    const tree = m.render();
    assert.ok(text(tree).includes("Loading..."));
    assert.equal(m.reqs.length, 1);
    assert.equal(m.reqs[0].url, "/api/comments");
    assert.equal(m.reqs[0].init, undefined);
    m.render();
    assert.equal(m.reqs.length, 1);
  });

  it("読み込み中もタブを出し、「すべて」が選ばれている", () => {
    const m = mount();
    const tree = m.render();
    assert.deepEqual(tabButtons(tree).map((b) => [text(b).trim(), b.props["aria-pressed"]]), [
      ["すべて", true],
      ["自分の質問", false],
      ["未回答", false],
    ]);
  });

  it("一覧：名前・講師バッジ・相対時刻・本文・コース名 / レッスン名・返信数・回答済み / 未回答", async () => {
    const m = await loaded();
    const tree = m.render();
    const t = text(tree);
    for (const s of ["受講生", "講師シー", "3時間前", "2時間前", "1行目\n2行目\n3行目…", "t2 の質問本文", "STEP1 / レッスン1", "返信 2件", "返信 0件"]) {
      assert.ok(t.includes(s), s);
    }
    // 閉じているときは 4 行目以降を出さない（要約だけ）
    assert.ok(!t.includes("4行目"), "閉じているのに 4 行目が出ている");
    const badges = findAll(tree, (e) => e.type === Badge).map(text);
    assert.deepEqual(badges, ["回答済み", "講師", "未回答"]);
    // 閉じているときは返信を出さない
    assert.ok(!t.includes("講師の回答"));
    assert.equal(byRole(tree, "alert").length, 0);
  });

  it("失敗（500）は role=alert と再読み込み。押すと同じタブを読み直す", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res({ error: "Internal server error" }, { status: 500, ok: false }));
    await settle();
    let tree = m.render();
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1);
    assert.ok(text(alerts[0]).includes("質問を読み込めませんでした"));
    click(button(tree, "再読み込み"));
    click(button(tree, "再読み込み"));
    assert.equal(m.reqs.length, 2);
    assert.equal(m.reqs[1].url, "/api/comments");
    tree = m.render();
    assert.ok(text(tree).includes("Loading..."));
    m.reqs[1].release(res(PAGE1));
    await settle();
    tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.ok(text(tree).includes("t2 の質問本文"));
  });

  for (const [label, r] of [
    ["threads が配列でない", res({ threads: "x" })],
    ["配列そのもの", res([thread("t1")])],
    ["403", res({ error: "Forbidden" }, { status: 403, ok: false })],
    ["ログイン以外へのリダイレクト", res(PAGE1, { redirected: true, url: `${ORIGIN}/somewhere` })],
  ] as Array<[string, FakeRes]>) {
    it(`${label} は失敗として表示する`, async () => {
      const m = mount();
      m.render();
      m.reqs[0].release(r);
      await settle();
      const tree = m.render();
      assert.equal(byRole(tree, "alert").length, 1);
      assert.ok(!text(tree).includes("t1 の質問本文"));
    });
  }

  it("通信の例外も失敗", async () => {
    const m = mount();
    m.render();
    m.reqs[0].fail(new TypeError("network"));
    await settle();
    assert.equal(byRole(m.render(), "alert").length, 1);
  });

  it("空は「まだ質問はありません」", async () => {
    const m = await loaded({ threads: [], nextCursor: null });
    const t = text(m.render());
    assert.ok(t.includes("まだ質問はありません"));
    assert.equal(buttonLabels(m.render()).includes("もっと見る"), false);
  });
});

describe("Questions 描画：展開", () => {
  it("カードは aria-expanded のボタン。押すと全文と返信をその場（ボタンの外の領域）に出し、もう一度押すと閉じる", async () => {
    const m = await loaded();
    let tree = m.render();
    let cards = threadButtons(tree);
    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map((c) => c.props["aria-expanded"]), [false, false]);
    assert.equal(cards[0].props["aria-controls"], undefined);
    // ボタンの中は要約（3 行で切る）
    const body = (tree2: El) => findAll(threadButtons(tree2)[0], (e) => text(e) === "1行目\n2行目\n3行目…" && e.type === "span")[0];
    assert.ok(body(tree), "ボタンの中に要約がない");
    assert.equal((body(tree).props.style as Record<string, unknown>).WebkitLineClamp, 3);

    click(cards[0]);
    tree = m.render();
    cards = threadButtons(tree);
    assert.deepEqual(cards.map((c) => c.props["aria-expanded"]), [true, false]);
    const regionId = cards[0].props["aria-controls"];
    assert.equal(typeof regionId, "string");
    const region = findAll(tree, (e) => e.props.id === regionId);
    assert.equal(region.length, 1);
    const rt = text(region[0]);
    for (const s of ["講師ビー", "講師", "講師の回答", "30分前", "受講生", "ありがとうございます", "10分前"]) assert.ok(rt.includes(s), s);
    assert.ok(rt.indexOf("講師の回答") < rt.indexOf("ありがとうございます"), "返信の順序が違う");
    // 全文は領域に出し、返信より前
    assert.ok(rt.includes("1行目\n2行目\n3行目\n4行目"), "領域に全文がない");
    assert.ok(rt.indexOf("4行目") < rt.indexOf("講師の回答"), "全文が返信より後にある");
    // 開いてもボタンの中は要約のまま（全文・返信を入れない）
    const bt = text(cards[0]);
    assert.ok(bt.includes("1行目\n2行目\n3行目…"), "開いたボタンに要約がない");
    assert.ok(!bt.includes("4行目"), "ボタンの中に全文がある");
    assert.ok(!bt.includes("講師の回答"), "ボタンの中に返信がある");
    assert.equal((body(tree).props.style as Record<string, unknown>).WebkitLineClamp, 3);
    // 領域はボタンの外（ボタンの子孫でない）
    assert.equal(findAll(cards[0], (e) => e.props.id === regionId).length, 0);

    click(cards[0]);
    tree = m.render();
    assert.deepEqual(threadButtons(tree).map((c) => c.props["aria-expanded"]), [false, false]);
    assert.ok(!text(tree).includes("講師の回答"));
  });

  it("長い本文（2000 字）でも、ボタンの中は上限の文字数までで、全文は開いた領域にだけある", async () => {
    const long = "あ".repeat(2000);
    const m = await loaded({ threads: [thread("t1", { content: long })], nextCursor: null });
    let tree = m.render();
    let card = threadButtons(tree)[0];
    assert.ok(!text(tree).includes(long), "閉じているのに全文が出ている");
    assert.ok(text(card).length < 400, `ボタンの中が長すぎる: ${text(card).length}`);
    click(card);
    tree = m.render();
    card = threadButtons(tree)[0];
    assert.ok(!text(card).includes(long), "開いたボタンの中に全文がある");
    const region = findAll(tree, (e) => e.props.id === card.props["aria-controls"]);
    assert.equal(region.length, 1);
    assert.ok(text(region[0]).includes(long), "領域に全文がない");
  });

  it("返信がなければ「まだ返信はありません」", async () => {
    const m = await loaded();
    click(threadButtons(m.render())[1]);
    assert.ok(text(m.render()).includes("まだ返信はありません"));
  });

  it("展開しても読み直さない", async () => {
    const m = await loaded();
    click(threadButtons(m.render())[0]);
    m.render();
    assert.equal(m.reqs.length, 1);
  });
});

describe("Questions 描画：もっと見る", () => {
  const withNext = { ...PAGE1, nextCursor: "1000.t2" };

  it("nextCursor があれば「もっと見る」。押すとカーソル付きで 1 回だけ読み、続きを足す（重複は除く）", async () => {
    const m = await loaded(withNext);
    let tree = m.render();
    const more = button(tree, "もっと見る");
    click(more);
    click(more);
    assert.equal(m.reqs.length, 2);
    assert.equal(m.reqs[1].url, "/api/comments?cursor=1000.t2");
    tree = m.render();
    assert.equal(button(tree, "読み込み中...").props.disabled, true);
    // 読み込み中も一覧は残る
    assert.ok(text(tree).includes("t2 の質問本文"));
    m.reqs[1].release(res({ threads: [thread("t2"), thread("t3")], nextCursor: null }));
    await settle();
    tree = m.render();
    assert.deepEqual(threadButtons(tree).length, 3);
    assert.ok(text(tree).includes("t3 の質問本文"));
    assert.equal(buttonLabels(tree).includes("もっと見る"), false);
  });

  it("失敗したら一覧を残し、ボタンの近くに role=alert。もう一度押せる", async () => {
    const m = await loaded(withNext);
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({ error: "x" }, { status: 500, ok: false }));
    await settle();
    let tree = m.render();
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1);
    assert.ok(text(alerts[0]).includes("続きを読み込めませんでした"));
    assert.ok(text(tree).includes("t2 の質問本文"));
    assert.ok(!text(tree).includes("質問を読み込めませんでした"));
    // alert と「もっと見る」は同じ囲みの中
    const box = findAll(tree, (e) => e.children.includes(alerts[0]))[0];
    assert.ok(buttons(box).some((b) => text(b).trim() === "もっと見る"));
    click(button(tree, "もっと見る"));
    assert.equal(m.reqs.length, 3);
    tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
  });
});

describe("Questions 描画：タブ", () => {
  it("「自分の質問」で mine=1 を 1 ページ目から読み直す。空なら「まだ質問していません」", async () => {
    const m = await loaded({ ...PAGE1, nextCursor: "1000.t2" });
    click(threadButtons(m.render())[0]);
    click(tab(m.render(), "自分の質問"));
    assert.equal(m.reqs.length, 2);
    assert.equal(m.reqs[1].url, "/api/comments?mine=1");
    let tree = m.render();
    assert.ok(text(tree).includes("Loading..."));
    assert.equal(tab(tree, "自分の質問").props["aria-pressed"], true);
    assert.deepEqual(m.state("expandedIds"), []);
    m.reqs[1].release(res({ threads: [], nextCursor: null }));
    await settle();
    tree = m.render();
    assert.ok(text(tree).includes("まだ質問していません"));
  });

  it("「未回答」は status=unanswered。空なら「未回答の質問はありません」", async () => {
    const m = await loaded();
    click(tab(m.render(), "未回答"));
    assert.equal(m.reqs[1].url, "/api/comments?status=unanswered");
    m.reqs[1].release(res({ threads: [], nextCursor: null }));
    await settle();
    const t = text(m.render());
    assert.ok(t.includes("未回答の質問はありません"), "未回答タブの空の案内がない");
    assert.ok(!t.includes("まだ質問はありません"), "「すべて」の空の案内が出ている");
  });

  it("選ばれているタブを押しても読み直さない", async () => {
    const m = await loaded();
    click(tab(m.render(), "すべて"));
    assert.equal(m.reqs.length, 1);
  });

  it("切り替えたら前のタブの応答は捨てる（後から届いても表示しない）", async () => {
    const m = mount();
    m.render();
    click(tab(m.render(), "自分の質問"));
    assert.equal(m.reqs.length, 2);
    m.reqs[1].release(res({ threads: [thread("mine1")], nextCursor: null }));
    await settle();
    // 「すべて」の応答が後から届く
    m.reqs[0].release(res({ threads: [thread("all1")], nextCursor: "9.x" }));
    await settle();
    const tree = m.render();
    const t = text(tree);
    assert.ok(t.includes("mine1 の質問本文"));
    assert.ok(!t.includes("all1 の質問本文"));
    assert.equal(buttonLabels(tree).includes("もっと見る"), false);
    assert.equal(m.state("loading"), false);
  });

  it("前のタブの応答が新しいタブより先に届いても表示せず、読み込み中のまま", async () => {
    const m = mount();
    m.render();
    click(tab(m.render(), "未回答"));
    m.reqs[0].release(res({ threads: [thread("all1")], nextCursor: null }));
    await settle();
    let tree = m.render();
    assert.ok(text(tree).includes("Loading..."));
    assert.ok(!text(tree).includes("all1 の質問本文"));
    m.reqs[1].release(res({ threads: [thread("un1")], nextCursor: null }));
    await settle();
    tree = m.render();
    assert.ok(text(tree).includes("un1 の質問本文"));
  });

  it("前のタブの失敗は表示しない", async () => {
    const m = mount();
    m.render();
    click(tab(m.render(), "自分の質問"));
    m.reqs[0].release(res({}, { status: 500, ok: false }));
    m.reqs[1].release(res({ threads: [thread("mine1")], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.ok(text(tree).includes("mine1 の質問本文"));
  });

  it("「もっと見る」の途中で切り替えたら、その続きは足さない", async () => {
    const m = await loaded({ ...PAGE1, nextCursor: "1000.t2" });
    click(button(m.render(), "もっと見る"));
    click(tab(m.render(), "自分の質問"));
    assert.equal(m.reqs.length, 3);
    m.reqs[1].release(res({ threads: [thread("old_more")], nextCursor: null }));
    m.reqs[2].release(res({ threads: [thread("mine1")], nextCursor: null }));
    await settle();
    const t = text(m.render());
    assert.ok(t.includes("mine1 の質問本文"));
    assert.ok(!t.includes("old_more"));
    assert.ok(!t.includes("t1 の質問本文"));
  });
});

describe("Questions 描画：セッションの失効", () => {
  it("401 なら読み込み中のまま止まり、失敗も出さず、タブを押しても読まない", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res({ error: "Unauthorized" }, { status: 401, ok: false }));
    await settle();
    const tree = m.render();
    assert.ok(text(tree).includes("Loading..."));
    assert.equal(byRole(tree, "alert").length, 0);
    click(tab(tree, "自分の質問"));
    assert.equal(m.reqs.length, 1);
  });

  it("/login へのリダイレクトも失効", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res(null, { redirected: true, url: `${ORIGIN}/login` }));
    await settle();
    const tree = m.render();
    assert.ok(text(tree).includes("Loading..."));
    assert.equal(byRole(tree, "alert").length, 0);
  });

  it("「もっと見る」で失効したら「読み込み中...」のまま止まり、もう読まない", async () => {
    const m = await loaded({ ...PAGE1, nextCursor: "1000.t2" });
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({}, { status: 401, ok: false }));
    await settle();
    const tree = m.render();
    assert.equal(button(tree, "読み込み中...").props.disabled, true);
    assert.equal(byRole(tree, "alert").length, 0);
    click(button(tree, "読み込み中..."));
    click(tab(tree, "未回答"));
    assert.equal(m.reqs.length, 2);
  });
});

// ───────────── 追加（tester、#32） ─────────────

describe("Questions 描画（追加）：タブの素早い切り替え", () => {
  it("すべて → 自分の質問 → 未回答：応答が逆順に届いても最後のタブだけを表示し、それまで読み込み中", async () => {
    const m = mount();
    m.render();
    click(tab(m.render(), "自分の質問"));
    click(tab(m.render(), "未回答"));
    assert.deepEqual(m.reqs.map((r) => r.url), ["/api/comments", "/api/comments?mine=1", "/api/comments?status=unanswered"]);
    m.reqs[1].release(res({ threads: [thread("mine1")], nextCursor: "1.a" }));
    m.reqs[0].release(res({ threads: [thread("all1")], nextCursor: "1.b" }));
    await settle();
    let tree = m.render();
    assert.ok(text(tree).includes("Loading..."), "最後のタブの応答が届くまで読み込み中のはず");
    assert.equal(m.state("loading"), true);
    m.reqs[2].release(res({ threads: [thread("un1")], nextCursor: null }));
    await settle();
    tree = m.render();
    const t = text(tree);
    assert.ok(t.includes("un1 の質問本文"), "未回答の応答がない");
    assert.ok(!t.includes("mine1") && !t.includes("all1"), "古いタブの応答が混ざった");
    assert.equal(tab(tree, "未回答").props["aria-pressed"], true);
    assert.equal(buttonLabels(tree).includes("もっと見る"), false);
  });

  it("すべて → 自分の質問 → すべて：最初の「すべて」の応答は捨て、3 つ目の応答を出す", async () => {
    const m = mount();
    m.render();
    click(tab(m.render(), "自分の質問"));
    click(tab(m.render(), "すべて"));
    assert.equal(m.reqs.length, 3);
    assert.equal(m.reqs[2].url, "/api/comments");
    m.reqs[0].release(res({ threads: [thread("old_all")], nextCursor: null }));
    await settle();
    assert.ok(text(m.render()).includes("Loading..."), "古い「すべて」の応答を表示した");
    m.reqs[2].release(res({ threads: [thread("new_all")], nextCursor: null }));
    m.reqs[1].release(res({ threads: [thread("mine1")], nextCursor: null }));
    await settle();
    const t = text(m.render());
    assert.ok(t.includes("new_all の質問本文"), "新しい応答がない");
    assert.ok(!t.includes("old_all") && !t.includes("mine1"), "古い応答が混ざった");
  });

  it("古いタブの応答が 401 でも、新しいタブの応答は表示する。その後は読み込まない", async () => {
    const m = mount();
    m.render();
    click(tab(m.render(), "自分の質問"));
    m.reqs[0].release(res({}, { status: 401, ok: false }));
    m.reqs[1].release(res({ threads: [thread("mine1")], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.ok(text(tree).includes("mine1 の質問本文"), "新しいタブの応答がない");
    click(tab(tree, "未回答"));
    assert.equal(m.reqs.length, 2);
  });
});

describe("Questions 描画（追加）：もっと見る", () => {
  it("「自分の質問」タブの続きは mine=1 とカーソルで読む（タブとカーソルの取り違えがない）", async () => {
    const m = await loaded();
    click(tab(m.render(), "自分の質問"));
    m.reqs[1].release(res({ threads: [thread("mine1")], nextCursor: "1700000000000.mine1" }));
    await settle();
    click(button(m.render(), "もっと見る"));
    assert.equal(m.reqs[2].url, "/api/comments?mine=1&cursor=1700000000000.mine1");
  });

  it("「未回答」タブの続きは status=unanswered とカーソルで読み、次の nextCursor に進む", async () => {
    const m = await loaded();
    click(tab(m.render(), "未回答"));
    m.reqs[1].release(res({ threads: [thread("u1")], nextCursor: "5.u1" }));
    await settle();
    click(button(m.render(), "もっと見る"));
    assert.equal(m.reqs[2].url, "/api/comments?status=unanswered&cursor=5.u1");
    m.reqs[2].release(res({ threads: [thread("u2")], nextCursor: "3.u2" }));
    await settle();
    click(button(m.render(), "もっと見る"));
    assert.equal(m.reqs[3].url, "/api/comments?status=unanswered&cursor=3.u2");
  });

  for (const [label, act] of [
    ["壊れた応答（threads がない）", (r: Req) => r.release(res({ nextCursor: null }))],
    ["通信の例外", (r: Req) => r.fail(new TypeError("network"))],
    ["ログイン以外へのリダイレクト", (r: Req) => r.release(res(PAGE1, { redirected: true, url: `${ORIGIN}/elsewhere` }))],
  ] as Array<[string, (r: Req) => void]>) {
    it(`${label}は「続きを読み込めませんでした」。一覧と nextCursor は残る`, async () => {
      const m = await loaded({ ...PAGE1, nextCursor: "1000.t2" });
      click(button(m.render(), "もっと見る"));
      act(m.reqs[1]);
      await settle();
      const tree = m.render();
      const alerts = byRole(tree, "alert");
      assert.equal(alerts.length, 1);
      assert.ok(text(alerts[0]).includes("続きを読み込めませんでした"), "文言が違う");
      assert.equal(threadButtons(tree).length, 2);
      assert.equal(m.state("nextCursor"), "1000.t2");
      assert.equal(button(tree, "もっと見る").props.disabled, false);
    });
  }

  it("失敗の後の再試行が成功したら、alert を消して続きを足す", async () => {
    const m = await loaded({ ...PAGE1, nextCursor: "1000.t2" });
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({}, { status: 500, ok: false }));
    await settle();
    click(button(m.render(), "もっと見る"));
    assert.equal(m.reqs[2].url, "/api/comments?cursor=1000.t2");
    m.reqs[2].release(res({ threads: [thread("t3")], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.equal(threadButtons(tree).length, 3);
  });

  it("1 ページ目が 0 件でも nextCursor があれば、空の案内の代わりに「もっと見る」を出し、続きを読める", async () => {
    const m = mount();
    m.render();
    click(tab(m.render(), "未回答"));
    m.reqs[1].release(res({ threads: [], nextCursor: "1000.t9" }));
    await settle();
    let tree = m.render();
    assert.equal(emptyNotices(tree, "unanswered").length, 0, "続きがあるのに空の案内が出ている");
    assert.equal(threadButtons(tree).length, 0);
    click(button(tree, "もっと見る"));
    assert.equal(m.reqs.length, 3);
    assert.equal(m.reqs[2].url, "/api/comments?status=unanswered&cursor=1000.t9");
    m.reqs[2].release(res({ threads: [thread("t9")], nextCursor: null }));
    await settle();
    tree = m.render();
    assert.ok(text(tree).includes("t9 の質問本文"), "続きの行が出ていない");
    assert.equal(buttonLabels(tree).includes("もっと見る"), false);
  });

  it("続きも 0 件で nextCursor がなくなったら、空の案内を出す", async () => {
    const m = await loaded({ threads: [], nextCursor: "1000.t9" });
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({ threads: [], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.ok(text(tree).includes("まだ質問はありません"), "空の案内が出ていない");
    assert.equal(buttonLabels(tree).includes("もっと見る"), false);
  });

  it("0 件で続きの読み込みに失敗したら、alert と「もっと見る」を出す（空の案内は出さない）", async () => {
    const m = await loaded({ threads: [], nextCursor: "1000.t9" });
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({ error: "x" }, { status: 500, ok: false }));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 1);
    assert.ok(!text(tree).includes("まだ質問はありません"), "空の案内が出ている");
    assert.ok(buttonLabels(tree).includes("もっと見る"), "もっと見るがない");
  });

  it("1 ページ目の失敗のときは「もっと見る」を出さない", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res({}, { status: 500, ok: false }));
    await settle();
    assert.equal(buttonLabels(m.render()).includes("もっと見る"), false);
  });

  it("nextCursor が空文字・数値なら「もっと見る」を出さない", async () => {
    for (const nc of ["", 123]) {
      const m = await loaded({ ...PAGE1, nextCursor: nc });
      assert.equal(buttonLabels(m.render()).includes("もっと見る"), false, String(nc));
    }
  });
});

describe("Questions 描画（追加）：表示の遅れ", () => {
  it("1 ページ目の行は 50ms ずつ（最大 500ms）、「もっと見る」で足した行は遅らせない", async () => {
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => thread(`p${from + i}`));
    const m = await loaded({ threads: many(0, THREADS_PAGE_SIZE), nextCursor: "1000.p19" });
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({ threads: many(THREADS_PAGE_SIZE, 3), nextCursor: null }));
    await settle();
    const fades = findAll(m.render(), (e) => e.type === COMPONENTS.FadeIn && typeof e.props.delay === "number");
    assert.equal(fades.length, THREADS_PAGE_SIZE + 3);
    const delays = fades.map((f) => f.props.delay);
    assert.deepEqual(delays.slice(0, 3), [0, 50, 100]);
    assert.equal(Math.max(...(delays as number[])), 500);
    assert.deepEqual(delays.slice(THREADS_PAGE_SIZE), [0, 0, 0]);
  });

  const delaysOf = (tree: El) =>
    findAll(tree, (e) => e.type === COMPONENTS.FadeIn && typeof e.props.delay === "number").map((f) => f.props.delay);

  it("未回答タブで 1 ページ目が 3 件なら、足した行（4 行目以降）は遅らせない", async () => {
    const m = await loaded();
    click(tab(m.render(), "未回答"));
    m.reqs[1].release(res({ threads: [thread("u1"), thread("u2"), thread("u3")], nextCursor: "5.u3" }));
    await settle();
    assert.deepEqual(delaysOf(m.render()), [0, 50, 100]);
    click(button(m.render(), "もっと見る"));
    m.reqs[2].release(res({ threads: [thread("u4"), thread("u5")], nextCursor: null }));
    await settle();
    assert.deepEqual(delaysOf(m.render()), [0, 50, 100, 0, 0]);
  });

  it("未回答タブで 1 ページ目が 0 件なら、足した行はすべて遅らせない", async () => {
    const m = await loaded();
    click(tab(m.render(), "未回答"));
    m.reqs[1].release(res({ threads: [], nextCursor: "5.u0" }));
    await settle();
    click(button(m.render(), "もっと見る"));
    m.reqs[2].release(res({ threads: [thread("u1"), thread("u2"), thread("u3")], nextCursor: null }));
    await settle();
    assert.deepEqual(delaysOf(m.render()), [0, 0, 0]);
  });

  it("1 ページ目の壊れた要素・重複は境界に数えない", async () => {
    const m = await loaded({ threads: [thread("a"), null, thread("a"), thread("b")], nextCursor: "5.b" });
    assert.equal(m.state("firstPageCount"), 2);
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({ threads: [thread("c")], nextCursor: null }));
    await settle();
    assert.deepEqual(delaysOf(m.render()), [0, 50, 0]);
  });

  it("タブを切り替えたら境界を 1 ページ目の件数で更新する", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => thread(`p${i}`));
    const m = await loaded({ threads: many(THREADS_PAGE_SIZE), nextCursor: "1000.p19" });
    assert.equal(m.state("firstPageCount"), THREADS_PAGE_SIZE);
    click(tab(m.render(), "未回答"));
    assert.equal(m.state("firstPageCount"), 0);
    m.reqs[1].release(res({ threads: [thread("u1")], nextCursor: null }));
    await settle();
    assert.equal(m.state("firstPageCount"), 1);
  });
});

describe("Questions 描画（追加）：展開の aria", () => {
  it("2 つを同時に開ける。aria-controls は開いたカードごとに別の id で、その id の領域が 1 つだけある", async () => {
    const m = await loaded();
    click(threadButtons(m.render())[0]);
    click(threadButtons(m.render())[1]);
    const tree = m.render();
    const cards = threadButtons(tree);
    assert.deepEqual(cards.map((c) => c.props["aria-expanded"]), [true, true]);
    const ctrl = cards.map((c) => c.props["aria-controls"]);
    assert.notEqual(ctrl[0], ctrl[1]);
    for (const id of ctrl) {
      assert.equal(typeof id, "string");
      assert.equal(findAll(tree, (e) => e.props.id === id).length, 1, String(id));
    }
    // 各領域は、そのカードの返信を持つ
    assert.ok(text(findAll(tree, (e) => e.props.id === ctrl[0])[0]).includes("講師の回答"), "1 つ目の領域に返信がない");
    assert.ok(text(findAll(tree, (e) => e.props.id === ctrl[1])[0]).includes("まだ返信はありません"), "2 つ目の領域の文言がない");
  });

  it("カードは type=button のボタン要素（キーボードで開ける）。タブは aria-pressed、グループに aria-label", async () => {
    const m = await loaded();
    const tree = m.render();
    for (const c of threadButtons(tree)) assert.equal(c.props.type, "button");
    for (const t of tabButtons(tree)) assert.equal(t.props.type, "button");
    const group = findAll(tree, (e) => e.props.role === "group");
    assert.equal(group.length, 1);
    assert.equal(group[0].props["aria-label"], "質問の絞り込み");
  });

  it("「もっと見る」で足した行を開いても、既に開いた行は開いたまま", async () => {
    const m = await loaded({ ...PAGE1, nextCursor: "1000.t2" });
    click(threadButtons(m.render())[0]);
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({ threads: [thread("t3")], nextCursor: null }));
    await settle();
    click(threadButtons(m.render())[2]);
    assert.deepEqual(threadButtons(m.render()).map((c) => c.props["aria-expanded"]), [true, false, true]);
  });
});

describe("Questions（追加）：ソースの検査（変数の取り違え）", () => {
  it("loadThreads は引数のタブ（forTab）で URL を作り、loadMore は現在のタブ（tab）と nextCursor で作る", () => {
    assert.match(questionsSrc, /threadListUrl\(forTab, null\)/);
    assert.match(questionsSrc, /threadListUrl\(tab, nextCursor\)/);
  });

  it("1 ページ目は置き換え、続きは前の行に足す", () => {
    assert.match(questionsSrc, /setThreadRows\(page\.threads\)/);
    assert.match(questionsSrc, /setThreadRows\(prev => \[\.\.\.prev, \.\.\.page\.threads\]\)/);
  });

  it("古い応答は seq で捨て、失効のときは in-flight を外さない", () => {
    assert.match(questionsSrc, /if \(sessionExpired \|\| seq !== threadsSeq\.current\) return;\n\s*threadsInFlight\.current = false;/);
  });
});

describe("Questions 描画（追加）：0 件で続きがあるときの説明と、読み足した結果の知らせ", () => {
  const statusOf = (tree: El) => {
    const st = byRole(tree, "status");
    assert.equal(st.length, 1, "role=status が 1 つでない");
    assert.equal(st[0].props["aria-live"], "polite");
    return text(st[0]);
  };

  for (const t of QUESTION_TABS) {
    it(`${t.label}：0 件で続きがあれば、「もっと見る」と同じ囲みに説明を出す`, async () => {
      const m = await loaded();
      if (t.key !== "all") {
        click(tab(m.render(), t.label));
        m.reqs[1].release(res({ threads: [], nextCursor: "9.x" }));
      } else {
        click(tab(m.render(), "自分の質問"));
        click(tab(m.render(), "すべて"));
        m.reqs[2].release(res({ threads: [], nextCursor: "9.x" }));
      }
      await settle();
      const tree = m.render();
      const hint = findAll(tree, (e) => typeof e.type === "string" && text(e) === threadsMoreHint(t.key));
      assert.equal(hint.length, 1, "説明がない");
      const box = findAll(tree, (e) => e.children.includes(hint[0]))[0];
      assert.ok(buttons(box).some((b) => text(b).trim() === "もっと見る"), "説明と「もっと見る」が同じ囲みにない");
      assert.ok(text(box).indexOf(threadsMoreHint(t.key)) < text(box).indexOf("もっと見る"), "説明がボタンより後にある");
      assert.equal(emptyNotices(tree, t.key).length, 0, "空の案内が出ている");
    });
  }

  it("行があるときは説明を出さない", async () => {
    const m = await loaded({ ...PAGE1, nextCursor: "1000.t2" });
    const t = text(m.render());
    for (const q of QUESTION_TABS) assert.ok(!t.includes(threadsMoreHint(q.key)), `${q.key} の説明が出ている`);
  });

  it("role=status は最初から 1 つあり、空。読み足したら「n 件を追加しました」（重複は数えない）", async () => {
    const m = await loaded({ ...PAGE1, nextCursor: "1000.t2" });
    assert.equal(statusOf(m.render()), "");
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({ threads: [thread("t2"), thread("t3"), thread("t4")], nextCursor: "9.t4" }));
    await settle();
    assert.equal(statusOf(m.render()), "2 件を追加しました");
    // 次に押したら、いったん消してから新しい結果を出す
    click(button(m.render(), "もっと見る"));
    assert.equal(statusOf(m.render()), "");
    m.reqs[2].release(res({ threads: [thread("t5")], nextCursor: null }));
    await settle();
    assert.equal(statusOf(m.render()), "1 件を追加しました");
  });

  it("0 件で続きを読んでも 0 件なら「追加できる質問はありませんでした」。続きがあれば説明は残る", async () => {
    const m = await loaded({ threads: [], nextCursor: "1000.t9" });
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({ threads: [], nextCursor: "500.t8" }));
    await settle();
    const tree = m.render();
    assert.equal(statusOf(tree), threadsAddedMessage(0));
    assert.ok(text(tree).includes(threadsMoreHint("all")), "続きがあるのに説明が消えた");
  });

  it("読み足して 0 件で続きもなくなったら、空の案内に切り替わっても知らせは残る", async () => {
    const m = await loaded({ threads: [], nextCursor: "1000.t9" });
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({ threads: [], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.equal(emptyNotices(tree, "all").length, 1, "空の案内がない");
    assert.equal(statusOf(tree), "追加できる質問はありませんでした");
  });

  it("続きの読み込みに失敗したら知らせは空（alert で知らせる）", async () => {
    const m = await loaded({ ...PAGE1, nextCursor: "1000.t2" });
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({ error: "x" }, { status: 500, ok: false }));
    await settle();
    const tree = m.render();
    assert.equal(statusOf(tree), "");
    assert.equal(byRole(tree, "alert").length, 1);
  });

  it("タブを切り替えたら知らせを消す", async () => {
    const m = await loaded({ ...PAGE1, nextCursor: "1000.t2" });
    click(button(m.render(), "もっと見る"));
    m.reqs[1].release(res({ threads: [thread("t3")], nextCursor: null }));
    await settle();
    assert.equal(statusOf(m.render()), "1 件を追加しました");
    click(tab(m.render(), "未回答"));
    assert.equal(statusOf(m.render()), "");
  });
});
