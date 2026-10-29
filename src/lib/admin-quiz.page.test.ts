import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import ts from "typescript";
import { classifyAuthFailure } from "./client-session";
import * as adminQuizView from "./admin-quiz-view";
import { parsePatchQuestionBody, planQuestionEdit } from "./admin-quizzes";
import {
  ADMIN_QUIZ_LIST_URL,
  EDIT_CONFLICT_MESSAGE,
  OPTIONS_CHANGE_NOTICE,
  QUIZ_DETAIL_LOAD_FAILED_MESSAGE,
  QUIZ_DETAIL_NOT_FOUND_MESSAGE,
  QUIZ_LIST_LOAD_FAILED_MESSAGE,
  SAVE_UNCERTAIN_MESSAGE,
  adminQuestionUrl,
  adminQuizDetailUrl,
  patchReasonMessage,
} from "./admin-quiz-view";

// #81 Q2 管理画面のクイズ管理：page.tsx（// @ts-nocheck）の AdminQuiz を
// 1. ソースで検査する（pages への登録、import の境界、authFetch、閉じたメソッドを使わない、ダイアログの作り）
// 2. typescript の transpileModule で JSX から変換し、偽の React で「描画」して表示・状態遷移・リクエスト・フォーカスを確かめる
//    （admin-questions.delete.page.test.ts と同じ器）
// DOM・DB・ネットワークなし。データはすべてダミー。
//
// 検証しないこと：setState による再描画（テストが render() を呼んだときだけ描画）、key の重複、CSS の見た目、
// ModalPortal の Portal 化（admin-dialog.page.test.ts と同じ形かはソースで確かめる）、autoFocus の実際の動き（属性があることだけ）。
// フォーカスは ref の要素と e.currentTarget（target()）の focus() の呼び出しで確かめる。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** `{cond && (` の直後から、対応する `)}` までを切り出す */
function conditionalBlock(body: string, cond: string): string {
  const head = `{${cond} && (`;
  const start = body.indexOf(head);
  assert.ok(start >= 0, `${head} が見つからない`);
  let depth = 1;
  for (let i = start + head.length; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return body.slice(start + head.length, i);
    }
  }
  assert.fail(`${head} の閉じかっこが見つからない`);
}

const compSrc = component("AdminQuiz");

// ───────────── ソースの検査 ─────────────

