import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import ts from "typescript";
import { classifyAuthFailure } from "./client-session";
import * as adminQuestions from "./admin-questions";
import * as commentForm from "./comment-form";
import {
  addedThreadCount,
  firstPageRowCount,
  readThreadPage,
  threadRowDelay,
  threadsAddedMessage,
  toQuestionThreadItems,
} from "./question-threads";
import { parseCommentContent } from "./lesson-comments";

// #32 A-2 管理画面の質問対応ページ（page.tsx の AdminQuestions）の追加の観点：
// 二重送信（タブ・コースの往復、別の質問への同時送信、失敗後の再送）、回答欄とサーバーの判定の一致、
// 応答の扱い（別 id の thread・壊れた JSON・各ステータス・セッション切れ）、一覧（URL・もっと見る・古い応答）、表示（名前・email など）。
// 器（JSX の変換と偽の React）は admin-questions.page.test.ts と同じ。DOM・DB・ネットワークなし。データはすべてダミー。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const compSrc = component("AdminQuestions");

// ───────────── 偽の React ─────────────

const transpiled = ts.transpileModule(compSrc, {
  fileName: "AdminQuestions.jsx",
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
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
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
  let ei = 0;
  type Effect = { deps: unknown[] | undefined; cleanup: (() => void) | undefined };
  const effectSlots: Effect[] = [];
  let pending: Array<{ i: number; fn: () => unknown; deps: unknown[] | undefined }> = [];
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
  const useEffect = (fn: () => unknown, deps?: unknown[]) => {
    const i = ei++;
    const prev = effectSlots[i];
    const changed = !prev || deps === undefined || prev.deps === undefined || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]));
    if (changed) pending.push({ i, fn, deps });
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
    ...adminQuestions,
    ...commentForm,
    addedThreadCount,
    firstPageRowCount,
    readThreadPage,
    threadRowDelay,
    threadsAddedMessage,
    toQuestionThreadItems,
    T,
    glassStyle: () => ({}),
    ...COMPONENTS,
  };
  const names = Object.keys(scope);
  const AdminQuestions = new Function(...names, `${compiled}\nreturn AdminQuestions;`)(...names.map((n) => scope[n])) as () => El;

  const render = (): El => {
    si = 0;
    ri = 0;
    ei = 0;
    pending = [];
    const tree = AdminQuestions();
    assertRenderable(tree);
    for (const { i, fn, deps } of pending) {
      effectSlots[i]?.cleanup?.();
      const cleanup = fn();
      effectSlots[i] = { deps, cleanup: typeof cleanup === "function" ? (cleanup as () => void) : undefined };
    }
    return tree;
  };
  return { render, reqs };
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
function tab(tree: El, label: string): El {
  const hit = tabButtons(tree).filter((b) => text(b).trim() === label);
  assert.equal(hit.length, 1, `タブ「${label}」が 1 つでない`);
  return hit[0];
}
const click = (b: El) => (b.props.onClick as (e?: unknown) => void)({ preventDefault() {} });
const byRole = (tree: El, role: string) => findAll(tree, (e) => e.props.role === role);
const textareas = (tree: El) => findAll(tree, (e) => e.type === "textarea");
function textarea(tree: El): El {
  const hit = textareas(tree);
  assert.equal(hit.length, 1, "回答欄が 1 つでない");
  return hit[0];
}
function courseSelect(tree: El): El {
  const hit = findAll(tree, (e) => e.type === "select");
  assert.equal(hit.length, 1, "コースの選択が 1 つでない");
  return hit[0];
}
const change = (el: El, value: string) => (el.props.onChange as (e: unknown) => void)({ target: { value } });
const statusTexts = (tree: El) => byRole(tree, "status").map((e) => text(e));

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
  course: { id: "co1", name: "STEP1 ダミー" },
  replyCount: 0,
  lastReplyAt: null,
  answered: false,
  ...over,
});

const PAGE1 = {
  threads: [thread("t1", { author: { name: null, isInstructor: false } }), thread("t2", { author: { name: "講師シー", isInstructor: true } })],
  nextCursor: null as string | null,
};

const COURSES = [
  { id: "co1", name: "STEP1 ダミー", _count: { sections: 2 } },
  { id: "co2", name: "STEP2 ダミー", _count: { sections: 1 } },
];

const answeredT1 = () =>
  thread("t1", {
    author: { name: null, isInstructor: false },
    replies: [{ id: "r1", content: "講師の回答です", createdAt: ago(0), author: { name: "講師ビー", isInstructor: true }, mine: true }],
    replyCount: 1,
    lastReplyAt: ago(0),
    answered: true,
  });

const findReq = (m: { reqs: Req[] }, pred: (u: string) => boolean) => m.reqs.filter((r) => pred(r.url));

async function loaded(body: unknown = PAGE1, courses: unknown = COURSES) {
  const m = mount();
  m.render();
  assert.equal(m.reqs.length, 2, "最初の読み込みが 2 本（一覧・コース）でない");
  m.reqs[0].release(res(body));
  m.reqs[1].release(res(courses, { url: `${ORIGIN}/api/admin/courses` }));
  await settle();
  return m;
}

/** t1 を開いて本文を入力した状態 */
async function typed(value: string) {
  const m = await loaded();
  click(threadButtons(m.render())[0]);
  change(textarea(m.render()), value);
  return m;
}

// ───────────── 追加の観点（#32 A-2 のテスト担当） ─────────────

const REPLY_URL = (id: string) => `${ORIGIN}/api/admin/comments/${id}/replies`;
const replyReqs = (m: { reqs: Req[] }) => findReq(m, (u) => u.startsWith("/api/admin/comments/"));
const listReqs = (m: { reqs: Req[] }) => findReq(m, (u) => u.startsWith("/api/comments"));
const rowTexts = (tree: El) => threadButtons(tree).map((b) => text(b));
function threadButton(tree: El, id: string): El {
  const hit = threadButtons(tree).filter((b) => b.props.id === `admin-question-thread-button-${id}`);
  assert.equal(hit.length, 1, `質問 ${id} の行が 1 つでない`);
  return hit[0];
}
function textareaOf(tree: El, id: string): El {
  const hit = textareas(tree).filter((e) => e.props.id === `admin-question-reply-${id}`);
  assert.equal(hit.length, 1, `質問 ${id} の回答欄が 1 つでない`);
  return hit[0];
}
/** 質問 id の回答欄と同じ領域にある送信ボタン（#47 の削除ボタン：aria-label が「…を削除」は除く） */
function sendButtonOf(tree: El, id: string): El {
  const region = findAll(tree, (e) => e.props.id === `admin-question-thread-${id}`);
  assert.equal(region.length, 1, `質問 ${id} の領域が 1 つでない`);
  const hit = findAll(region[0], (e) => e.type === Button && !String(e.props["aria-label"] ?? "").endsWith("を削除"));
  assert.equal(hit.length, 1, `質問 ${id} の送信ボタンが 1 つでない`);
  return hit[0];
}
const alertsOf = (tree: El) => byRole(tree, "alert").map((a) => text(a));

/** t1 と t2 の両方を開いた状態 */
async function bothOpen() {
  const m = await loaded();
  click(threadButton(m.render(), "t1"));
  click(threadButton(m.render(), "t2"));
  return m;
}