describe("AdminQuiz：配線", () => {
  it("pages の admin-quiz を AdminQuiz にし、準備中の表示をやめる", () => {
    assert.match(src, /"admin-quiz": <AdminQuiz \/>,/);
    assert.doesNotMatch(src, /<Placeholder title="クイズ管理"/);
    const sidebar = component("Sidebar");
    assert.match(sidebar, /\{ id: "admin-quiz", icon: HelpCircle, label: "クイズ管理" \}/);
  });

  it("画面用の lib から import し、revision の計算・DB の処理・node:crypto は import しない", () => {
    assert.match(src, /import \{[^}]*\} from "@\/lib\/admin-quiz-view";/);
    const specs = Array.from(src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g), (m) => m[1]);
    for (const s of specs) {
      assert.doesNotMatch(s, /admin-quiz-revision|admin-quiz-edit|^(node:)?crypto$/, `page.tsx が ${s} を import している`);
    }
  });

  it("API は authFetch で呼び、素の fetch・閉じたメソッドは使わない", () => {
    assert.match(compSrc, /authFetch\(ADMIN_QUIZ_LIST_URL\)/);
    assert.match(compSrc, /authFetch\(adminQuizDetailUrl\(id\)\)/);
    assert.match(compSrc, /authFetch\(adminQuestionUrl\(original\.id\), \{ method: "PATCH"/);
    assert.doesNotMatch(compSrc, /(?<![\w$.])fetch\s*\(/);
    assert.doesNotMatch(compSrc, /method:\s*"(?:POST|PUT|DELETE)"/);
  });

  it("保存中は ref で二重送信を止める（authFetch より前で判定し、finally で外す）", () => {
    const guard = compSrc.indexOf("if (sessionExpired.current || savingRef.current || !editing || !pendingEdit) return;");
    const set = compSrc.indexOf("savingRef.current = true;");
    const send = compSrc.indexOf("authFetch(adminQuestionUrl(");
    assert.ok(guard >= 0 && set > guard && send > set, "判定・印付け・送信の順になっていない");
    assert.match(compSrc, /finally \{\s*savingRef\.current = false;/);
  });

  it("Enter で送信しない：form にしない", () => {
    assert.doesNotMatch(compSrc, /<form\b|onSubmit/);
  });

  it("編集ダイアログは ModalPortal で包み、role=dialog・aria-modal・キャンセルの autoFocus を持つ", () => {
    const block = conditionalBlock(compSrc, "editing && draft").trim();
    assert.ok(block.startsWith("<ModalPortal>") && block.endsWith("</ModalPortal>"), "ModalPortal で包んでいない");
    const lines = block.split("\n").map((l) => l.trim());
    assert.match(lines[1], /^<div style=\{\{ position: "fixed", inset: 0,/);
    assert.match(lines[2], /role="dialog" aria-modal="true" aria-labelledby="nwa-quiz-edit-title"/);
    // 背景のクリックで閉じないので、本体でクリックを止める必要はない（stopPropagation を付けない）
    assert.doesNotMatch(block, /stopPropagation/);
    assert.match(lines[2], /maxHeight: "calc\(100dvh - 32px\)"/);
    assert.match(block, /<Button key="edit-cancel" variant="outline" autoFocus onClick=\{closeEdit\}/);
    assert.equal(compSrc.split('position: "fixed"').length - 1, 1, "fixed がダイアログの背景のほかにもある");
  });

  it("絵文字を使わない", () => {
    // tsconfig の target が ES5 のため、u フラグの正規表現はリテラルでなく RegExp で作る
    assert.doesNotMatch(compSrc, new RegExp("\\p{Extended_Pictographic}", "u"), "絵文字を使っている");
  });
});

// ───────────── 偽の React ─────────────

const transpiled = ts.transpileModule(compSrc, {
  fileName: "AdminQuiz.jsx",
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
const ModalPortal = stub("ModalPortal");
const COMPONENTS = {
  ScrollArea: stub("ScrollArea"),
  FadeIn: stub("FadeIn"),
  Button,
  Badge,
  ModalPortal,
  AlertTriangle: stub("AlertTriangle"),
  Pencil: stub("Pencil"),
  CheckCircle2: stub("CheckCircle2"),
  ArrowLeft: stub("ArrowLeft"),
  Plus: stub("Plus"),
  Trash2: stub("Trash2"),
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
  return { status: 200, ok: true, redirected: false, url: `${ORIGIN}/api/admin/quizzes`, json: () => Promise.resolve(body), ...p };
}
const notJson = (p: Partial<FakeRes> = {}): FakeRes => ({ ...res(null, p), json: () => Promise.reject(new SyntaxError("Unexpected token <")) });

type Req = { url: string; init?: RequestInit; release: (r: FakeRes) => void; fail: (e: unknown) => void };
type FakeTarget = { name: string; isConnected: boolean; focus: () => void };

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
  let focused: unknown = null;
  let attached: Array<{ ref: unknown; node: { isConnected: boolean } }> = [];
  const listeners = new Map<string, Set<(e: unknown) => void>>();

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
  const window = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => listeners.get(type)?.delete(fn),
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
    window,
    authFetch,
    classifyAuthFailure,
    ...adminQuizView,
    T,
    glassStyle: () => ({}),
    ...COMPONENTS,
  };
  const names = Object.keys(scope);
  const AdminQuiz = new Function(...names, `${compiled}\nreturn AdminQuiz;`)(...names.map((n) => scope[n])) as () => El;

  const render = (): El => {
    si = 0;
    ri = 0;
    ei = 0;
    pending = [];
    const tree = AdminQuiz();
    assertRenderable(tree);
    for (const { ref, node } of attached) {
      node.isConnected = false;
      if (typeof ref === "function") ref(null);
      else if (ref && typeof ref === "object") (ref as { current: unknown }).current = null;
    }
    attached = [];
    for (const el of findAll(tree, (e) => e.props.ref !== undefined && e.props.ref !== null)) {
      const node = { el, isConnected: true, focus: () => (focused = el) };
      const ref = el.props.ref;
      if (typeof ref === "function") ref(node);
      else (ref as { current: unknown }).current = node;
      attached.push({ ref, node });
    }
    for (const { i, fn, deps } of pending) {
      effectSlots[i]?.cleanup?.();
      const cleanup = fn();
      effectSlots[i] = { deps, cleanup: typeof cleanup === "function" ? (cleanup as () => void) : undefined };
    }
    return tree;
  };
  const key = (k: string) => {
    let prevented = false;
    for (const fn of Array.from(listeners.get("keydown") ?? new Set<(e: unknown) => void>())) fn({ key: k, preventDefault: () => (prevented = true) });
    return prevented;
  };
  const target = (name: string): FakeTarget => {
    const t: FakeTarget = { name, isConnected: true, focus: () => (focused = t) };
    return t;
  };
  return { render, reqs, key, target, focused: () => focused };
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
const buttonLabels = (tree: El) => buttons(tree).map((b) => String(b.props["aria-label"] ?? text(b).trim()));
function button(tree: El, label: string): El {
  const hit = buttons(tree).filter((b) => (b.props["aria-label"] ?? text(b).trim()) === label);
  assert.equal(hit.length, 1, `ボタン「${label}」が 1 つでない：${buttonLabels(tree).join(" / ")}`);
  return hit[0];
}
const hasButton = (tree: El, label: string) => buttons(tree).some((b) => (b.props["aria-label"] ?? text(b).trim()) === label);
const click = (b: El, currentTarget: unknown = null) => (b.props.onClick as (e?: unknown) => void)({ preventDefault() {}, currentTarget });
const byRole = (tree: El, role: string) => findAll(tree, (e) => e.props.role === role);
const dialogs = (tree: El) => byRole(tree, "dialog");
function dialog(tree: El): El {
  const d = dialogs(tree);
  assert.equal(d.length, 1, "ダイアログが 1 つでない");
  return d[0];
}
const statusText = (tree: El) => byRole(tree, "status").map((e) => text(e)).join("\n");
const change = (el: El, value: string) => (el.props.onChange as (e: unknown) => void)({ target: { value } });
const byLabel = (tree: El, label: string) => {
  const hit = findAll(tree, (e) => e.props["aria-label"] === label);
  assert.equal(hit.length, 1, `「${label}」が 1 つでない`);
  return hit[0];
};
const questionInput = (tree: El) => {
  const hit = findAll(tree, (e) => e.type === "textarea" && e.props.id === "nwa-quiz-edit-question");
  assert.equal(hit.length, 1, "問題文の入力欄が 1 つでない");
  return hit[0];
};
const radios = (tree: El) => findAll(tree, (e) => e.type === "input" && e.props.type === "radio");
/** ラジオを選ぶ（onChange を呼ぶ） */
const pick = (radio: El) => (radio.props.onChange as () => void)();
const optionInputs = (tree: El) => findAll(tree, (e) => e.type === "input" && e.props.type === "text");
const badges = (n: El) => findAll(n, (e) => e.type === Badge).map((b) => text(b));
const jsonBody = (r: Req) => JSON.parse(String(r.init?.body));

// ───────────── データ（ダミー） ─────────────

const REV = "a".repeat(64);
const REV2 = "b".repeat(64);
const REV3 = "c".repeat(64);

const LIST = {
  quizzes: [
    { id: "f1", title: "修了テスト ダミー", type: "FINAL", courseId: "co1", courseName: "STEP1 ダミー", lessonTitle: null, questionCount: 5, attemptCount: 0, status: "ok" },
    { id: "m1", title: "ミニテスト ダミー", type: "MINI", courseId: "co1", courseName: "STEP1 ダミー", lessonTitle: "レッスン1 ダミー", questionCount: 2, attemptCount: 3, status: "unavailable" },
    { id: "o1", title: "迷子のテスト", type: "FINAL", courseId: null, courseName: null, lessonTitle: null, questionCount: 1, attemptCount: 0, status: "no_course" },
  ],
};

const q = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  order: 1,
  question: `${id} の問題文`,
  options: ["選択肢A", "選択肢B", "選択肢C"],
  correctIndex: 1,
  valid: true,
  revision: REV,
  ...over,
});

// 応答はわざと [order, id] の順にしない（画面が並べ直すことを確かめる）
const DETAIL = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  title: "ミニテスト ダミー",
  type: "MINI",
  courseName: "STEP1 ダミー",
  lessonTitle: "レッスン1 ダミー",
  attemptCount: 3,
  status: "unavailable",
  questions: [q("qb", { order: 2 }), q("qa", { order: 1, correctIndex: 5, valid: false })],
  ...over,
});

async function listed(body: unknown = LIST) {
  const m = mount();
  m.render();
  assert.equal(m.reqs.length, 1, "最初の読み込みが 1 本でない");
  m.reqs[0].release(res(body));
  await settle();
  return m;
}

/** 一覧からクイズ m1 を開き、詳細を読み込んだ状態 */
async function opened(detailBody: unknown = DETAIL()) {
  const m = await listed();
  click(button(m.render(), "ミニテスト ダミー"));
  const r = m.reqs[m.reqs.length - 1];
  assert.equal(r.url, adminQuizDetailUrl("m1"));
  r.release(res(detailBody));
  await settle();
  return m;
}

/** 詳細の問題 n（1 から）の編集ダイアログを開いた状態。trigger は押したボタンの代わり */
async function editing(n = 2, detailBody: unknown = DETAIL()) {
  const m = await opened(detailBody);
  const trigger = m.target(`edit-${n}`);
  click(button(m.render(), `問題 ${n} を編集`), trigger);
  return { m, trigger };
}

/** ダイアログの「保存」→ 確認の段の「保存する」まで進め、PATCH のリクエストを返す */
function saveFromDialog(m: ReturnType<typeof mount>): Req {
  click(button(m.render(), "保存"));
  const before = m.reqs.length;
  click(button(m.render(), "保存する"));
  assert.equal(m.reqs.length, before + 1, "PATCH を送っていない");
  return m.reqs[m.reqs.length - 1];
}

// ───────────── 描画 ─────────────

describe("AdminQuiz 描画：前提", () => {
  it("JSX の変換：診断なしで、import / export を含まない", () => {
    assert.deepEqual(transpiled.diagnostics ?? [], []);
    assert.doesNotMatch(compiled, /^\s*(import|export)\b/m);
  });
});

describe("AdminQuiz 描画：一覧", () => {
  it("最初は読み込み中で、一覧を 1 回だけ読む（再描画で読み直さない）", () => {
    const m = mount();
    const tree = m.render();
    assert.ok(text(tree).includes("Loading..."), "読み込み中が出ていない");
    assert.deepEqual(m.reqs.map((r) => [r.url, r.init]), [[ADMIN_QUIZ_LIST_URL, undefined]]);
    m.render();
    assert.equal(m.reqs.length, 1, "再描画で読み直した");
  });

  it("コースごとの表：種類・タイトル・レッスン名（ミニテストだけ）・問題数・受験数。コースなしは最後", async () => {
    const m = await listed();
    const tree = m.render();
    const sections = findAll(tree, (e) => e.type === "section");
    assert.deepEqual(sections.map((s) => text(findAll(s, (e) => e.type === "h3")[0])), ["STEP1 ダミー", "コースなし"]);
    const heads = findAll(sections[0], (e) => e.type === "th").map((e) => text(e));
    assert.deepEqual(heads, ["種類", "タイトル", "レッスン", "問題数", "受験数"]);
    const rows = findAll(sections[0], (e) => e.type === "tr").slice(1);
    const cells = (r: El) => findAll(r, (e) => e.type === "td").map((c) => text(c));
    assert.deepEqual(cells(rows[0]), ["修了テスト", "修了テスト ダミー", "—", "5", "0"]);
    assert.deepEqual(cells(rows[1]), ["ミニテスト", "ミニテスト ダミー受験できない", "レッスン1 ダミー", "2", "3"]);
  });

  it("unavailable は「受験できない」、no_course は「コースなし」のバッジ。ok はバッジなし", async () => {
    const m = await listed();
    const sections = findAll(m.render(), (e) => e.type === "section");
    const rows = (s: El) => findAll(s, (e) => e.type === "tr").slice(1);
    assert.deepEqual(rows(sections[0]).map(badges), [[], ["受験できない"]]);
    assert.deepEqual(rows(sections[1]).map(badges), [["コースなし"]]);
  });

  it("空の一覧は案内を出す", async () => {
    const m = await listed({ quizzes: [] });
    assert.ok(text(m.render()).includes("クイズはまだありません"), "空の案内がない");
  });

  it("失敗（500）は role=alert と再読み込み。押すと読み直し、読み込み中の連打では読まない", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res({ error: "Internal server error" }, { status: 500, ok: false }));
    await settle();
    const tree = m.render();
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1);
    assert.ok(text(alerts[0]).includes(QUIZ_LIST_LOAD_FAILED_MESSAGE), "失敗の文言がない");
    click(button(tree, "再読み込み"));
    click(button(tree, "再読み込み"));
    assert.deepEqual(m.reqs.map((r) => r.url), [ADMIN_QUIZ_LIST_URL, ADMIN_QUIZ_LIST_URL], "読み込み中に二重に読んだ");
    m.reqs[1].release(res(LIST));
    await settle();
    assert.equal(byRole(m.render(), "alert").length, 0, "読み直しても失敗のまま");
  });

  it("通信エラー・形の違う本文・ログイン以外へのリダイレクトも失敗", async () => {
    const cases: Array<(r: Req) => void> = [
      (r) => r.fail(new Error("network")),
      (r) => r.release(res([])),
      (r) => r.release(res({ quizzes: [{ id: "x" }] })),
      (r) => r.release(notJson()),
      (r) => r.release(res(LIST, { redirected: true, url: `${ORIGIN}/somewhere` })),
    ];
    for (const settleWith of cases) {
      const m = mount();
      m.render();
      settleWith(m.reqs[0]);
      await settle();
      assert.equal(byRole(m.render(), "alert").length, 1);
    }
  });

  it("セッション切れ（401・/login へのリダイレクト）は失敗にせず読み込み中のまま", async () => {
    for (const r of [res(null, { status: 401, ok: false }), res("<html>", { redirected: true, url: `${ORIGIN}/login` })]) {
      const m = mount();
      m.render();
      m.reqs[0].release(r);
      await settle();
      const tree = m.render();
      assert.equal(byRole(tree, "alert").length, 0, "セッション切れを失敗として出した");
      assert.ok(text(tree).includes("Loading..."), "読み込み中のままでない");
      assert.equal(m.reqs.length, 1);
    }
  });
});

describe("AdminQuiz 描画：詳細", () => {
  it("行のタイトルから開き、詳細の見出しへフォーカスを移す。問題は [order, id] の順", async () => {
    const m = await listed();
    click(button(m.render(), "ミニテスト ダミー"));
    let tree = m.render();
    assert.ok(text(tree).includes("Loading..."), "詳細の読み込み中が出ていない");
    assert.deepEqual(m.reqs.map((r) => [r.url, r.init]).slice(1), [[adminQuizDetailUrl("m1"), undefined]]);
    const heading = findAll(tree, (e) => e.type === "h2" && e.props.tabIndex === -1)[0];
    assert.equal((m.focused() as { type: string; children: Node[] }).type, "h2", "詳細の見出しへフォーカスを移していない");
    assert.equal(text(heading), "ミニテスト ダミー の詳細");
    m.reqs[1].release(res(DETAIL()));
    await settle();
    tree = m.render();
    assert.ok(hasButton(tree, "問題 1 を編集") && hasButton(tree, "問題 2 を編集"), "編集ボタンがない");
    const cards = findAll(tree, (e) => e.type === "ol" || (e.type === "div" && typeof e.props.style === "object" && e.props.style !== null && "borderLeft" in (e.props.style as object)));
    const firstCard = cards.find((c) => text(c).startsWith("問題 1"));
    assert.ok(firstCard && text(firstCard).includes("qa の問題文"), "order の小さい問題が先頭にない");
  });

  it("選択肢は元の並びで、正解に「正解」の印。valid: false の問題には警告", async () => {
    const m = await opened();
    const tree = m.render();
    const lists = findAll(tree, (e) => e.type === "ol");
    assert.equal(lists.length, 2);
    const items = (ol: El) => findAll(ol, (e) => e.type === "li");
    // 問題 1（qa）は正解が範囲外：印なし、警告あり
    assert.deepEqual(items(lists[0]).map((li) => [text(li), badges(li)]), [["選択肢A", []], ["選択肢B", []], ["選択肢C", []]]);
    // 問題 2（qb）は正解が B
    assert.deepEqual(items(lists[1]).map((li) => [text(li), badges(li)]), [["選択肢A", []], ["選択肢B正解", ["正解"]], ["選択肢C", []]]);
    assert.ok(text(tree).includes(adminQuizView.CORRECT_OUT_OF_RANGE_WARNING), "範囲外の正解の警告がない");
    assert.equal(text(tree).split(adminQuizView.CORRECT_OUT_OF_RANGE_WARNING).length - 1, 1, "警告が valid の問題にも出ている");
  });

  it("選択肢が壊れた問題は選択肢を出さずに警告。状態のバッジと説明を見出しに出す", async () => {
    const m = await opened(DETAIL({ questions: [q("qa", { options: null, valid: false })] }));
    const tree = m.render();
    assert.equal(findAll(tree, (e) => e.type === "ol").length, 0);
    assert.ok(text(tree).includes(adminQuizView.BROKEN_OPTIONS_WARNING), "壊れた選択肢の警告がない");
    assert.ok(badges(tree).includes("受験できない"), "状態のバッジがない");
    assert.ok(text(tree).includes("ミニテスト · STEP1 ダミー · レッスン1 ダミー · 問題 1 問 · 受験 3 件"), "見出しの下の 1 行がない");
  });

  it("失敗は role=alert と再読み込み、404 は見つからない文言", async () => {
    const m = await listed();
    click(button(m.render(), "ミニテスト ダミー"));
    m.reqs[1].release(res(null, { status: 500, ok: false }));
    await settle();
    let tree = m.render();
    assert.ok(text(byRole(tree, "alert")[0]).includes(QUIZ_DETAIL_LOAD_FAILED_MESSAGE), "失敗の文言がない");
    click(button(tree, "再読み込み"));
    assert.equal(m.reqs[2].url, adminQuizDetailUrl("m1"));
    m.reqs[2].release(res(null, { status: 404, ok: false }));
    await settle();
    tree = m.render();
    assert.ok(text(byRole(tree, "alert")[0]).includes(QUIZ_DETAIL_NOT_FOUND_MESSAGE), "404 の文言がない");
    // 別のクイズの応答（id が違う）も失敗
    const m2 = await listed();
    click(button(m2.render(), "ミニテスト ダミー"));
    m2.reqs[1].release(res(DETAIL({ id: "other" })));
    await settle();
    assert.ok(text(byRole(m2.render(), "alert")[0]).includes(QUIZ_DETAIL_LOAD_FAILED_MESSAGE), "別のクイズの応答を表示した");
  });

  it("「一覧に戻る」で一覧に戻り、開いたクイズのタイトルへフォーカスを戻す（保存していなければ読み直さない）", async () => {
    const m = await opened();
    click(button(m.render(), "一覧に戻る"));
    const tree = m.render();
    const title = button(tree, "ミニテスト ダミー");
    assert.equal(m.focused(), title, "タイトルのボタンへフォーカスを戻していない");
    assert.equal(m.reqs.length, 2, "保存していないのに一覧を読み直した");
  });

  it("閉じたあとに届いた詳細の応答は捨てる", async () => {
    const m = await listed();
    click(button(m.render(), "ミニテスト ダミー"));
    m.render();
    click(button(m.render(), "一覧に戻る"));
    m.reqs[1].release(res(DETAIL()));
    await settle();
    const tree = m.render();
    assert.ok(findAll(tree, (e) => e.type === "section").length > 0, "一覧に戻っていない");
    assert.equal(hasButton(tree, "問題 1 を編集"), false, "閉じたあとの応答を表示した");
  });

  it("詳細の読み込みでセッションが切れたら読み込み中のまま。その後は読まない", async () => {
    const m = await listed();
    click(button(m.render(), "ミニテスト ダミー"));
    m.reqs[1].release(res(null, { status: 401, ok: false }));
    await settle();
    let tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.ok(text(tree).includes("Loading..."), "読み込み中のままでない");
    click(button(tree, "一覧に戻る"));
    tree = m.render();
    click(button(tree, "修了テスト ダミー"));
    m.render();
    assert.equal(m.reqs.length, 2, "セッション切れの後に読んだ");
  });
});