describe("AdminQuestions 追加：二重送信", () => {
  it("送信中にタブを切り替えて戻り、同じ質問を開いても「送信中...」で押せず、押しても送らない", async () => {
    const m = await typed("講師の回答です");
    click(button(m.render(), "回答を送信"));
    assert.equal(replyReqs(m).length, 1);
    click(tab(m.render(), "すべて"));
    m.reqs[m.reqs.length - 1].release(res(PAGE1));
    await settle();
    click(tab(m.render(), "未回答"));
    m.reqs[m.reqs.length - 1].release(res(PAGE1));
    await settle();
    click(threadButton(m.render(), "t1"));
    const tree = m.render();
    const b = sendButtonOf(tree, "t1");
    assert.equal(text(b).trim(), "送信中...", "送信中の表示が消えた");
    assert.equal(b.props.disabled, true, "送信中なのに押せる");
    assert.equal(textareaOf(tree, "t1").props.readOnly, true, "送信中なのに入力を変えられる");
    assert.equal(textareaOf(tree, "t1").props.value, "講師の回答です", "タブを切り替えて入力が消えた");
    click(b);
    assert.equal(replyReqs(m).length, 1, "タブを往復した後に再送した");
    // 応答が来たら、読み直した一覧の行を置き換える
    replyReqs(m)[0].release(res({ thread: answeredT1() }, { status: 201, url: REPLY_URL("t1") }));
    await settle();
    const after = m.render();
    assert.ok(text(threadButton(after, "t1")).includes("回答済み"), "読み直した一覧の行が回答済みにならない");
    assert.equal(textareaOf(after, "t1").props.value, "", "成功したのに入力が残る");
    assert.ok(statusTexts(after).includes(adminQuestions.REPLY_SENT_MESSAGE), "送信の知らせがない");
  });

  it("送信中にコースを切り替えて戻っても再送しない", async () => {
    const m = await typed("講師の回答です");
    click(button(m.render(), "回答を送信"));
    change(courseSelect(m.render()), "co2");
    m.reqs[m.reqs.length - 1].release(res({ threads: [], nextCursor: null }));
    await settle();
    change(courseSelect(m.render()), "");
    m.reqs[m.reqs.length - 1].release(res(PAGE1));
    await settle();
    click(threadButton(m.render(), "t1"));
    const tree = m.render();
    click(sendButtonOf(tree, "t1"));
    assert.equal(sendButtonOf(tree, "t1").props.disabled, true, "送信中なのに押せる");
    assert.equal(replyReqs(m).length, 1, "コースを往復した後に再送した");
  });

  it("送信中に一覧から行が消えても（タブ切り替え）、応答で一覧を壊さず、送信中の印は外れる", async () => {
    const m = await typed("講師の回答です");
    click(button(m.render(), "回答を送信"));
    click(tab(m.render(), "回答済み"));
    m.reqs[m.reqs.length - 1].release(res({ threads: [thread("a1", { answered: true })], nextCursor: null }));
    await settle();
    replyReqs(m)[0].release(res({ thread: answeredT1() }, { status: 201, url: REPLY_URL("t1") }));
    await settle();
    let tree = m.render();
    assert.deepEqual(threadButtons(tree).map((b) => b.props.id), ["admin-question-thread-button-a1"], "別のタブの一覧に行が混ざった");
    // 未回答に戻ると t1 は新しく読んだ状態。送信中ではないので（入力は消えているが）また書ける
    click(tab(tree, "未回答"));
    m.reqs[m.reqs.length - 1].release(res(PAGE1));
    await settle();
    click(threadButton(m.render(), "t1"));
    tree = m.render();
    assert.equal(textareaOf(tree, "t1").props.readOnly, false, "送信中の印が残った");
    assert.equal(textareaOf(tree, "t1").props.value, "", "成功した入力が残った");
  });

  it("別の質問へは同時に送れる（送信中の印は質問ごと）", async () => {
    const m = await bothOpen();
    change(textareaOf(m.render(), "t1"), "t1 への回答");
    change(textareaOf(m.render(), "t2"), "t2 への回答");
    click(sendButtonOf(m.render(), "t1"));
    let tree = m.render();
    assert.equal(sendButtonOf(tree, "t2").props.disabled, false, "別の質問の送信まで止まった");
    click(sendButtonOf(tree, "t2"));
    assert.deepEqual(replyReqs(m).map((r) => r.url), ["/api/admin/comments/t1/replies", "/api/admin/comments/t2/replies"]);
    tree = m.render();
    assert.equal(text(sendButtonOf(tree, "t1")).trim(), "送信中...");
    assert.equal(text(sendButtonOf(tree, "t2")).trim(), "送信中...");
    // t2 だけ失敗、t1 は成功：それぞれの欄に結果が出る
    replyReqs(m)[1].release(res({ error: "Not found" }, { status: 404, ok: false, url: REPLY_URL("t2") }));
    replyReqs(m)[0].release(res({ thread: answeredT1() }, { status: 201, url: REPLY_URL("t1") }));
    await settle();
    tree = m.render();
    assert.equal(textareaOf(tree, "t1").props.value, "", "成功した t1 の入力が残った");
    assert.equal(textareaOf(tree, "t2").props.value, "t2 への回答", "失敗した t2 の入力が消えた");
    assert.deepEqual(alertsOf(tree), [commentForm.commentSubmitErrorMessage({ httpStatus: 404 })]);
    const t2Region = findAll(tree, (e) => e.props.id === "admin-question-thread-t2")[0];
    assert.equal(byRole(t2Region, "alert").length, 1, "エラーが t2 の欄に出ていない");
    assert.ok(text(threadButton(tree, "t1")).includes("回答済み"), "t1 が回答済みにならない");
    assert.ok(text(threadButton(tree, "t2")).includes("未回答"), "失敗した t2 が回答済みになった");
  });

  it("成功しても、別の質問の書きかけは消えない", async () => {
    const m = await bothOpen();
    change(textareaOf(m.render(), "t1"), "t1 への回答");
    change(textareaOf(m.render(), "t2"), "t2 の書きかけ");
    click(sendButtonOf(m.render(), "t1"));
    replyReqs(m)[0].release(res({ thread: answeredT1() }, { status: 201, url: REPLY_URL("t1") }));
    await settle();
    assert.equal(textareaOf(m.render(), "t2").props.value, "t2 の書きかけ");
  });

  it("500・400 など結果が確定した失敗の後は、同じ質問にもう一度送れる（送る本文は同じ）", async () => {
    const fails = [
      (r: Req) => r.release(res({ error: "x" }, { status: 500, ok: false })),
      (r: Req) => r.release(res({ error: "Invalid request", reason: "invalid_body" }, { status: 400, ok: false })),
    ];
    for (const fail of fails) {
      const m = await typed("講師の回答です");
      click(button(m.render(), "回答を送信"));
      fail(replyReqs(m)[0]);
      await settle();
      const tree = m.render();
      assert.equal(button(tree, "回答を送信").props.disabled, false, "失敗の後に押せない");
      assert.equal(textarea(tree).props.readOnly, false, "失敗の後に入力できない");
      click(button(tree, "回答を送信"));
      assert.equal(replyReqs(m).length, 2, "失敗の後に再送できない");
      assert.equal(replyReqs(m)[1].init?.body, replyReqs(m)[0].init?.body);
    }
  });

  it("通信エラー・502〜504 の後は送れず（再読み込みを促す）、再読み込みで保存されていないと分かれば同じ本文で再送できる", async () => {
    const fails = [
      (r: Req) => r.fail(new TypeError("Failed to fetch")),
      ...[502, 503, 504].map((status) => (r: Req) => r.release(res(null, { status, ok: false, json: () => Promise.reject(new SyntaxError("x")) }))),
    ];
    for (const fail of fails) {
      const m = await typed("講師の回答です");
      click(button(m.render(), "回答を送信"));
      fail(replyReqs(m)[0]);
      await settle();
      let tree = m.render();
      const b = button(tree, "回答を送信");
      assert.equal(b.props.disabled, true, "結果不明なのに押せる");
      assert.equal(typeof b.props["aria-describedby"], "string", "送れない理由が結び付いていない");
      const hint = findAll(tree, (e) => e.props.id === b.props["aria-describedby"]);
      assert.equal(hint.length, 1, "送れない理由の要素がない");
      assert.ok(text(hint[0]).includes("一覧を再読み込み"), "再読み込みを促していない");
      assert.equal(textarea(tree).props.readOnly, false, "結果不明の間に入力できない");
      // 描画が古くても（disabled が反映される前の押下）送らない
      click(b);
      assert.equal(replyReqs(m).length, 1, "結果不明なのに再送した");
      // 未回答タブで読み直して、自分の回答が増えていない（保存されていない）
      click(button(tree, "一覧を再読み込み"));
      listReqs(m)[listReqs(m).length - 1].release(res(PAGE1));
      await settle();
      tree = m.render();
      assert.deepEqual(alertsOf(tree), [adminQuestions.REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE]);
      assert.equal(button(tree, "回答を送信").props.disabled, false, "保存されていないと分かったのに押せない");
      assert.equal(button(tree, "回答を送信").props["aria-describedby"], undefined, "送れない理由が残る");
      click(button(tree, "回答を送信"));
      assert.equal(replyReqs(m).length, 2, "保存されていないと分かったのに再送できない");
      assert.equal(replyReqs(m)[1].init?.body, replyReqs(m)[0].init?.body);
    }
  });

  it("同じ描画のボタンを 3 回続けて押しても POST は 1 本", async () => {
    const m = await typed("講師の回答です");
    const b = button(m.render(), "回答を送信");
    click(b);
    click(b);
    click(b);
    assert.equal(replyReqs(m).length, 1);
  });
});