describe("AdminQuiz 描画：編集ダイアログ", () => {
  it("「編集」で role=dialog・aria-modal のダイアログを ModalPortal の中に開き、キャンセルに autoFocus", async () => {
    const { m } = await editing(2);
    const tree = m.render();
    const d = dialog(tree);
    assert.equal(d.props["aria-modal"], "true");
    assert.equal(findAll(tree, (e) => e.type === ModalPortal).length, 1, "ModalPortal で包んでいない");
    assert.equal(text(findAll(d, (e) => e.type === "h3")[0]), "問題 2 を編集");
    assert.equal(button(d, "キャンセル").props.autoFocus, true, "キャンセルに autoFocus がない");
    // 入力欄：問題文・選択肢の文・正解のラジオ
    assert.equal(questionInput(d).props.value, "qb の問題文");
    assert.deepEqual(optionInputs(d).map((i) => i.props.value), ["選択肢A", "選択肢B", "選択肢C"]);
    assert.deepEqual(radios(d).map((r) => r.props.checked), [false, true, false]);
    // 背後の編集ボタン・一覧に戻るは押せない
    assert.equal(button(tree, "問題 1 を編集").props.disabled, true);
    assert.equal(button(tree, "一覧に戻る").props.disabled, true);
  });

  it("キャンセル・Esc で閉じ、開いたボタンにフォーカスを戻す。背景のクリックでは閉じない", async () => {
    const { m, trigger } = await editing(2);
    click(button(m.render(), "キャンセル"));
    m.render();
    assert.equal(dialogs(m.render()).length, 0, "キャンセルで閉じない");
    assert.equal(m.focused(), trigger, "開いたボタンにフォーカスが戻らない");

    const e2 = await editing(1);
    const tree = e2.m.render();
    const backdrop = findAll(tree, (e) => e.type === "div" && typeof e.props.style === "object" && (e.props.style as Record<string, unknown>).position === "fixed")[0];
    assert.equal(backdrop.props.onClick, undefined, "背景のクリックで閉じる（下書きを失う）");
    assert.equal(e2.m.key("Escape"), true, "Esc を扱っていない");
    e2.m.render();
    assert.equal(dialogs(e2.m.render()).length, 0, "Esc で閉じない");
    assert.equal(e2.m.focused(), e2.trigger, "Esc のあと開いたボタンにフォーカスが戻らない");
  });

  it("何も変えていなければ「保存」は押せない", async () => {
    const { m } = await editing(2);
    const save = button(dialog(m.render()), "保存");
    assert.equal(save.props.disabled, true);
    assert.ok(text(m.render()).includes(adminQuizView.EDIT_UNCHANGED_MESSAGE), "変更がない案内がない");
  });

  it("選択肢の追加・削除は 2〜10 件", async () => {
    const { m } = await editing(2);
    for (let i = 0; i < 10; i++) click(button(m.render(), "選択肢を追加"));
    let d = dialog(m.render());
    assert.equal(optionInputs(d).length, 10);
    assert.equal(button(d, "選択肢を追加").props.disabled, true, "10 件で追加を止めていない");
    for (let i = 10; i > 2; i--) click(button(m.render(), `選択肢 ${i} を削除`));
    d = dialog(m.render());
    assert.equal(optionInputs(d).length, 2);
    assert.equal(button(d, "選択肢 1 を削除").props.disabled, true, "2 件で削除を止めていない");
  });

  it("確認文：選択肢を変え、受験記録があるときは両方を出す。確認の段は「戻る」に autoFocus", async () => {
    const { m } = await editing(2);
    change(byLabel(m.render(), "選択肢 1"), "直したA");
    click(button(m.render(), "保存"));
    const d = dialog(m.render());
    assert.equal(d.props["aria-describedby"], "nwa-quiz-edit-confirm");
    const t = text(d);
    assert.ok(t.includes(OPTIONS_CHANGE_NOTICE), "選択肢の注意がない");
    assert.ok(t.includes("過去の受験 3 件の点数・合否は変わりません"), "過去の受験の注意がない");
    assert.ok(t.includes("変更する項目：選択肢"), "変更する項目がない");
    assert.equal(button(d, "戻る").props.autoFocus, true, "戻るに autoFocus がない");
    assert.equal(m.reqs.length, 2, "確認の前に送った");
    // 戻ると入力が残っている
    click(button(d, "戻る"));
    assert.equal(byLabel(m.render(), "選択肢 1").props.value, "直したA");
  });

  it("確認文：問題文だけ・受験記録 0 件なら注意を出さない。正解だけなら過去の受験の注意だけ", async () => {
    const a = await editing(2, DETAIL({ attemptCount: 0 }));
    change(questionInput(a.m.render()), "直した問題文");
    click(button(a.m.render(), "保存"));
    let t = text(dialog(a.m.render()));
    assert.ok(!t.includes(OPTIONS_CHANGE_NOTICE) && !t.includes("過去の受験"), "要らない注意を出した");
    assert.ok(t.includes("変更する項目：問題文"), "変更する項目がない");

    const b = await editing(2);
    pick(radios(dialog(b.m.render()))[2]);
    click(button(b.m.render(), "保存"));
    t = text(dialog(b.m.render()));
    assert.ok(!t.includes(OPTIONS_CHANGE_NOTICE), "正解だけなのに選択肢の注意を出した");
    assert.ok(t.includes("過去の受験 3 件の点数・合否は変わりません"), "過去の受験の注意がない");
    assert.ok(t.includes("変更する項目：正解"), "変更する項目がない");
  });

  it("入力の誤りは保存の前にダイアログで知らせる（送らない）", async () => {
    const { m } = await editing(2);
    change(byLabel(m.render(), "選択肢 1"), "選択肢B");
    click(button(m.render(), "保存"));
    const d = dialog(m.render());
    assert.ok(text(byRole(d, "alert")[0]).includes(patchReasonMessage("invalid_options")), "重複の文言がない");
    assert.equal(hasButton(d, "保存する"), false, "確認の段へ進んだ");
    assert.equal(m.reqs.length, 2, "送った");
  });
});