describe("AdminQuestions 追加：回答欄とサーバーの判定", () => {
  const E = "\u{1F600}";
  const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"; // 7 コードポイント
  const samples: Array<[string, string]> = [
    ["空", ""],
    ["タブ・改行", "\t\n\r"],
    ["NBSP", "\u00A0"],
    ["各種スペース", "\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000"],
    ["行・段落区切り", "\u2028\u2029"],
    ["BOM", "\uFEFF"],
    ["ゼロ幅（ZWSP / ZWNJ / ZWJ / WJ）", "\u200B\u200C\u200D\u2060"],
    ["モンゴル母音区切り", "\u180E"],
    ["ハングルフィラー", "\u3164"],
    ["ハングルのフィラー各種", "\u115F\u1160\u3164\uFFA0"],
    ["点字の空白", "\u2800"],
    ["結合文字だけ", "\u0301\u0308"],
    ["異体字セレクタだけ", "\uFE0F"],
    ["双方向制御だけ", "\u202E\u202D"],
    ["タグ文字だけ", "\u{E0041}\u{E0042}"],
    ["フィラーに挟まれた文字", "\u3164あ\u3164"],
    ["ゼロ幅に挟まれた文字", "\u200Ba\u200B"],
    ["1 文字", "a"],
    ["2000 字", "あ".repeat(2000)],
    ["2001 字", "あ".repeat(2001)],
    ["絵文字 2000", E.repeat(2000)],
    ["絵文字 2001", E.repeat(2001)],
    ["前後の空白込みで 2000", "  \n" + "x".repeat(2000) + "\u3000 "],
    ["前後の空白込みで 2001", "\t" + "x".repeat(2001) + "\n"],
    ["結合文字 1000 組（コードポイント 2000）", "e\u0301".repeat(1000)],
    ["結合文字 1000 組 + 1（コードポイント 2001）", "e\u0301".repeat(1000) + "a"],
    ["家族の絵文字 285 個（コードポイント 1995）", FAMILY.repeat(285)],
    ["家族の絵文字 286 個（コードポイント 2002）", FAMILY.repeat(286)],
    ["先頭にゼロ幅 + 2000 字（trim で消えない）", "\u200B" + "x".repeat(2000)],
    ["2000 字の後ろに BOM（trim で消える）", "x".repeat(2000) + "\uFEFF"],
    ["孤立したサロゲート", "\uD83D"],
    ["孤立したサロゲート + 文字", "\uD83Da"],
    ["中の改行", "あ\n\nい"],
  ];

  it("送れる・空・上限超えの判定と文字数が parseCommentContent と一致する", () => {
    for (const [label, v] of samples) {
      const form = commentForm.commentFormState(v, false);
      const server = parseCommentContent(v);
      if ("reason" in server && server.reason === "invalid_characters") {
        // #86：NUL・対になっていないサロゲートは画面では止めず、送信後の 400 invalid_characters の文言で知らせる。
        // 画面の判定は空・上限超えの規則だけ
        assert.equal(form.canSubmit, !form.empty && !form.tooLong, `送れるかが空・上限超えの規則と違う：${label}`);
        continue;
      }
      assert.equal(form.canSubmit, server.ok, `送れるかが不一致：${label}`);
      if ("reason" in server) {
        assert.equal(form.empty, server.reason === "empty", `empty が不一致：${label}（${server.reason}）`);
        assert.equal(form.tooLong, server.reason === "too_long", `tooLong が不一致：${label}（${server.reason}）`);
      } else {
        assert.equal(form.length, Array.from(server.value).length, `文字数がサーバーの保存値と違う：${label}`);
      }
    }
  });

  it("文字数の表示：絵文字 2000 は「2000 / 2000」で送れる、2001 は超過の表示で送れない（描画）", async () => {
    const m = await typed(E.repeat(2000));
    let tree = m.render();
    assert.ok(text(tree).includes("2000 / 2000"), "絵文字 2000 個の文字数");
    assert.equal(button(tree, "回答を送信").props.disabled, false);
    change(textarea(tree), E.repeat(2001));
    tree = m.render();
    assert.ok(text(tree).includes("2001 / 2000（1 文字オーバー）"), "絵文字 2001 個の超過表示");
    assert.equal(button(tree, "回答を送信").props.disabled, true);
    change(textarea(tree), "e\u0301".repeat(1000) + "a");
    tree = m.render();
    assert.ok(text(tree).includes("2001 / 2000（1 文字オーバー）"), "結合文字はサーバーと同じく別の 1 文字");
    assert.equal(button(tree, "回答を送信").props.disabled, true);
  });

  it("見えない文字だけ（ハングルフィラー・ゼロ幅・結合文字・双方向制御）は描画でも送れず、押しても送らない", async () => {
    const m = await typed("x");
    for (const v of ["\u3164", "\u115F\u1160\uFFA0", "\u200B\u200C\u200D\u2060", "\u0301", "\u202E", "\u2800", "\uFEFF\u3000"]) {
      change(textarea(m.render()), v);
      const tree = m.render();
      assert.equal(button(tree, "回答を送信").props.disabled, true, `送れる：${JSON.stringify(v)}`);
      click(button(tree, "回答を送信"));
    }
    assert.equal(replyReqs(m).length, 0, "見えない文字だけで送った");
  });

  it("2000 字ちょうどは送れて、本文はそのまま content に入る（前後の空白はサーバーが除く）", async () => {
    const v = " " + "あ".repeat(2000) + "\n";
    const m = await typed(v);
    click(button(m.render(), "回答を送信"));
    assert.equal(replyReqs(m).length, 1);
    assert.deepEqual(JSON.parse(String(replyReqs(m)[0].init?.body)), { content: v });
  });
});

describe("AdminQuestions 追加：応答の扱い", () => {
  async function sent() {
    const m = await typed("講師の回答です");
    click(button(m.render(), "回答を送信"));
    return m;
  }

  it("201 で別の id の thread が返ったら置き換えず、再読み込みを案内して入力を残す", async () => {
    const m = await sent();
    const other = { ...answeredT1(), id: "t2" };
    replyReqs(m)[0].release(res({ thread: other }, { status: 201, url: REPLY_URL("t1") }));
    await settle();
    const tree = m.render();
    assert.deepEqual(alertsOf(tree), [commentForm.COMMENT_UNKNOWN_RESULT_MESSAGE]);
    assert.ok(text(threadButton(tree, "t1")).includes("未回答"), "t1 が回答済みになった");
    assert.ok(text(threadButton(tree, "t2")).includes("未回答"), "t2 が別の応答で置き換わった");
    assert.ok(text(threadButton(tree, "t2")).includes("講師シー"), "t2 の行が変わった");
    assert.equal(textarea(tree).props.value, "講師の回答です");
    assert.ok(!statusTexts(tree).includes(adminQuestions.REPLY_SENT_MESSAGE), "失敗なのに送信の知らせが出た");
  });

  it("201 で本文が壊れた JSON なら再読み込みを案内する（再送の案内ではない）", async () => {
    const m = await sent();
    replyReqs(m)[0].release(res(null, { status: 201, url: REPLY_URL("t1"), json: () => Promise.reject(new SyntaxError("Unexpected token")) }));
    await settle();
    const tree = m.render();
    assert.deepEqual(alertsOf(tree), [commentForm.COMMENT_UNKNOWN_RESULT_MESSAGE]);
    assert.ok(commentForm.COMMENT_UNKNOWN_RESULT_MESSAGE.includes("再読み込み"), "再読み込みの案内がない");
    assert.equal(textarea(tree).props.value, "講師の回答です");
  });

  it("400 の各 reason・403・404・500・502〜504 の文言を出し、入力を残す", async () => {
    const cases: Array<[Partial<FakeRes>, unknown, string]> = [];
    for (const reason of ["empty", "too_long", "invalid_characters", "invalid_content", "invalid_body", "invalid_id", "not_a_question", "unknown_reason"]) {
      cases.push([{ status: 400, ok: false }, { error: "Invalid request", reason }, commentForm.commentSubmitErrorMessage({ httpStatus: 400, reason })]);
    }
    cases.push([{ status: 400, ok: false }, { error: "Invalid request" }, commentForm.commentSubmitErrorMessage({ httpStatus: 400, reason: "invalid_body" })]);
    cases.push([{ status: 403, ok: false }, { error: "Forbidden" }, "この操作を行う権限がありません。"]);
    cases.push([{ status: 404, ok: false }, { error: "Not found" }, commentForm.commentSubmitErrorMessage({ httpStatus: 404 })]);
    for (const status of [500, 501]) cases.push([{ status, ok: false }, { error: "Internal server error" }, commentForm.COMMENT_SERVER_ERROR_MESSAGE]);
    // ゲートウェイのエラーは送信できたか分からない（再読み込みで確かめる案内）
    for (const status of [502, 503, 504]) cases.push([{ status, ok: false }, null, commentForm.COMMENT_UNKNOWN_RESULT_MESSAGE]);
    for (const [p, body, message] of cases) {
      const m = await sent();
      replyReqs(m)[0].release(res(body, { url: REPLY_URL("t1"), ...p }));
      await settle();
      const tree = m.render();
      assert.deepEqual(alertsOf(tree), [message], `${p.status} ${JSON.stringify(body)}`);
      assert.equal(textarea(tree).props.value, "講師の回答です", `入力が消えた：${p.status}`);
    }
  });

  it("400 の文言はそれぞれ空でなく、英語の既定文言・reason の値をそのまま出さない", () => {
    for (const reason of ["empty", "too_long", "invalid_characters", "invalid_content", "invalid_body", "invalid_id", "not_a_question"]) {
      const msg = commentForm.commentSubmitErrorMessage({ httpStatus: 400, reason });
      assert.ok(msg.length > 0, reason);
      assert.ok(!msg.includes(reason), `reason がそのまま出る：${reason}`);
      assert.doesNotMatch(msg, /Invalid|request/, reason);
    }
  });

  it("403（権限なし）の後もセッション切れ扱いにはせず、一覧は読める", async () => {
    const m = await sent();
    replyReqs(m)[0].release(res({ error: "Forbidden" }, { status: 403, ok: false, url: REPLY_URL("t1") }));
    await settle();
    const before = m.reqs.length;
    click(tab(m.render(), "すべて"));
    assert.equal(m.reqs.length, before + 1, "403 の後に一覧を読まない");
  });

  it("401 はログイン期限切れの文言で、以降は読み込み・送信・もっと見るをしない", async () => {
    const m = await loaded({ threads: PAGE1.threads, nextCursor: "c.1" });
    click(threadButton(m.render(), "t1"));
    change(textarea(m.render()), "講師の回答です");
    click(button(m.render(), "回答を送信"));
    replyReqs(m)[0].release(res({ error: "Unauthorized" }, { status: 401, ok: false, url: REPLY_URL("t1") }));
    await settle();
    const tree = m.render();
    assert.deepEqual(alertsOf(tree), [commentForm.COMMENT_SESSION_EXPIRED_MESSAGE]);
    const before = m.reqs.length;
    click(button(tree, "回答を送信"));
    click(button(tree, "もっと見る"));
    click(tab(tree, "回答済み"));
    change(courseSelect(tree), "co1");
    assert.equal(m.reqs.length, before, "セッション切れの後に通信した");
  });

  it("/login へのリダイレクト（200）は期限切れの文言で、以降は通信しない", async () => {
    const m = await sent();
    replyReqs(m)[0].release(res(null, { status: 200, redirected: true, url: `${ORIGIN}/login?callbackUrl=%2F`, json: () => Promise.reject(new SyntaxError("<html>")) }));
    await settle();
    const tree = m.render();
    assert.deepEqual(alertsOf(tree), [commentForm.COMMENT_SESSION_EXPIRED_MESSAGE]);
    assert.ok(text(threadButton(tree, "t1")).includes("未回答"), "リダイレクトを成功として扱った");
    const before = m.reqs.length;
    click(button(tree, "回答を送信"));
    click(tab(tree, "すべて"));
    assert.equal(m.reqs.length, before, "リダイレクトの後に通信した");
  });

  it("成功の知らせは、次の送信を始めたとき・タブを切り替えたときに消える", async () => {
    const m = await bothOpen();
    change(textareaOf(m.render(), "t1"), "t1 への回答");
    click(sendButtonOf(m.render(), "t1"));
    replyReqs(m)[0].release(res({ thread: answeredT1() }, { status: 201, url: REPLY_URL("t1") }));
    await settle();
    assert.ok(statusTexts(m.render()).includes(adminQuestions.REPLY_SENT_MESSAGE), "知らせがない");
    change(textareaOf(m.render(), "t2"), "t2 への回答");
    click(sendButtonOf(m.render(), "t2"));
    assert.ok(!statusTexts(m.render()).includes(adminQuestions.REPLY_SENT_MESSAGE), "次の送信中も前の知らせが残る");
    replyReqs(m)[1].release(res({ thread: { ...answeredT1(), id: "t2" } }, { status: 201, url: REPLY_URL("t2") }));
    await settle();
    assert.ok(statusTexts(m.render()).includes(adminQuestions.REPLY_SENT_MESSAGE), "2 回目の知らせがない");
    click(tab(m.render(), "すべて"));
    assert.ok(!statusTexts(m.render()).includes(adminQuestions.REPLY_SENT_MESSAGE), "タブを切り替えても知らせが残る");
  });
});

describe("AdminQuestions 追加：一覧", () => {
  it("タブ × コースの 1 ページ目の URL", async () => {
    const m = await loaded();
    const steps: Array<[string, (tree: El) => void, string]> = [
      ["回答済みタブ", (t) => click(tab(t, "回答済み")), "/api/comments?status=answered"],
      ["すべてタブ", (t) => click(tab(t, "すべて")), "/api/comments"],
      ["コース co1", (t) => change(courseSelect(t), "co1"), "/api/comments?courseId=co1"],
      ["回答済みタブ（co1）", (t) => click(tab(t, "回答済み")), "/api/comments?status=answered&courseId=co1"],
      ["未回答タブ（co1）", (t) => click(tab(t, "未回答")), "/api/comments?status=unanswered&courseId=co1"],
      ["コース co2", (t) => change(courseSelect(t), "co2"), "/api/comments?status=unanswered&courseId=co2"],
      ["すべてのコース", (t) => change(courseSelect(t), ""), "/api/comments?status=unanswered"],
    ];
    for (const [label, act, url] of steps) {
      const before = m.reqs.length;
      act(m.render());
      assert.equal(m.reqs.length, before + 1, `読まない：${label}`);
      assert.equal(m.reqs[before].url, url, label);
      m.reqs[before].release(res(PAGE1));
      await settle();
    }
    // 選んでいるタブ・コースをもう一度選んでも読まない
    const before = m.reqs.length;
    click(tab(m.render(), "未回答"));
    change(courseSelect(m.render()), "");
    assert.equal(m.reqs.length, before, "同じタブ・コースで読み直した");
  });

  it("もっと見るはタブ・コース・cursor をすべて付ける。cursor はエンコードする", async () => {
    const m = await loaded();
    click(tab(m.render(), "回答済み"));
    m.reqs[m.reqs.length - 1].release(res(PAGE1));
    await settle();
    change(courseSelect(m.render()), "co2");
    m.reqs[m.reqs.length - 1].release(res({ threads: [thread("a1", { answered: true })], nextCursor: "2026-10-01T00:00:00.000Z&x=1" }));
    await settle();
    click(button(m.render(), "もっと見る"));
    const url = m.reqs[m.reqs.length - 1].url;
    const q = new URL(url, ORIGIN).searchParams;
    assert.equal(new URL(url, ORIGIN).pathname, "/api/comments");
    assert.equal(q.get("status"), "answered");
    assert.equal(q.get("courseId"), "co2");
    assert.equal(q.get("cursor"), "2026-10-01T00:00:00.000Z&x=1", "cursor が壊れた");
    assert.equal(q.get("x"), null, "cursor の & が別のパラメータになった");
  });

  it("もっと見るの連打・読み込み中は 1 本だけ。読み込み中は「読み込み中...」で押せない", async () => {
    const m = await loaded({ threads: PAGE1.threads, nextCursor: "c.1" });
    const b = button(m.render(), "もっと見る");
    click(b);
    click(b);
    const tree = m.render();
    assert.equal(button(tree, "読み込み中...").props.disabled, true);
    click(button(tree, "読み込み中..."));
    assert.equal(listReqs(m).length, 2, "もっと見るを二重に読んだ");
  });

  it("もっと見るの失敗：行を残して role=alert、もう一度押すと同じ URL を読み、成功で追加の件数を知らせる", async () => {
    const m = await loaded({ threads: PAGE1.threads, nextCursor: "c.1" });
    click(button(m.render(), "もっと見る"));
    m.reqs[2].release(res({ error: "x" }, { status: 500, ok: false }));
    await settle();
    let tree = m.render();
    assert.equal(threadButtons(tree).length, 2, "失敗で行が消えた");
    assert.equal(byRole(tree, "alert").length, 1);
    assert.ok(text(byRole(tree, "alert")[0]).includes("続きを読み込めませんでした"), "失敗の文言");
    click(button(tree, "もっと見る"));
    assert.equal(m.reqs[3].url, m.reqs[2].url);
    m.reqs[3].release(res({ threads: [thread("t3"), thread("t4")], nextCursor: null }));
    await settle();
    tree = m.render();
    assert.equal(threadButtons(tree).length, 4);
    assert.equal(byRole(tree, "alert").length, 0, "成功したのに失敗の文言が残る");
    assert.ok(statusTexts(tree).includes("2 件を追加しました"), "追加の知らせがない");
    assert.equal(buttonLabels(tree).includes("もっと見る"), false, "続きがないのに「もっと見る」がある");
  });

  it("もっと見るの通信中にタブを切り替えると、古い続きは捨て、読み込み中の印も残らない", async () => {
    const m = await loaded({ threads: PAGE1.threads, nextCursor: "c.1" });
    click(button(m.render(), "もっと見る"));
    const more = m.reqs[2];
    click(tab(m.render(), "回答済み"));
    const fresh = m.reqs[3];
    assert.equal(fresh.url, "/api/comments?status=answered");
    fresh.release(res({ threads: [thread("a1", { answered: true })], nextCursor: "c.2" }));
    more.release(res({ threads: [thread("old")], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.deepEqual(threadButtons(tree).map((b) => b.props.id), ["admin-question-thread-button-a1"], "古い続きが混ざった");
    assert.ok(buttonLabels(tree).includes("もっと見る"), "読み込み中のままになった");
    click(button(tree, "もっと見る"));
    assert.equal(m.reqs[4].url, "/api/comments?status=answered&cursor=c.2", "新しいタブの続きを読めない");
  });

  it("1 ページ目の通信中にコースを切り替えると、古い応答（遅れて届く）は捨てる", async () => {
    const m = mount();
    m.render();
    change(courseSelect(m.render()), "co1");
    const fresh = m.reqs[2];
    assert.equal(fresh.url, "/api/comments?status=unanswered&courseId=co1");
    fresh.release(res({ threads: [thread("c1")], nextCursor: null }));
    await settle();
    m.reqs[0].release(res(PAGE1));
    await settle();
    assert.deepEqual(threadButtons(m.render()).map((b) => b.props.id), ["admin-question-thread-button-c1"]);
  });

  it("古い応答が失敗（通信エラー）でも、新しい一覧を失敗にしない", async () => {
    const m = mount();
    m.render();
    click(tab(m.render(), "すべて"));
    m.reqs[2].release(res(PAGE1));
    await settle();
    m.reqs[0].fail(new Error("network"));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0, "古い応答の失敗が出た");
    assert.equal(threadButtons(tree).length, 2);
  });

  it("読み込みに失敗した後、タブを切り替えれば読み直せる。コースで絞った再読み込みはコースを保つ", async () => {
    const m = await loaded();
    change(courseSelect(m.render()), "co1");
    m.reqs[2].release(res({ error: "x" }, { status: 503, ok: false }));
    await settle();
    click(button(m.render(), "再読み込み"));
    assert.equal(m.reqs[3].url, "/api/comments?status=unanswered&courseId=co1");
    m.reqs[3].fail(new Error("network"));
    await settle();
    click(tab(m.render(), "すべて"));
    assert.equal(m.reqs[4].url, "/api/comments?courseId=co1");
    m.reqs[4].release(res(PAGE1));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.equal(threadButtons(tree).length, 2);
  });

  it("もっと見るが 401 なら、以降は読まない（読み込み中のまま）", async () => {
    const m = await loaded({ threads: PAGE1.threads, nextCursor: "c.1" });
    click(button(m.render(), "もっと見る"));
    m.reqs[2].release(res(null, { status: 401, ok: false }));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0, "セッション切れを失敗として出した");
    click(tab(tree, "すべて"));
    assert.equal(m.reqs.length, 3, "セッション切れの後に読んだ");
  });

  it("コースの読み込みが 401 / /login へのリダイレクトなら、以降は読まない", async () => {
    for (const p of [{ status: 401, ok: false }, { status: 200, redirected: true, url: `${ORIGIN}/login` }] as Partial<FakeRes>[]) {
      const m = mount();
      m.render();
      m.reqs[1].release(res(null, { url: `${ORIGIN}/api/admin/courses`, ...p, json: () => Promise.reject(new Error("not json")) }));
      m.reqs[0].release(res(PAGE1));
      await settle();
      click(tab(m.render(), "すべて"));
      assert.equal(m.reqs.length, 2, `コースのセッション切れ（${p.status}）の後に読んだ`);
    }
  });

  it("コースの読み込みが通信エラー・壊れた JSON でも「すべてのコース」だけと案内", async () => {
    for (const finish of [(r: Req) => r.fail(new Error("network")), (r: Req) => r.release(res(null, { json: () => Promise.reject(new Error("x")) }))]) {
      const m = mount();
      m.render();
      m.reqs[0].release(res(PAGE1));
      finish(m.reqs[1]);
      await settle();
      const tree = m.render();
      assert.equal(findAll(courseSelect(tree), (e) => e.type === "option").length, 1);
      assert.ok(text(tree).includes("コースの一覧を読み込めませんでした"), "案内がない");
    }
  });

  it("0 件で続きがあるときの説明はタブごと（回答済み・すべて）で、空の文言は出さない", async () => {
    for (const label of ["回答済み", "すべて"] as const) {
      const key = label === "回答済み" ? "answered" : "all";
      const m = await loaded();
      click(tab(m.render(), label));
      m.reqs[2].release(res({ threads: [], nextCursor: "c.9" }));
      await settle();
      const tree = m.render();
      assert.ok(text(tree).includes(adminQuestions.adminThreadsMoreHint(key)), `説明がない：${label}`);
      // 説明（「ここまでに…はありません。…」）は空の文言を含むので、要素の文字列が空の文言と一致するかで確かめる
      const empty = adminQuestions.adminThreadsEmptyMessage(key, false);
      assert.equal(findAll(tree, (e) => text(e) === empty).length, 0, `空の文言も出た：${label}`);
      assert.ok(buttonLabels(tree).includes("もっと見る"), `もっと見るがない：${label}`);
    }
  });
});

describe("AdminQuestions 追加：表示", () => {
  const SECRET = "dummy-secret-student@example.com";
  const rows = {
    threads: [
      thread("d1", { author: { name: null, isInstructor: false, email: SECRET }, userId: "u-secret-1", email: SECRET }),
      thread("d2", { author: { name: "\u200B\u3164\u202E", isInstructor: false } }),
      thread("d3", { author: { name: "\u200B", isInstructor: true } }),
      thread("d4", {
        author: { name: "受講生ディー", isInstructor: false, avatar: "https://example.com/a.png" },
        replies: [
          { id: "r1", content: "講師の返信", createdAt: ago(1), author: { name: "講師イー", isInstructor: true, email: SECRET }, mine: true },
          { id: "r2", content: "無効化された受講生の返信", createdAt: ago(1), author: { name: null, isInstructor: false }, mine: false, userId: "u-secret-2" },
        ],
        replyCount: 2,
        answered: true,
      }),
    ],
    nextCursor: null,
  };

  function allStrings(n: Node, out: string[] = []): string[] {
    if (typeof n === "string" || typeof n === "number") {
      out.push(String(n));
      return out;
    }
    for (const v of Object.values(n.props)) if (typeof v === "string") out.push(v);
    for (const c of n.children) allStrings(c, out);
    return out;
  }

  it("無効化済み（name が null）・見えない文字だけの名前の受講生は「受講生」、名前の見えない講師は「講師」とバッジ", async () => {
    const m = await loaded(rows);
    const tree = m.render();
    const name = (id: string) => {
      const spans = findAll(threadButton(tree, id), (e) => e.type === "span" && e.children.length === 1 && typeof e.children[0] === "string");
      return spans.map((s) => text(s));
    };
    assert.ok(name("d1").includes("受講生"), `d1：${name("d1").join("|")}`);
    assert.ok(name("d2").includes("受講生"), `d2：${name("d2").join("|")}`);
    assert.ok(!text(threadButton(tree, "d2")).includes("\u202E"), "双方向制御が名前に残った");
    assert.ok(name("d3").includes("講師"), `d3：${name("d3").join("|")}`);
    const badges = findAll(threadButton(tree, "d3"), (e) => e.type === Badge).map((b) => text(b));
    assert.ok(badges.includes("講師"), "名前の見えない講師にバッジがない");
    const d1Badges = findAll(threadButton(tree, "d1"), (e) => e.type === Badge).map((b) => text(b));
    assert.ok(!d1Badges.includes("講師"), "受講生に講師バッジ");
  });

  it("返信：講師は名前とバッジ、無効化済みの受講生は「受講生」", async () => {
    const m = await loaded(rows);
    click(threadButton(m.render(), "d4"));
    const region = findAll(m.render(), (e) => e.props.id === "admin-question-thread-d4")[0];
    const t = text(region);
    assert.ok(t.includes("講師イー"), "講師の名前がない");
    assert.equal(findAll(region, (e) => e.type === Badge && text(e) === "講師").length, 1, "講師バッジが 1 つでない");
    assert.ok(t.includes("受講生無効化された受講生の返信"), `無効化済みの受講生の表示：${t}`);
  });

  it("email・userId・avatar など応答の他の項目を表示・属性に使わない", async () => {
    const m = await loaded(rows);
    for (const id of ["d1", "d2", "d3", "d4"]) click(threadButton(m.render(), id));
    const strings = allStrings(m.render()).join("\n");
    for (const s of [SECRET, "example.com", "u-secret-1", "u-secret-2", "a.png"]) {
      assert.ok(!strings.includes(s), `表示に出た：${s}`);
    }
  });

  it("見本データの残骸がない（ダミーの名前・本文・固定の件数をソースに持たない）", () => {
    assert.doesNotMatch(compSrc, /example\.com|@[\w-]+\.\w+/, "メールアドレスがある");
    assert.doesNotMatch(compSrc, /\b(name|content|author|title):\s*"/, "見本のオブジェクトがある");
    assert.doesNotMatch(compSrc, /chat-mock|mock|sample|dummy/i, "見本・モックへの参照がある");
    assert.doesNotMatch(compSrc, /useState\(\[\s*\{/, "見本の初期データがある");
  });

  it("pages の admin-questions は 1 つだけで、adminNav では「生徒管理」の次", () => {
    assert.equal(src.match(/"admin-questions":/g)?.length, 1, "pages の登録が 1 つでない");
    const nav = component("Sidebar");
    const ids = Array.from(nav.slice(nav.indexOf("const adminNav"), nav.indexOf("const nav =")).matchAll(/id: "([\w-]+)"/g), (x) => x[1]);
    assert.equal(ids[ids.indexOf("admin-students") + 1], "admin-questions", `adminNav の順：${ids.join(",")}`);
    assert.equal(ids.filter((x) => x === "admin-questions").length, 1);
  });

  it("生徒側の Questions は管理用の文言・回答欄・送信を持たない（質問対応に関わる変更を入れていない）", () => {
    // 次の部品（AdminQuestions）の見出しのコメントが末尾に入るので、行コメントを除いて調べる
    const q = component("Questions").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(q, /ADMIN_QUESTION_TABS|REPLY_SENT_MESSAGE|interpretReplyResponse|replaceThreadRow|toCourseOptions|\/api\/admin\//);
    assert.doesNotMatch(q, /回答を送信|質問対応/);
  });
});

describe("AdminQuestions 追加：送信結果が分からないときの再読み込み", () => {
  const RELOAD = "一覧を再読み込み";
  const reloadButtons = (tree: El) => buttons(tree).filter((b) => text(b).trim() === RELOAD);
  const regionOf = (tree: El, id: string) => findAll(tree, (e) => e.props.id === `admin-question-thread-${id}`);
  const lastList = (m: { reqs: Req[] }) => listReqs(m)[listReqs(m).length - 1];

  /** 「すべて」タブ（回答済みの行も一覧に残る）で t1 を開き、入力して送信した状態 */
  async function sentOnAll(value = "講師の回答です") {
    const m = await loaded();
    click(tab(m.render(), "すべて"));
    lastList(m).release(res(PAGE1));
    await settle();
    click(threadButton(m.render(), "t1"));
    change(textareaOf(m.render(), "t1"), value);
    click(sendButtonOf(m.render(), "t1"));
    assert.equal(replyReqs(m).length, 1, "送信していない");
    return m;
  }
  async function networkErrorOnAll() {
    const m = await sentOnAll();
    replyReqs(m)[0].fail(new TypeError("Failed to fetch"));
    await settle();
    return m;
  }

  it("通信エラー・2xx で別 id／読めない応答のときは、エラーの横に「一覧を再読み込み」が出る", async () => {
    const finishes: Array<(r: Req) => void> = [
      (r) => r.fail(new TypeError("Failed to fetch")),
      (r) => r.release(res({ thread: { ...answeredT1(), id: "t2" } }, { status: 201, url: REPLY_URL("t1") })),
      (r) => r.release(res(null, { status: 201, url: REPLY_URL("t1"), json: () => Promise.reject(new SyntaxError("x")) })),
      (r) => r.release(res(null, { status: 503, ok: false, url: REPLY_URL("t1"), json: () => Promise.reject(new SyntaxError("x")) })),
    ];
    for (const finish of finishes) {
      const m = await sentOnAll();
      finish(replyReqs(m)[0]);
      await settle();
      const tree = m.render();
      assert.equal(alertsOf(tree).length, 1, "エラーが 1 つでない");
      assert.ok(commentForm.isUncertainSubmitError(alertsOf(tree)[0]), `結果不明の文言でない：${alertsOf(tree)[0]}`);
      const region = regionOf(tree, "t1");
      assert.equal(reloadButtons(region[0]).length, 1, "t1 の欄に「一覧を再読み込み」がない");
      assert.equal(reloadButtons(region[0])[0].props.disabled, false, "「一覧を再読み込み」が押せない");
      // ボタンは alert の外に置く（読み上げる文言はエラーだけ）
      assert.equal(reloadButtons(byRole(tree, "alert")[0]).length, 0, "ボタンが alert の中にある");
    }
  });

  it("400 / 403 / 404 / 500 のエラーでは「一覧を再読み込み」を出さない", async () => {
    const cases: Array<Partial<FakeRes> & { body: unknown }> = [
      { status: 400, ok: false, body: { reason: "not_a_question" } },
      { status: 403, ok: false, body: { error: "Forbidden" } },
      { status: 404, ok: false, body: { error: "Not found" } },
      { status: 500, ok: false, body: { error: "x" } },
    ];
    for (const { body, ...p } of cases) {
      const m = await sentOnAll();
      replyReqs(m)[0].release(res(body, { ...p, url: REPLY_URL("t1") }));
      await settle();
      const tree = m.render();
      assert.equal(alertsOf(tree).length, 1, String(p.status));
      assert.equal(reloadButtons(tree).length, 0, `${p.status} で再読み込みのボタンが出た`);
    }
  });

  it("押すと今のタブ・コースの 1 ページ目を読み直し、連打しても 1 本だけ", async () => {
    const m = await loaded();
    click(tab(m.render(), "すべて"));
    lastList(m).release(res(PAGE1));
    await settle();
    change(courseSelect(m.render()), "co1");
    lastList(m).release(res(PAGE1));
    await settle();
    click(threadButton(m.render(), "t1"));
    change(textareaOf(m.render(), "t1"), "講師の回答です");
    click(sendButtonOf(m.render(), "t1"));
    replyReqs(m)[0].fail(new TypeError("Failed to fetch"));
    await settle();
    const tree = m.render();
    const before = listReqs(m).length;
    const b = reloadButtons(tree)[0];
    click(b);
    click(b);
    click(b);
    assert.equal(listReqs(m).length, before + 1, "連打で二重に読んだ");
    assert.equal(lastList(m).url, "/api/comments?courseId=co1", "今のタブ・コースで読み直していない");
    const during = m.render();
    assert.ok(text(during).includes("Loading..."), "読み込み中にならない");
    assert.equal(reloadButtons(during).length, 0, "読み込み中もボタンが残る");
  });

  it("再現：送信 → 通信エラー → 再読み込みで回答済み：エラーと書きかけを消し、「保存されていました」を出して行を開く", async () => {
    const m = await networkErrorOnAll();
    click(reloadButtons(m.render())[0]);
    lastList(m).release(res({ threads: [answeredT1(), PAGE1.threads[1]], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.deepEqual(alertsOf(tree), [], "エラーが残っている");
    assert.equal(regionOf(tree, "t1").length, 1, "判定した行が開いていない");
    assert.ok(text(regionOf(tree, "t1")[0]).includes(adminQuestions.REPLY_SAVED_AFTER_UNKNOWN_MESSAGE), "保存されていた旨がない");
    assert.ok(statusTexts(tree).includes(adminQuestions.REPLY_SAVED_AFTER_UNKNOWN_MESSAGE), "読み上げの知らせがない");
    assert.equal(textareaOf(tree, "t1").props.value, "", "書きかけが残っている（二重回答のおそれ）");
    assert.equal(sendButtonOf(tree, "t1").props.disabled, true, "空なのに送信できる");
    assert.equal(reloadButtons(tree).length, 0, "再読み込みのボタンが残っている");
    assert.ok(text(threadButton(tree, "t1")).includes("回答済み"), "回答済みの行でない");
    assert.equal(regionOf(tree, "t2").length, 0, "判定していない行まで開いた");
    // 書き始めると知らせは消える
    change(textareaOf(tree, "t1"), "追記");
    assert.ok(!text(regionOf(m.render(), "t1")[0]).includes(adminQuestions.REPLY_SAVED_AFTER_UNKNOWN_MESSAGE), "入力しても知らせが残る");
  });

  it("結果不明の間に回答欄を書き直していたら、保存されていたと分かっても書き直した内容は残し、「空にしました」とは言わない", async () => {
    const m = await networkErrorOnAll();
    // 書き直す前の描画の「一覧を再読み込み」を押す（応答のコールバックは古い描画の drafts を見る）
    const stale = m.render();
    change(textareaOf(stale, "t1"), "書き直した回答");
    click(reloadButtons(stale)[0]);
    lastList(m).release(res({ threads: [answeredT1(), PAGE1.threads[1]], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.deepEqual(alertsOf(tree), [], "エラーが残っている");
    assert.equal(textareaOf(tree, "t1").props.value, "書き直した回答", "書き直した内容が消えた");
    const region = text(regionOf(tree, "t1")[0]);
    assert.ok(region.includes(adminQuestions.REPLY_SAVED_DRAFT_KEPT_AFTER_UNKNOWN_MESSAGE), "残した旨の知らせがない");
    assert.ok(!region.includes(adminQuestions.REPLY_SAVED_AFTER_UNKNOWN_MESSAGE), "残したのに「空にしました」と出た");
    assert.ok(statusTexts(tree).includes(adminQuestions.REPLY_SAVED_DRAFT_KEPT_AFTER_UNKNOWN_MESSAGE), "読み上げの知らせがない");
    assert.equal(sendButtonOf(tree, "t1").props.disabled, false, "判定の後も送れない");
  });

  it("結果不明の間の書き直しが前後の空白だけなら、送った本文と同じとみなして消す", async () => {
    const m = await networkErrorOnAll();
    const stale = m.render();
    change(textareaOf(stale, "t1"), "\u3000講師の回答です\n");
    click(reloadButtons(stale)[0]);
    lastList(m).release(res({ threads: [answeredT1(), PAGE1.threads[1]], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.equal(textareaOf(tree, "t1").props.value, "", "送った本文と同じなのに残った（二重回答のおそれ）");
    assert.ok(text(regionOf(tree, "t1")[0]).includes(adminQuestions.REPLY_SAVED_AFTER_UNKNOWN_MESSAGE), "空にした旨の知らせがない");
  });

  it("再現：送信 → 通信エラー → 再読み込みで未回答のまま：「保存されていませんでした」に変え、書きかけを残して再送できる", async () => {
    const m = await networkErrorOnAll();
    click(reloadButtons(m.render())[0]);
    lastList(m).release(res(PAGE1));
    await settle();
    let tree = m.render();
    assert.deepEqual(alertsOf(tree), [adminQuestions.REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE]);
    assert.equal(regionOf(tree, "t1").length, 1, "判定した行が開いていない");
    assert.equal(textareaOf(tree, "t1").props.value, "講師の回答です", "書きかけが消えた");
    assert.equal(reloadButtons(tree).length, 0, "結果が分かったのに再読み込みのボタンが残る");
    assert.ok(!statusTexts(tree).includes(adminQuestions.REPLY_SAVED_AFTER_UNKNOWN_MESSAGE), "保存されていた知らせが出た");
    const b = sendButtonOf(tree, "t1");
    assert.equal(b.props.disabled, false, "再送できない");
    click(b);
    assert.equal(replyReqs(m).length, 2, "再送していない");
    assert.equal(replyReqs(m)[1].init?.body, replyReqs(m)[0].init?.body, "再送の本文が違う");
    tree = m.render();
    assert.deepEqual(alertsOf(tree), [], "再送中も前のエラーが残る");
    replyReqs(m)[1].release(res({ thread: answeredT1() }, { status: 201, url: REPLY_URL("t1") }));
    await settle();
    tree = m.render();
    assert.equal(textareaOf(tree, "t1").props.value, "");
    assert.ok(statusTexts(tree).includes(adminQuestions.REPLY_SENT_MESSAGE), "送信の知らせがない");
  });

  it("回答済みの質問への追加の回答：読み直して自分の同じ本文の回答が増えていなければ notSaved、増えていれば saved", async () => {
    // 送信前から t1 には自分の回答（別の本文）と別の講師の回答（同じ本文）がある
    const before = [
      { id: "r1", content: "前の回答です", createdAt: ago(60), author: { name: "講師ビー", isInstructor: true }, mine: true },
      { id: "r2", content: "追加の回答です", createdAt: ago(30), author: { name: "講師シー", isInstructor: true }, mine: false },
    ];
    const t1 = (replies: unknown[]) => thread("t1", { replies, replyCount: replies.length, answered: true });
    const added = { id: "r3", content: "追加の回答です", createdAt: ago(0), author: { name: "講師ビー", isInstructor: true }, mine: true };
    for (const [after, saved] of [[before, false], [[...before, added], true]] as const) {
      const m = await loaded();
      click(tab(m.render(), "すべて"));
      lastList(m).release(res({ threads: [t1(before), PAGE1.threads[1]], nextCursor: null }));
      await settle();
      click(threadButton(m.render(), "t1"));
      // 前後の空白はサーバーが除く（判定も除いた本文で数える）
      change(textareaOf(m.render(), "t1"), "  追加の回答です\n");
      click(sendButtonOf(m.render(), "t1"));
      replyReqs(m)[0].fail(new TypeError("Failed to fetch"));
      await settle();
      click(reloadButtons(m.render())[0]);
      lastList(m).release(res({ threads: [t1([...after]), PAGE1.threads[1]], nextCursor: null }));
      await settle();
      const tree = m.render();
      if (saved) {
        assert.deepEqual(alertsOf(tree), [], "増えたのにエラーが残る");
        assert.equal(textareaOf(tree, "t1").props.value, "", "増えたのに書きかけが残る");
        assert.ok(statusTexts(tree).includes(adminQuestions.REPLY_SAVED_AFTER_UNKNOWN_MESSAGE), "保存されていた知らせがない");
      } else {
        assert.deepEqual(alertsOf(tree), [adminQuestions.REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE], "回答済みというだけで保存されていたと判定した");
        assert.equal(textareaOf(tree, "t1").props.value, "  追加の回答です\n", "書きかけが消えた");
      }
    }
  });

  it("201 で別 id が返った後の再読み込みでも判定する（回答済み）", async () => {
    const m = await sentOnAll();
    replyReqs(m)[0].release(res({ thread: { ...answeredT1(), id: "t2" } }, { status: 201, url: REPLY_URL("t1") }));
    await settle();
    click(reloadButtons(m.render())[0]);
    lastList(m).release(res({ threads: [answeredT1(), PAGE1.threads[1]], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.deepEqual(alertsOf(tree), []);
    assert.equal(textareaOf(tree, "t1").props.value, "");
  });

  it("未回答タブで読み直して質問が一覧にないときは判定せず、エラーと書きかけを残す（「すべて」で読めば判定する）", async () => {
    const m = await typed("講師の回答です");
    click(button(m.render(), "回答を送信"));
    replyReqs(m)[0].fail(new TypeError("Failed to fetch"));
    await settle();
    click(reloadButtons(m.render())[0]);
    lastList(m).release(res({ threads: [PAGE1.threads[1]], nextCursor: null }));
    await settle();
    click(tab(m.render(), "すべて"));
    lastList(m).release(res(PAGE1));
    await settle();
    const tree = m.render();
    // 「すべて」の読み直しで未回答と分かった
    assert.deepEqual(alertsOf(tree), [adminQuestions.REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE]);
    assert.equal(textareaOf(tree, "t1").props.value, "講師の回答です");
  });

  /** 見える（sr-only でない）role=status のうち、中身のあるもの */
  const missingStatus = (tree: El) => byRole(tree, "status").filter((e) => e.props.className !== "sr-only" && text(e) !== "");

  it("未回答タブで読み直して質問が見つからないと、回答済みタブを案内する（見える role=status）。送信は止めたまま、回答済みタブで判定する", async () => {
    const m = await typed("講師の回答です");
    click(button(m.render(), "回答を送信"));
    replyReqs(m)[0].fail(new TypeError("Failed to fetch"));
    await settle();
    click(reloadButtons(m.render())[0]);
    lastList(m).release(res({ threads: [PAGE1.threads[1]], nextCursor: null }));
    await settle();
    let tree = m.render();
    const notice = adminQuestions.uncertainReplyMissingMessage("unanswered", false);
    assert.deepEqual(missingStatus(tree).map((e) => text(e)), [notice], "見える知らせがない");
    assert.ok(notice.includes("回答済みタブ"), "回答済みタブの案内がない");
    // 回答済みタブに t1 が出る：自分の回答が増えていたので保存されていた
    click(tab(tree, "回答済み"));
    tree = m.render();
    assert.deepEqual(missingStatus(tree).map((e) => text(e)), [], "読み込みを始めても前の知らせが残る");
    lastList(m).release(res({ threads: [answeredT1()], nextCursor: null }));
    await settle();
    tree = m.render();
    assert.deepEqual(missingStatus(tree).map((e) => text(e)), [], "判定した後も知らせが残る");
    assert.deepEqual(alertsOf(tree), []);
    assert.equal(textareaOf(tree, "t1").props.value, "", "書きかけが残る（二重回答のおそれ）");
    assert.ok(statusTexts(tree).includes(adminQuestions.REPLY_SAVED_AFTER_UNKNOWN_MESSAGE), "保存されていた知らせがない");
  });

  it("見つからない間は記録を残し、送信も止めたまま（タブを戻して行が出るまで送れない）", async () => {
    const m = await typed("講師の回答です");
    click(button(m.render(), "回答を送信"));
    replyReqs(m)[0].fail(new TypeError("Failed to fetch"));
    await settle();
    // 未回答で見つからない → 回答済みにもない（空）
    click(reloadButtons(m.render())[0]);
    lastList(m).release(res({ threads: [PAGE1.threads[1]], nextCursor: null }));
    await settle();
    click(tab(m.render(), "回答済み"));
    lastList(m).release(res({ threads: [], nextCursor: null }));
    await settle();
    // 続きのページがない（nextCursor が null）ので「もっと見る」は案内しない
    const answeredNotice = adminQuestions.uncertainReplyMissingMessage("answered", false);
    assert.deepEqual(missingStatus(m.render()).map((e) => text(e)), [answeredNotice]);
    assert.ok(!answeredNotice.includes("もっと見る"), "続きがないのに「もっと見る」を案内した");
    // 未回答に戻ると t1 が出る（読み直しで自分の回答は増えていない）→ 保存されていない可能性が高い
    click(tab(m.render(), "未回答"));
    lastList(m).release(res(PAGE1));
    await settle();
    const tree = m.render();
    assert.deepEqual(missingStatus(tree).map((e) => text(e)), []);
    assert.deepEqual(alertsOf(tree), [adminQuestions.REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE]);
    assert.equal(sendButtonOf(tree, "t1").props.disabled, false, "判定の後も送れない");
  });

  it("見つからない間は、判定前の古い描画の送信ボタンを押しても送らない（ref で止める）。もっと見るの続きにあれば判定する", async () => {
    const m = await networkErrorOnAll();
    const stale = m.render();
    click(reloadButtons(stale)[0]);
    lastList(m).release(res({ threads: [PAGE1.threads[1]], nextCursor: "c1" }));
    await settle();
    // 「すべて」の 1 ページ目にない：続きを案内する
    assert.deepEqual(missingStatus(m.render()).map((e) => text(e)), [adminQuestions.uncertainReplyMissingMessage("all", true)]);
    // 古い描画の送信ボタン（disabled の反映前）を押しても送らない
    click(button(stale, "回答を送信"));
    assert.equal(replyReqs(m).length, 1, "結果不明のまま再送した");
    // もっと見るの続きにはあった：判定し、知らせを消す。続きに無いことでは「見つからない」と知らせない
    click(button(m.render(), "もっと見る"));
    lastList(m).release(res({ threads: [answeredT1()], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.deepEqual(missingStatus(tree).map((e) => text(e)), [], "判定した後も知らせが残る");
    assert.deepEqual(alertsOf(tree), []);
  });

  it("もっと見るの続きに質問がなくても「見つからない」とは知らせない", async () => {
    const m = await loaded();
    click(tab(m.render(), "すべて"));
    lastList(m).release(res({ threads: [thread("t1")], nextCursor: "c1" }));
    await settle();
    click(threadButton(m.render(), "t1"));
    change(textareaOf(m.render(), "t1"), "講師の回答です");
    click(sendButtonOf(m.render(), "t1"));
    replyReqs(m)[0].fail(new TypeError("Failed to fetch"));
    await settle();
    click(button(m.render(), "もっと見る"));
    lastList(m).release(res({ threads: [thread("t9")], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.deepEqual(missingStatus(tree).map((e) => text(e)), []);
    assert.deepEqual(alertsOf(tree), [commentForm.COMMENT_NETWORK_ERROR_MESSAGE], "判定していないのにエラーが変わった");
  });

  it("フォーカス：保存されていたら結果の文言（tabIndex=-1）へ、保存されていなければ回答欄へ、1 回だけ移す", async () => {
    type FocusEl = { focus: () => void; count: number };
    const fakeEl = (): FocusEl => {
      const e = { count: 0, focus() { e.count++; } };
      return e;
    };
    const refOf = (el: El) => el.props.ref as (e: unknown) => void;
    for (const saved of [true, false]) {
      const m = await networkErrorOnAll();
      // 判定前は ref が呼ばれても移さない
      const pre = fakeEl();
      refOf(textareaOf(m.render(), "t1"))(pre);
      assert.equal(pre.count, 0, "判定前に移した");
      click(reloadButtons(m.render())[0]);
      lastList(m).release(res(saved ? { threads: [answeredT1(), PAGE1.threads[1]], nextCursor: null } : PAGE1));
      await settle();
      const tree = m.render();
      const notice = findAll(tree, (e) => e.props.id === "admin-question-reply-notice-t1");
      const target = saved ? notice[0] : textareaOf(tree, "t1");
      assert.ok(target, `移す先がない（saved: ${saved}）`);
      if (saved) {
        assert.equal(target.props.tabIndex, -1, "結果の文言にフォーカスできない");
        assert.ok(text(target).includes(adminQuestions.REPLY_SAVED_AFTER_UNKNOWN_MESSAGE), "結果の文言でない");
        // 回答欄には移さない
        const other = fakeEl();
        refOf(textareaOf(tree, "t1"))(other);
        assert.equal(other.count, 0, "回答欄にも移した");
      } else {
        assert.equal(notice.length, 0, "保存されていないのに知らせがある");
      }
      refOf(target)(null);
      const el = fakeEl();
      refOf(target)(el);
      assert.equal(el.count, 1, `移していない（saved: ${saved}）`);
      // 再描画でもう一度 ref が呼ばれても移さない
      refOf(target)(el);
      assert.equal(el.count, 1, "再描画のたびに移す");
    }
  });

  it("エラーより前に始めた読み込みの結果では判定しない（回答が保存される前の一覧かもしれない）", async () => {
    const m = await sentOnAll();
    // 送信中に読み込みを始める（タブを切り替えて戻る）
    click(tab(m.render(), "未回答"));
    click(tab(m.render(), "すべて"));
    replyReqs(m)[0].fail(new TypeError("Failed to fetch"));
    await settle();
    lastList(m).release(res(PAGE1));
    await settle();
    click(threadButton(m.render(), "t1"));
    let tree = m.render();
    assert.deepEqual(alertsOf(tree), [commentForm.COMMENT_NETWORK_ERROR_MESSAGE], "古い一覧で判定した");
    assert.equal(textareaOf(tree, "t1").props.value, "講師の回答です");
    // 改めて読み直せば判定する
    click(reloadButtons(tree)[0]);
    lastList(m).release(res({ threads: [answeredT1(), PAGE1.threads[1]], nextCursor: null }));
    await settle();
    tree = m.render();
    assert.deepEqual(alertsOf(tree), []);
    assert.equal(textareaOf(tree, "t1").props.value, "");
  });

  it("読み直しが失敗したら判定せず、成功したときに判定する", async () => {
    const m = await networkErrorOnAll();
    click(reloadButtons(m.render())[0]);
    lastList(m).release(res({ error: "x" }, { status: 500, ok: false }));
    await settle();
    click(button(m.render(), "再読み込み"));
    lastList(m).release(res({ threads: [answeredT1(), PAGE1.threads[1]], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.deepEqual(alertsOf(tree), []);
    assert.equal(textareaOf(tree, "t1").props.value, "");
  });

  it("「結果不明」以外のエラー（500）と、別の質問の書きかけは読み直しても変えない", async () => {
    const m = await loaded();
    click(tab(m.render(), "すべて"));
    lastList(m).release(res(PAGE1));
    await settle();
    click(threadButton(m.render(), "t1"));
    click(threadButton(m.render(), "t2"));
    change(textareaOf(m.render(), "t1"), "t1 への回答");
    change(textareaOf(m.render(), "t2"), "t2 の書きかけ");
    click(sendButtonOf(m.render(), "t1"));
    replyReqs(m)[0].release(res({ error: "x" }, { status: 500, ok: false, url: REPLY_URL("t1") }));
    await settle();
    click(tab(m.render(), "回答済み"));
    lastList(m).release(res({ threads: [], nextCursor: null }));
    await settle();
    click(tab(m.render(), "すべて"));
    lastList(m).release(res({ threads: [answeredT1(), thread("t2", { answered: true })], nextCursor: null }));
    await settle();
    click(threadButton(m.render(), "t1"));
    click(threadButton(m.render(), "t2"));
    const tree = m.render();
    assert.deepEqual(alertsOf(tree), [commentForm.COMMENT_SERVER_ERROR_MESSAGE], "500 のエラーが変わった");
    assert.equal(textareaOf(tree, "t1").props.value, "t1 への回答", "500 の後の書きかけが消えた");
    assert.equal(textareaOf(tree, "t2").props.value, "t2 の書きかけ", "別の質問の書きかけが消えた");
    assert.ok(!statusTexts(tree).includes(adminQuestions.REPLY_SAVED_AFTER_UNKNOWN_MESSAGE), "保存されていた知らせが出た");
  });

  it("「もっと見る」で読んだ続きに質問があれば判定する。続きの読み込み中は「一覧を再読み込み」を押せない", async () => {
    const m = await loaded();
    click(tab(m.render(), "すべて"));
    lastList(m).release(res({ threads: [thread("t1")], nextCursor: "c1" }));
    await settle();
    click(threadButton(m.render(), "t1"));
    change(textareaOf(m.render(), "t1"), "講師の回答です");
    click(sendButtonOf(m.render(), "t1"));
    replyReqs(m)[0].fail(new TypeError("Failed to fetch"));
    await settle();
    click(button(m.render(), "もっと見る"));
    const before = listReqs(m).length;
    const during = m.render();
    assert.equal(reloadButtons(during)[0].props.disabled, true, "続きの読み込み中に押せる");
    click(reloadButtons(during)[0]);
    assert.equal(listReqs(m).length, before, "続きの読み込み中に読み直した");
    // 続きのページに（並べ替わって）t1 が回答済みで入っていた
    lastList(m).release(res({ threads: [{ ...answeredT1(), id: "t1" }], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.deepEqual(alertsOf(tree), []);
    assert.equal(textareaOf(tree, "t1").props.value, "");
  });

  it("ソース：再読み込みのボタンは loadThreads(tab, courseId) を呼び、判定は lib の関数で行う", () => {
    assert.match(compSrc, /const awaitingCheck = isUncertainSubmitError\(replyError\);/);
    assert.match(compSrc, /\{awaitingCheck && \(\s*<Button[^>]*onClick=\{\(\) => loadThreads\(tab, courseId\)\} disabled=\{loading \|\| loadingMore\}/);
    assert.match(compSrc, /resolveUncertainReplies\(uncertainRef\.current, seq, rows\)/);
    assert.match(compSrc, /missingUncertainReplies\(uncertainRef\.current, seq, rows\)/);
    assert.match(compSrc, /if \(page\) \{ onPage\(page\); settleUncertainReplies\(page\.threads, seq, firstPageTab, page\.nextCursor !== null\); \}/);
    // 1 ページ目の読み込みだけがタブを渡す（もっと見るの続きでは「見つからない」と知らせない）
    assert.match(compSrc, /\(\) => setLoading\(false\),\s*forTab\s*\);/);
    assert.match(compSrc, /\(\) => setLoadingMore\(false\)\s*\);/);
  });
});

// ───────────── #86 テスト担当の追加：使えない文字（NUL・対になっていないサロゲート） ─────────────
// 見えない文字・サロゲートはソースに直接書かず、\u エスケープで書く

describe("AdminQuestions：#86 400 invalid_characters", () => {
  const INVALID_CHARS_MESSAGE = "使えない文字が含まれています。貼り付けた文章に特殊な文字が入っていないか確かめて、もう一度お試しください。";

  for (const [label, value] of [
    ["NUL を含む", "回答\u0000です"],
    ["上位サロゲートだけ", "回答\uD800です"],
    ["下位サロゲートだけ（先頭・前後に空白）", " \uDC00回答です\n"],
    ["逆順のサロゲート", "回答\uDE00\uD83D"],
  ] as Array<[string, string]>) {
    it(`${label}：送った後の 400 invalid_characters で専用の文言を出し、入力をそのまま残す`, async () => {
      const m = await typed(value);
      click(button(m.render(), "回答を送信"));
      assert.equal(replyReqs(m).length, 1, "送っていない");
      assert.deepEqual(JSON.parse(String(replyReqs(m)[0].init?.body)), { content: value }, "送った本文が入力と違う");
      replyReqs(m)[0].release(res({ error: "Invalid request", reason: "invalid_characters" }, { status: 400, ok: false, url: REPLY_URL("t1") }));
      await settle();
      const tree = m.render();
      assert.deepEqual(alertsOf(tree), [INVALID_CHARS_MESSAGE], "専用の文言が出ない");
      assert.equal(textarea(tree).props.value, value, "入力が消えた・変わった");
      assert.ok(!statusTexts(tree).includes(adminQuestions.REPLY_SENT_MESSAGE), "失敗なのに送信の知らせが出た");
    });
  }
});