describe("AdminQuiz 描画：保存", () => {
  it("選択肢に上下の並べ替えボタンを出さない（#79 で受講生には毎回シャッフルして出すため。Tec 指示）", async () => {
    const { m } = await editing(2);
    const d = dialog(m.render());
    for (let i = 1; i <= 3; i++) {
      assert.equal(hasButton(d, `選択肢 ${i} を上へ`), false, `選択肢 ${i} を上へ のボタンがある`);
      assert.equal(hasButton(d, `選択肢 ${i} を下へ`), false, `選択肢 ${i} を下へ のボタンがある`);
    }
  });

  it("正解より前の選択肢の削除：PATCH で、正解の位置を詰めて変わった項目と revision だけを送る", async () => {
    const { m } = await editing(2);
    click(button(m.render(), "選択肢 1 を削除"));
    assert.deepEqual(radios(dialog(m.render())).map((r) => r.props.checked), [true, false], "正解の印が選択肢についていかない");
    const r = saveFromDialog(m);
    assert.equal(r.url, adminQuestionUrl("qb"));
    assert.equal(r.init?.method, "PATCH");
    assert.deepEqual(jsonBody(r), { revision: REV, options: ["選択肢B", "選択肢C"], correctIndex: 0 });
  });

  it("確認の段の Esc は入力の段に戻り、下書きを残す（ダイアログは閉じない）。入力の段の Esc で閉じる", async () => {
    const { m, trigger } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    change(byLabel(m.render(), "選択肢 1"), "直したA");
    click(button(m.render(), "保存"));
    assert.ok(hasButton(dialog(m.render()), "保存する"), "確認の段へ進んでいない（前提）");
    assert.equal(m.key("Escape"), true, "Esc を扱っていない");
    let d = dialog(m.render());
    assert.equal(hasButton(d, "保存する"), false, "確認の段のまま");
    assert.equal(button(d, "キャンセル").props.autoFocus, true, "入力の段のキャンセルに autoFocus がない");
    assert.equal(questionInput(d).props.value, "直した問題文", "問題文の下書きを残していない");
    assert.equal(byLabel(d, "選択肢 1").props.value, "直したA", "選択肢の下書きを残していない");
    assert.equal(m.reqs.length, 2, "Esc で送った");
    // もう一度確認へ進めば、同じ内容で送れる
    click(button(m.render(), "保存"));
    d = dialog(m.render());
    assert.ok(hasButton(d, "保存する"), "もう一度確認の段へ進めない");
    m.key("Escape");
    m.render();
    m.key("Escape");
    m.render();
    assert.equal(dialogs(m.render()).length, 0, "入力の段の Esc で閉じない");
    assert.equal(m.focused(), trigger, "閉じたあと開いたボタンにフォーカスが戻らない");
  });

  it("二重送信を防ぐ：保存中の連打では送らず、ボタンは disabled。Esc・キャンセルでも閉じない", async () => {
    const { m } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    click(button(m.render(), "保存"));
    const save = button(dialog(m.render()), "保存する");
    click(save);
    click(save);
    assert.equal(m.reqs.length, 3, "二重に送った");
    const d = dialog(m.render());
    assert.equal(button(d, "保存中...").props.disabled, true);
    assert.equal(button(d, "戻る").props.disabled, true);
    m.key("Escape");
    assert.equal(dialogs(m.render()).length, 1, "保存中に Esc で閉じた");
    assert.ok(hasButton(dialog(m.render()), "保存中..."), "保存中に Esc で入力の段に戻った");
  });

  it("成功：閉じてフォーカスを戻し、role=status で知らせ、新しい revision で次の編集を送る", async () => {
    const { m, trigger } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    const r = saveFromDialog(m);
    assert.deepEqual(jsonBody(r), { revision: REV, question: "直した問題文" });
    r.release(res({ question: q("qb", { order: 2, question: "直した問題文", revision: REV2 }), changed: ["question"], inProgressInvalidated: false, attemptCount: 4 }, { url: `${ORIGIN}/api/admin/questions/qb` }));
    await settle();
    let tree = m.render();
    assert.equal(dialogs(tree).length, 0, "閉じていない");
    tree = m.render();
    assert.equal(m.focused(), trigger, "開いたボタンにフォーカスが戻らない");
    assert.ok(statusText(tree).includes("問題 2 を保存しました（問題文）"), "保存の知らせがない");
    assert.ok(text(tree).includes("直した問題文"), "詳細を置き換えていない");
    assert.ok(text(tree).includes("受験 4 件"), "受験数を応答の値にしていない");
    assert.equal(m.reqs.length, 3, "成功のあとに読み直した");
    // 次の編集は新しい revision
    click(button(tree, "問題 2 を編集"), m.target("again"));
    change(questionInput(m.render()), "もう一度直した");
    const r2 = saveFromDialog(m);
    assert.equal(jsonBody(r2).revision, REV2);
  });

  it("成功のあと一覧に戻ると、一覧を読み直す", async () => {
    const { m } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    const r = saveFromDialog(m);
    r.release(res({ question: q("qb", { order: 2, question: "直した問題文", revision: REV2 }), changed: ["question"], inProgressInvalidated: false, attemptCount: 3 }));
    await settle();
    m.render();
    click(button(m.render(), "一覧に戻る"));
    m.render();
    assert.equal(m.reqs[m.reqs.length - 1].url, ADMIN_QUIZ_LIST_URL, "一覧を読み直していない");
  });

  it("409 edit_conflict：閉じて知らせ、詳細を読み直す（表示は残したまま）", async () => {
    const { m, trigger } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    const r = saveFromDialog(m);
    r.release(res({ error: "Conflict", reason: "edit_conflict" }, { status: 409, ok: false }));
    await settle();
    let tree = m.render();
    assert.equal(dialogs(tree).length, 0, "閉じていない");
    assert.ok(statusText(tree).includes(EDIT_CONFLICT_MESSAGE), "409 の知らせがない");
    const reload = m.reqs[m.reqs.length - 1];
    assert.equal(reload.url, adminQuizDetailUrl("m1"), "詳細を読み直していない");
    assert.ok(hasButton(tree, "問題 2 を編集"), "読み直しの間に詳細を消した");
    tree = m.render();
    assert.equal(m.focused(), trigger, "開いたボタンにフォーカスが戻らない");
    // 読み直しの間は編集を開かない
    click(button(tree, "問題 2 を編集"), m.target("x"));
    assert.equal(dialogs(m.render()).length, 0, "読み直しの間に編集を開いた");
    reload.release(res(DETAIL({ questions: [q("qb", { order: 2, question: "他の講師の問題文", revision: REV3 })] })));
    await settle();
    tree = m.render();
    assert.ok(text(tree).includes("他の講師の問題文"), "最新の内容を出していない");
    click(button(tree, "問題 1 を編集"), m.target("y"));
    change(questionInput(m.render()), "上書き");
    assert.equal(jsonBody(saveFromDialog(m)).revision, REV3, "最新の revision で送っていない");
  });

  it("通信エラー：閉じて「保存できたか確認できません」と知らせ、詳細を読み直す。読み直しの失敗は表示を残して知らせる", async () => {
    const { m } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    const r = saveFromDialog(m);
    r.fail(new TypeError("Failed to fetch"));
    await settle();
    let tree = m.render();
    assert.equal(dialogs(tree).length, 0, "閉じていない");
    assert.ok(statusText(tree).includes(SAVE_UNCERTAIN_MESSAGE), "結果不明の知らせがない");
    const reload = m.reqs[m.reqs.length - 1];
    assert.equal(reload.url, adminQuizDetailUrl("m1"));
    reload.fail(new TypeError("Failed to fetch"));
    await settle();
    tree = m.render();
    assert.ok(hasButton(tree, "問題 2 を編集"), "読み直しに失敗して詳細を消した");
    assert.ok(text(byRole(tree, "alert")[0]).includes(adminQuizView.QUIZ_REFRESH_FAILED_MESSAGE), "読み直しの失敗を知らせていない");
    click(button(tree, "再読み込み"));
    assert.equal(m.reqs[m.reqs.length - 1].url, adminQuizDetailUrl("m1"));
  });

  it("502・2xx で本文を読めないときも結果不明として読み直す", async () => {
    for (const reply of [res(null, { status: 502, ok: false }), notJson()]) {
      const { m } = await editing(2);
      change(questionInput(m.render()), "直した問題文");
      saveFromDialog(m).release(reply);
      await settle();
      const tree = m.render();
      assert.ok(statusText(tree).includes(SAVE_UNCERTAIN_MESSAGE), "結果不明の知らせがない");
      assert.equal(m.reqs[m.reqs.length - 1].url, adminQuizDetailUrl("m1"), "読み直していない");
    }
  });

  it("400：reason の文言をダイアログに出し、入力の段に戻って下書きを残す（読み直さない）", async () => {
    const { m } = await editing(2);
    change(byLabel(m.render(), "選択肢 1"), "直したA");
    saveFromDialog(m).release(res({ error: "Invalid request", reason: "invalid_options" }, { status: 400, ok: false }));
    await settle();
    const d = dialog(m.render());
    assert.ok(text(byRole(d, "alert")[0]).includes(patchReasonMessage("invalid_options")), "reason の文言がない");
    assert.equal(byLabel(d, "選択肢 1").props.value, "直したA", "下書きを残していない");
    assert.equal(m.reqs.length, 3, "読み直した");
  });

  it("保存でセッションが切れたら、以降は送らない・読まない", async () => {
    const { m } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    saveFromDialog(m).release(res(null, { status: 401, ok: false }));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0, "セッション切れを失敗として出した");
    click(button(dialog(tree), "保存する"));
    m.render();
    assert.equal(m.reqs.length, 3, "セッション切れの後に送った");
  });
});

// ───────────── tester 追加（#81 Q2） ─────────────

const okPatch = (question: Record<string, unknown>, changed: string[], attemptCount = 3) =>
  res({ question, changed, inProgressInvalidated: changed.includes("options"), attemptCount }, { url: `${ORIGIN}/api/admin/questions/x` });

describe("AdminQuiz 描画：保存の失敗と読み直し（tester 追加）", () => {
  it("404：閉じて「見つかりません」と知らせ、詳細を読み直す。読み直しも 404 ならクイズが見つからない表示", async () => {
    const { m } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    saveFromDialog(m).release(res({ error: "Not found" }, { status: 404, ok: false }));
    await settle();
    let tree = m.render();
    assert.equal(dialogs(tree).length, 0, "閉じていない");
    assert.ok(statusText(tree).includes(adminQuizView.QUESTION_GONE_MESSAGE), "404 の知らせがない");
    const reload = m.reqs[m.reqs.length - 1];
    assert.equal(reload.url, adminQuizDetailUrl("m1"), "詳細を読み直していない");
    reload.release(res(null, { status: 404, ok: false }));
    await settle();
    tree = m.render();
    assert.ok(text(byRole(tree, "alert")[0] ?? "").includes(QUIZ_DETAIL_NOT_FOUND_MESSAGE), "クイズが見つからない表示がない");
    assert.equal(hasButton(tree, "問題 2 を編集"), false, "なくなったクイズの問題を出したまま");
    // 開いたボタンがなくなったので、詳細の見出しへフォーカスを移す
    const focused = m.focused() as El;
    assert.ok(focused && focused.type === "h2" && focused.props.tabIndex === -1, `詳細の見出しへフォーカスを移していない：${inspect(focused, { depth: 0 })}`);
  });

  it("409 の読み直しでクイズが 404 になったときも、詳細の見出しへフォーカスを移す", async () => {
    const { m, trigger } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    saveFromDialog(m).release(res({ error: "Conflict", reason: "edit_conflict" }, { status: 409, ok: false }));
    await settle();
    m.render();
    assert.equal(m.focused(), trigger, "閉じたあと開いたボタンにフォーカスが戻らない（前提）");
    m.reqs[m.reqs.length - 1].release(res(null, { status: 404, ok: false }));
    await settle();
    m.render();
    const focused = m.focused() as El;
    assert.ok(focused && focused.type === "h2" && focused.props.tabIndex === -1, "詳細の見出しへフォーカスを移していない");
  });

  it("403・500：ダイアログに文言を出して下書きを残し、読み直さない。もう一度「保存する」まで進めば同じ revision で送り直せる", async () => {
    for (const [status, message] of [[403, adminQuizView.SAVE_FORBIDDEN_MESSAGE], [500, adminQuizView.SAVE_SERVER_ERROR_MESSAGE]] as const) {
      const { m } = await editing(2);
      change(questionInput(m.render()), "直した問題文");
      saveFromDialog(m).release(res({ error: "x" }, { status, ok: false }));
      await settle();
      const d = dialog(m.render());
      assert.ok(text(byRole(d, "alert")[0]).includes(message), `${status} の文言がない`);
      assert.equal(questionInput(d).props.value, "直した問題文", `${status} で下書きを消した`);
      assert.equal(m.reqs.length, 3, `${status} で読み直した`);
      const again = saveFromDialog(m);
      assert.deepEqual(jsonBody(again), { revision: REV, question: "直した問題文" }, `${status} のあとの送り直しの body が違う`);
    }
  });

  it("ログイン以外へのリダイレクトは結果不明（読み直す）。/login へのリダイレクトはセッション切れ（読み直さない）", async () => {
    const a = await editing(2);
    change(questionInput(a.m.render()), "直した問題文");
    saveFromDialog(a.m).release(res("<html>", { redirected: true, url: `${ORIGIN}/maintenance` }));
    await settle();
    assert.ok(statusText(a.m.render()).includes(SAVE_UNCERTAIN_MESSAGE), "結果不明の知らせがない");
    assert.equal(a.m.reqs[a.m.reqs.length - 1].url, adminQuizDetailUrl("m1"), "読み直していない");

    const b = await editing(2);
    change(questionInput(b.m.render()), "直した問題文");
    saveFromDialog(b.m).release(res("<html>", { redirected: true, url: `${ORIGIN}/login?callbackUrl=%2F` }));
    await settle();
    const tree = b.m.render();
    assert.equal(statusText(tree).includes(SAVE_UNCERTAIN_MESSAGE), false, "セッション切れを結果不明として出した");
    assert.equal(b.m.reqs.length, 3, "セッション切れのあとに読み直した");
  });

  it("2xx でも別の問題の応答は結果不明として読み直し、詳細は書き換えない", async () => {
    const { m } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    saveFromDialog(m).release(okPatch(q("qa", { order: 1, question: "別の問題", revision: REV2 }), ["question"]));
    await settle();
    const tree = m.render();
    assert.ok(statusText(tree).includes(SAVE_UNCERTAIN_MESSAGE), "結果不明の知らせがない");
    assert.equal(text(tree).includes("別の問題"), false, "別の問題の応答で詳細を書き換えた");
    assert.equal(m.reqs[m.reqs.length - 1].url, adminQuizDetailUrl("m1"), "読み直していない");
  });

  it("409 → 読み直しの間は編集ボタンが aria-disabled。読み直しに失敗 →「再読み込み」→ 成功で知らせが消え、最新の revision で送れる", async () => {
    const { m } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    saveFromDialog(m).release(res({ error: "Conflict", reason: "edit_conflict" }, { status: 409, ok: false }));
    await settle();
    let tree = m.render();
    assert.deepEqual([1, 2].map((n) => button(tree, `問題 ${n} を編集`).props["aria-disabled"]), [true, true], "読み直しの間に aria-disabled でない");
    assert.ok(text(tree).includes("最新の内容を読み込んでいます"), "読み直し中の表示がない");
    m.reqs[m.reqs.length - 1].release(res(null, { status: 500, ok: false }));
    await settle();
    tree = m.render();
    assert.ok(text(byRole(tree, "alert")[0]).includes(adminQuizView.QUIZ_REFRESH_FAILED_MESSAGE), "読み直しの失敗を知らせていない");
    assert.ok(hasButton(tree, "問題 2 を編集"), "読み直しの失敗で表示を消した");
    assert.equal(button(tree, "問題 2 を編集").props["aria-disabled"], undefined, "失敗のあとも aria-disabled のまま");
    click(button(tree, "再読み込み"));
    const retry = m.reqs[m.reqs.length - 1];
    assert.equal(retry.url, adminQuizDetailUrl("m1"));
    retry.release(res(DETAIL({ questions: [q("qa", { order: 1, revision: REV3 }), q("qb", { order: 2, question: "他の講師の問題文", revision: REV3 })] })));
    await settle();
    tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0, "読み直しに成功しても失敗の表示が残った");
    assert.ok(text(tree).includes("他の講師の問題文"), "最新の内容を出していない");
    click(button(tree, "問題 2 を編集"), m.target("z"));
    change(questionInput(m.render()), "もう一度");
    assert.equal(jsonBody(saveFromDialog(m)).revision, REV3, "最新の revision で送っていない");
  });

  it("409 の読み直しの途中で一覧に戻ると、読み直しの応答は捨て、一覧を読み直す", async () => {
    const { m } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    saveFromDialog(m).release(res({ reason: "edit_conflict" }, { status: 409, ok: false }));
    await settle();
    const reload = m.reqs[m.reqs.length - 1];
    click(button(m.render(), "一覧に戻る"));
    m.render();
    assert.equal(m.reqs[m.reqs.length - 1].url, ADMIN_QUIZ_LIST_URL, "一覧を読み直していない");
    reload.release(res(DETAIL()));
    await settle();
    const tree = m.render();
    assert.equal(hasButton(tree, "問題 1 を編集"), false, "一覧に戻ったあとの応答で詳細を出した");
  });

  it("409 の読み直しでセッションが切れたら、以降は編集を開かず、読まない・送らない", async () => {
    const { m } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    saveFromDialog(m).release(res({ reason: "edit_conflict" }, { status: 409, ok: false }));
    await settle();
    m.reqs[m.reqs.length - 1].release(res(null, { status: 401, ok: false }));
    await settle();
    const before = m.reqs.length;
    const tree = m.render();
    click(button(tree, "問題 2 を編集"), m.target("x"));
    assert.equal(dialogs(m.render()).length, 0, "セッション切れのあとに編集を開いた");
    click(button(m.render(), "一覧に戻る"));
    m.render();
    assert.equal(m.reqs.length, before, "セッション切れのあとに読んだ");
  });

  it("保存中は「一覧に戻る」が disabled で、押しても戻らない", async () => {
    const { m } = await editing(2);
    change(questionInput(m.render()), "直した問題文");
    saveFromDialog(m);
    const tree = m.render();
    const back = button(tree, "一覧に戻る");
    assert.equal(back.props.disabled, true, "保存中に一覧に戻れる");
    click(back);
    assert.equal(dialogs(m.render()).length, 1, "保存中に詳細を閉じた");
  });
});

describe("AdminQuiz 描画：壊れた問題と組み合わせた操作（tester 追加）", () => {
  it("正解が範囲外の問題（問題 1）：ラジオはどれも選ばれていない。正解を選べば correctIndex だけを送る", async () => {
    const { m } = await editing(1);
    const d = dialog(m.render());
    assert.deepEqual(radios(d).map((r) => r.props.checked), [false, false, false], "範囲外の正解でラジオが選ばれている");
    pick(radios(d)[2]);
    assert.deepEqual(jsonBody(saveFromDialog(m)), { revision: REV, correctIndex: 2 });
  });

  it("選択肢が壊れた問題：空の 2 件から入力し、正解を選ぶまで送らない。送った body はサーバーで通る", async () => {
    const broken = q("qa", { order: 1, options: null, correctIndex: 0, valid: false });
    const { m } = await editing(1, DETAIL({ questions: [broken] }));
    let d = dialog(m.render());
    assert.deepEqual(optionInputs(d).map((i) => i.props.value), ["", ""], "空の 2 件でない");
    change(byLabel(d, "選択肢 1"), "新A");
    change(byLabel(m.render(), "選択肢 2"), "新B");
    click(button(m.render(), "選択肢を追加"));
    change(byLabel(m.render(), "選択肢 3"), "新C");
    click(button(m.render(), "保存"));
    d = dialog(m.render());
    assert.ok(text(byRole(d, "alert")[0]).includes(adminQuizView.CORRECT_NOT_SELECTED_MESSAGE), "正解を選ぶよう知らせていない");
    assert.equal(m.reqs.length, 2, "正解なしで送った");
    pick(radios(d)[2]);
    const body = jsonBody(saveFromDialog(m));
    assert.deepEqual(body, { revision: REV, options: ["新A", "新B", "新C"], correctIndex: 2 });
    const parsed = parsePatchQuestionBody(body);
    assert.ok(!("reason" in parsed), "サーバーの検証を通らない");
    const plan = planQuestionEdit({ question: broken.question, options: null, correctIndex: 0 }, parsed.value);
    assert.ok(!("reason" in plan), "サーバーで反映できない");
    assert.equal((plan.value.after.options as string[])[plan.value.after.correctIndex], "新C");
  });

  it("追加 → 入力 → 正解に選ぶ → 元の正解だった選択肢を削除：body は下書きの並びと、削除のあとの正解の位置", async () => {
    const { m } = await editing(2);
    click(button(m.render(), "選択肢を追加"));
    change(byLabel(m.render(), "選択肢 4"), "新しいD");
    pick(radios(dialog(m.render()))[3]);
    // 元の正解だった B（2 番目）を消す。足した D（4 番目）が 3 番目に詰まる
    click(button(m.render(), "選択肢 2 を削除"));
    const d = dialog(m.render());
    assert.deepEqual(optionInputs(d).map((i) => i.props.value), ["選択肢A", "選択肢C", "新しいD"]);
    assert.deepEqual(radios(d).map((r) => r.props.checked), [false, false, true], "正解の印がずれた");
    click(button(m.render(), "保存"));
    assert.ok(text(dialog(m.render())).includes("変更する項目：選択肢・正解"), "変更する項目が違う");
    click(button(m.render(), "保存する"));
    const body = jsonBody(m.reqs[m.reqs.length - 1]);
    assert.deepEqual(body, { revision: REV, options: ["選択肢A", "選択肢C", "新しいD"], correctIndex: 2 });
  });

  it("正解の選択肢を消すと正解なしに戻り、保存で知らせる（送らない）", async () => {
    const { m } = await editing(2);
    click(button(m.render(), "選択肢 2 を削除"));
    const d = dialog(m.render());
    assert.deepEqual(radios(d).map((r) => r.props.checked), [false, false], "正解の選択肢を消しても正解が残っている");
    click(button(d, "保存"));
    assert.ok(text(byRole(dialog(m.render()), "alert")[0]).includes(adminQuizView.CORRECT_NOT_SELECTED_MESSAGE), "正解を選ぶよう知らせていない");
    assert.equal(m.reqs.length, 2, "送った");
  });

  it("使えない文字（NUL・対になっていないサロゲート・見えない文字だけ）は保存の前に知らせ、入力し直すと知らせが消える", async () => {
    for (const [label, apply, reason] of [
      ["問題文の NUL", (t: El) => change(questionInput(t), "A\u0000"), "invalid_question"],
      ["問題文の対になっていないサロゲート", (t: El) => change(questionInput(t), "A\uD800"), "invalid_question"],
      ["選択肢のゼロ幅だけ", (t: El) => change(byLabel(t, "選択肢 1"), "\u200B\u2060"), "invalid_options"],
      ["見た目が同じ選択肢", (t: El) => change(byLabel(t, "選択肢 1"), "選択肢B\uFE0F"), "invalid_options"],
    ] as Array<[string, (t: El) => void, string]>) {
      const { m } = await editing(2);
      apply(m.render());
      click(button(m.render(), "保存"));
      const d = dialog(m.render());
      assert.ok(text(byRole(d, "alert")[0] ?? "").includes(patchReasonMessage(reason)), `${label}の文言がない`);
      assert.equal(m.reqs.length, 2, `${label}で送った`);
      change(questionInput(m.render()), "直した問題文");
      assert.equal(byRole(dialog(m.render()), "alert").length, 0, `${label}：入力し直しても知らせが残った`);
    }
  });

  it("確認文：受験 0 件で選択肢を変えると受験中の注意だけを出す", async () => {
    const { m } = await editing(2, DETAIL({ attemptCount: 0 }));
    change(byLabel(m.render(), "選択肢 1"), "直したA");
    click(button(m.render(), "保存"));
    const t = text(dialog(m.render()));
    assert.ok(t.includes(OPTIONS_CHANGE_NOTICE), "受験中の注意がない");
    assert.equal(t.includes("過去の受験"), false, "受験 0 件なのに過去の受験の注意を出した");
  });

  it("壊れた問題を直して保存できたら、状態のバッジ（受験できない）が消える", async () => {
    const { m } = await editing(1);
    assert.ok(badges(m.render()).includes("受験できない"), "前提：バッジがない");
    pick(radios(dialog(m.render()))[0]);
    saveFromDialog(m).release(okPatch(q("qa", { order: 1, correctIndex: 0, valid: true, revision: REV2 }), ["correctIndex"]));
    await settle();
    const tree = m.render();
    assert.equal(badges(tree).includes("受験できない"), false, "直したあともバッジが残った");
    assert.equal(text(tree).includes(adminQuizView.CORRECT_OUT_OF_RANGE_WARNING), false, "直したあとも警告が残った");
  });
});

describe("AdminQuiz：講師以外には出さない（tester 追加）", () => {
  it("クイズ管理は講師のナビ（adminNav）にだけあり、受講生のナビにない", () => {
    const sidebar = component("Sidebar");
    const navOf = (name: string) => {
      const start = sidebar.indexOf(`const ${name} = [`);
      assert.ok(start >= 0, `${name} がない`);
      return sidebar.slice(start, sidebar.indexOf("];", start));
    };
    assert.match(navOf("adminNav"), /id: "admin-quiz"/);
    assert.doesNotMatch(navOf("studentNav"), /admin-/, "受講生のナビに管理画面がある");
    assert.match(sidebar, /const nav = isAdmin \? adminNav : studentNav;/);
    assert.match(src, /<Sidebar [^>]*isAdmin=\{admin\}/);
    assert.match(src, /const admin = sessionView\.kind === "authenticated" && sessionView\.role === "INSTRUCTOR";/);
    // 画面から admin-quiz へ移るのはナビからだけ（setPage("admin-quiz") などの直書きがない）
    assert.equal(src.split('"admin-quiz"').length - 1, 2, "admin-quiz への移動がナビ以外にもある");
  });
});
