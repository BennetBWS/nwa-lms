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

// #47 P2 管理画面の質問対応ページ（page.tsx の AdminQuestions）の質問・返信の削除。
// 1. ソースで検査する（authFetch・DELETE・二重送信の ref・受講生側を変えていない）
// 2. typescript の transpileModule で JSX から変換し、偽の React で「描画」して、確認ダイアログ・リクエスト・行の扱い・
//    フォーカスの戻り先を確かめる（器は admin-questions.page.edge.test.ts と同じ。window の keydown と ref を足した）
// DOM・DB・ネットワークなし。データはすべてダミー。
//
// 検証しないこと：setState による再描画（テストが render() を呼んだときだけ描画）、ModalPortal の Portal 化
// （admin-dialog.page*.test.ts）、CSS の見た目。押したボタン（e.currentTarget）は偽の要素をテストが渡し、
// 行が消えたことは isConnected を false にして表す。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const compSrc = component("AdminQuestions");

// ───────────── 1. ソース ─────────────

describe("AdminQuestions 削除：ソース", () => {
  it("削除は authFetch で DELETE /api/admin/comments/[id] を呼ぶ（fetch を直接使わない）", () => {
    assert.match(compSrc, /authFetch\(adminCommentDeleteUrl\(target\.id\), \{ method: "DELETE" \}\)/);
    assert.doesNotMatch(compSrc, /(^|[^A-Za-z])fetch\(/m);
  });

  it("二重送信の防止：deletingRef（Set）で確かめてから送り、終わったら外す", () => {
    assert.match(compSrc, /const deletingRef = useRef\(new Set\(\)\)/);
    const body = compSrc.slice(compSrc.indexOf("const handleDelete = async"), compSrc.indexOf("useEffect(() => { loadThreads("));
    const check = body.indexOf("deletingRef.current.has(target.id)");
    const add = body.indexOf("deletingRef.current.add(target.id)");
    const send = body.indexOf("authFetch(");
    assert.ok(check >= 0 && check < add && add < send, "送る前に deletingRef で確かめて登録していない");
    assert.ok(body.indexOf("deletingRef.current.delete(target.id)") > body.indexOf("finally"), "finally で deletingRef から外していない");
  });

  it("セッション切れは classifyAuthFailure で判定する", () => {
    const body = compSrc.slice(compSrc.indexOf("const handleDelete = async"), compSrc.indexOf("useEffect(() => { loadThreads("));
    assert.match(body, /classifyAuthFailure\(\{ status: res\.status, redirected: res\.redirected, url: res\.url \}\) === "expired"\) sessionExpired\.current = true/);
  });

  it("受講生側の Questions と LessonView には削除を入れていない", () => {
    for (const name of ["Questions", "LessonView"]) {
      const c = component(name);
      assert.doesNotMatch(c, /adminCommentDeleteUrl|openDeleteDialog|method:\s*"DELETE"|を削除/, name);
    }
  });
});

// ───────────── 2. 偽の React ─────────────

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
const ModalPortal = stub("ModalPortal");
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
  ModalPortal,
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
/** 押したボタンの代わり（e.currentTarget）。focus() を呼ぶと focused() がこれを返す */
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
    // 前の描画の ref を外し、新しい木の要素に付け直す
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
  return { render, reqs, key, target, focused: () => focused, keydownCount: () => listeners.get("keydown")?.size ?? 0 };
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
const click = (b: El, currentTarget: unknown = null) =>
  (b.props.onClick as (e?: unknown) => void)({ preventDefault() {}, stopPropagation() {}, currentTarget });
const byRole = (tree: El, role: string) => findAll(tree, (e) => e.props.role === role);
const change = (el: El, value: string) => (el.props.onChange as (e: unknown) => void)({ target: { value } });
const threadButtons = (tree: El) => findAll(tree, (e) => e.type === "button" && "aria-expanded" in e.props);
function threadButton(tree: El, id: string): El {
  const hit = threadButtons(tree).filter((b) => b.props.id === `admin-question-thread-button-${id}`);
  assert.equal(hit.length, 1, `質問 ${id} の行が 1 つでない`);
  return hit[0];
}
const rowIds = (tree: El) => threadButtons(tree).map((b) => String(b.props.id).replace("admin-question-thread-button-", ""));
function region(tree: El, id: string): El {
  const hit = findAll(tree, (e) => e.props.id === `admin-question-thread-${id}`);
  assert.equal(hit.length, 1, `質問 ${id} の領域が 1 つでない`);
  return hit[0];
}
/** aria-label が label の削除ボタン（質問は「この質問を削除」、返信は「<名前> の返信「<本文の先頭>」を削除」） */
function deleteButton(tree: El, label: string): El {
  const hit = findAll(tree, (e) => e.type === Button && e.props["aria-label"] === label);
  assert.equal(hit.length, 1, `削除ボタン「${label}」が 1 つでない`);
  return hit[0];
}
const deleteButtonsIn = (n: El) => findAll(n, (e) => e.type === Button && String(e.props["aria-label"] ?? "").endsWith("を削除"));
const dialogs = (tree: El) => byRole(tree, "dialog");
function dialog(tree: El): El {
  const hit = dialogs(tree);
  assert.equal(hit.length, 1, "確認ダイアログが 1 つでない");
  return hit[0];
}
const statusTexts = (tree: El) => byRole(tree, "status").map((e) => text(e));
/** 削除の知らせ（ref を持つ role="status"） */
function deleteStatusEl(tree: El): El {
  const hit = byRole(tree, "status").filter((e) => e.props.ref !== undefined);
  assert.equal(hit.length, 1, "削除の知らせが 1 つでない");
  return hit[0];
}
const alerts = (n: El) => byRole(n, "alert").map((a) => text(a));
function textareaOf(tree: El, id: string): El {
  const hit = findAll(tree, (e) => e.type === "textarea" && e.props.id === `admin-question-reply-${id}`);
  assert.equal(hit.length, 1, `質問 ${id} の回答欄が 1 つでない`);
  return hit[0];
}

// ───────────── データ（ダミー） ─────────────

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const reply = (id: string, content: string, instructor: boolean, name: string) => ({
  id,
  content,
  createdAt: ago(5),
  author: { name, isInstructor: instructor },
  mine: instructor,
});

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

const T1_REPLIES = [reply("r1", "講師の回答です", true, "講師ビー"), reply("r2", "受講生の追記です", false, "受講生エー")];
const t1 = () => thread("t1", { replies: T1_REPLIES, replyCount: 2, answered: true, lastReplyAt: ago(5) });
const PAGE1 = { threads: [t1(), thread("t2")], nextCursor: null as string | null };
const COURSES = [{ id: "co1", name: "STEP1 ダミー" }];

const deleteReqs = (m: { reqs: Req[] }) => m.reqs.filter((r) => r.init?.method === "DELETE");
const listReqs = (m: { reqs: Req[] }) => m.reqs.filter((r) => r.url.startsWith("/api/comments"));
const DEL_URL = (id: string) => `${ORIGIN}/api/admin/comments/${id}`;

/** 一覧を読み込み、t1 を開いた状態 */
async function opened(body: unknown = PAGE1) {
  const m = mount();
  m.render();
  assert.equal(m.reqs.length, 2, "最初の読み込みが 2 本（一覧・コース）でない");
  m.reqs[0].release(res(body));
  m.reqs[1].release(res(COURSES, { url: `${ORIGIN}/api/admin/courses` }));
  await settle();
  click(threadButton(m.render(), "t1"));
  return m;
}

/** t1 の質問の削除の確認ダイアログを開いた状態。trigger は押したボタンの代わり */
async function questionDialog() {
  const m = await opened();
  const trigger = m.target("question-delete");
  click(deleteButton(m.render(), "この質問を削除"), trigger);
  return { m, trigger };
}

// ───────────── ボタンと確認ダイアログ ─────────────

describe("AdminQuestions 削除：ボタンと確認ダイアログ", () => {
  it("開いたスレッドの質問本文の横と、各返信の横に「削除」ボタン（ghost・危険色）がある。閉じた行にはない", async () => {
    const m = await opened();
    const tree = m.render();
    const inT1 = deleteButtonsIn(region(tree, "t1"));
    assert.deepEqual(
      inT1.map((b) => b.props["aria-label"]),
      ["この質問を削除", "講師ビー の返信「講師の回答です」を削除", "受講生エー の返信「受講生の追記です」を削除"]
    );
    for (const b of inT1) {
      assert.equal(text(b).trim(), "削除");
      assert.equal(b.props.variant, "ghost");
      assert.equal((b.props.style as Record<string, unknown>).color, "#000000", "危険色（T.danger）を使っていない");
      assert.equal(b.props.disabled, false);
    }
    assert.match(compSrc, /const deleteButtonStyle = \{ flexShrink: 0, color: T\.danger,/);
    assert.equal(deleteButtonsIn(tree).length, 3, "閉じている t2 に削除ボタンがある");
  });

  it("押すと確認ダイアログを開くだけで、送らない", async () => {
    const { m } = await questionDialog();
    const tree = m.render();
    assert.equal(deleteReqs(m).length, 0, "確認の前に送った");
    const d = dialog(tree);
    assert.equal(d.props["aria-modal"], "true");
    assert.equal(d.props["aria-labelledby"], "nwa-delete-dialog-title");
    assert.ok(text(d).includes("質問を削除"), "見出しがない");
    assert.ok(text(d).includes("この質問と返信 2 件を削除します。元に戻せません。"), `本文が違う：${text(d)}`);
    assert.ok(text(d).includes("「t1 の質問本文」"), "本文の引用がない");
    assert.equal(findAll(tree, (e) => e.type === ModalPortal).length, 1, "ModalPortal で包んでいない");
  });

  it("返信の確認ダイアログは「この返信を削除します。」と返信の本文を引用する", async () => {
    const m = await opened();
    click(deleteButton(m.render(), "受講生エー の返信「受講生の追記です」を削除"), m.target("reply"));
    const d = dialog(m.render());
    assert.ok(text(d).includes("返信を削除"), "見出しがない");
    assert.ok(text(d).includes("この返信を削除します。元に戻せません。"), `本文が違う：${text(d)}`);
    assert.ok(text(d).includes("「受講生の追記です」"), "返信の本文の引用がない");
  });

  it("返信のない質問は「この質問を削除します。」", async () => {
    const m = await opened({ threads: [thread("t1")], nextCursor: null });
    click(deleteButton(m.render(), "この質問を削除"), m.target("q"));
    assert.ok(text(dialog(m.render())).includes("この質問を削除します。元に戻せません。"));
  });

  it("引用は見えない文字（向きの制御文字・幅のない空白）を除き、長い本文は先頭だけにする", async () => {
    const long = "\u202Eあ\u200Bい" + "う".repeat(60);
    const m = await opened({ threads: [thread("t1", { content: long })], nextCursor: null });
    click(deleteButton(m.render(), "この質問を削除"), m.target("q"));
    const t = text(dialog(m.render()));
    assert.ok(!t.includes("\u202E") && !t.includes("\u200B"), "見えない文字が残っている");
    assert.ok(t.includes(`「${adminQuestions.deleteQuote(long)}」`), "引用が deleteQuote の結果でない");
    assert.ok(t.includes("…」"), "長い本文を切っていない");
  });

  it("キャンセル：送らずに閉じ、押したボタンにフォーカスを戻す", async () => {
    const { m, trigger } = await questionDialog();
    const tree = m.render();
    const cancel = button(dialog(tree), "キャンセル");
    assert.equal(cancel.props.autoFocus, true, "キャンセルに初期フォーカスがない");
    click(cancel);
    const after = m.render();
    assert.equal(dialogs(after).length, 0, "閉じない");
    assert.equal(m.focused(), trigger, "押したボタンにフォーカスが戻らない");
    assert.equal(deleteReqs(m).length, 0);
    assert.deepEqual(rowIds(after), ["t1", "t2"]);
  });

  it("Esc で閉じる。閉じたら keydown の登録を外す", async () => {
    const { m, trigger } = await questionDialog();
    m.render();
    assert.equal(m.keydownCount(), 1, "開いている間に Esc を受けていない");
    assert.equal(m.key("Enter"), false, "Esc 以外を扱った");
    assert.equal(dialogs(m.render()).length, 1, "Esc 以外で閉じた");
    assert.equal(m.key("Escape"), true, "Esc の既定の動作を止めていない");
    m.render();
    assert.equal(dialogs(m.render()).length, 0, "Esc で閉じない");
    assert.equal(m.keydownCount(), 0, "閉じた後も keydown を登録したまま");
    assert.equal(m.focused(), trigger);
  });

  it("背景のクリックで閉じ、本体のクリックは背景に伝えない", async () => {
    const { m } = await questionDialog();
    const tree = m.render();
    const d = dialog(tree);
    let stopped = false;
    (d.props.onClick as (e: unknown) => void)({ stopPropagation: () => (stopped = true) });
    assert.ok(stopped, "本体のクリックを止めていない");
    const backdrop = findAll(tree, (e) => e.type === "div" && (e.props.style as Record<string, unknown> | undefined)?.position === "fixed");
    assert.equal(backdrop.length, 1, "背景が 1 つでない");
    click(backdrop[0]);
    assert.equal(dialogs(m.render()).length, 0, "背景のクリックで閉じない");
  });
});

// ───────────── 送信と二重送信 ─────────────

describe("AdminQuestions 削除：送信", () => {
  it("「削除する」で DELETE /api/admin/comments/[id] を 1 本だけ送る（連打しても送らない）。処理中はどちらのボタンも押せず、Esc・背景でも閉じない", async () => {
    const { m } = await questionDialog();
    const confirm = button(dialog(m.render()), "削除する");
    click(confirm);
    click(confirm);
    assert.equal(deleteReqs(m).length, 1, "連打で 2 本送った");
    assert.equal(deleteReqs(m)[0].url, "/api/admin/comments/t1");
    assert.equal(deleteReqs(m)[0].init?.body, undefined, "本文を送っている");
    const tree = m.render();
    const d = dialog(tree);
    assert.equal(button(d, "削除中...").props.disabled, true);
    assert.equal(button(d, "キャンセル").props.disabled, true);
    click(button(d, "削除中..."));
    assert.equal(deleteReqs(m).length, 1, "処理中の再描画の後に押して送った");
    m.key("Escape");
    click(button(d, "キャンセル"));
    assert.equal(dialogs(m.render()).length, 1, "処理中に閉じた");
  });

  it("成功（質問）：行を除き、件数を知らせ、ダイアログを閉じて削除の知らせへフォーカスを移す（押したボタンは行ごと消えた）", async () => {
    const { m, trigger } = await questionDialog();
    click(button(dialog(m.render()), "削除する"));
    trigger.isConnected = false;
    deleteReqs(m)[0].release(res({ kind: "question", id: "t1", deletedReplies: 2 }, { url: DEL_URL("t1") }));
    await settle();
    const tree = m.render();
    assert.equal(dialogs(tree).length, 0, "閉じない");
    assert.deepEqual(rowIds(tree), ["t2"], "行が残っている");
    assert.ok(statusTexts(tree).includes("質問と返信 2 件を削除しました"), `知らせがない：${statusTexts(tree).join(" / ")}`);
    const status = deleteStatusEl(tree);
    assert.equal(status.props.tabIndex, -1);
    assert.equal(m.focused(), status, "削除の知らせへフォーカスを移していない");
  });

  it("成功（質問）：その id の書きかけ・回答の失敗の文言・開いた状態を片付ける（同じ id の行が再び出ても残っていない）", async () => {
    const m = await opened();
    change(textareaOf(m.render(), "t1"), "書きかけの回答");
    click(button(m.render(), "回答を送信"));
    const replyReq = m.reqs.find((r) => r.url === "/api/admin/comments/t1/replies");
    assert.ok(replyReq, "回答を送っていない");
    replyReq.release(res({ error: "x" }, { status: 500, ok: false, url: `${DEL_URL("t1")}/replies` }));
    await settle();
    assert.equal(alerts(region(m.render(), "t1")).length, 1, "回答の失敗の文言が出ていない");
    click(deleteButton(m.render(), "この質問を削除"), m.target("q"));
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ kind: "question", id: "t1", deletedReplies: 2 }, { url: DEL_URL("t1") }));
    await settle();
    assert.deepEqual(rowIds(m.render()), ["t2"]);
    // 同じ id の行が読み直しで出てきた（削除と行き違い）としても、前の書きかけ・エラーは出さず、閉じている
    click(findAll(m.render(), (e) => e.type === "button" && e.props["aria-pressed"] === false && text(e) === "すべて")[0]);
    listReqs(m)[listReqs(m).length - 1].release(res(PAGE1));
    await settle();
    let tree = m.render();
    assert.equal(threadButton(tree, "t1").props["aria-expanded"], false, "消した質問が開いたまま");
    click(threadButton(tree, "t1"));
    tree = m.render();
    assert.equal(textareaOf(tree, "t1").props.value, "", "消した質問の書きかけが残っている");
    assert.equal(alerts(region(tree, "t1")).length, 0, "消した質問のエラーが残っている");
  });

  it("成功（返信）：応答の thread で行を置き換え、回答済み→未回答に戻ったことを知らせる。行は残る", async () => {
    const m = await opened();
    const trigger = m.target("reply");
    click(deleteButton(m.render(), "講師ビー の返信「講師の回答です」を削除"), trigger);
    click(button(dialog(m.render()), "削除する"));
    assert.equal(deleteReqs(m)[0].url, "/api/admin/comments/r1");
    trigger.isConnected = false;
    const after = thread("t1", { replies: [T1_REPLIES[1]], replyCount: 1, answered: false, lastReplyAt: ago(5) });
    deleteReqs(m)[0].release(res({ kind: "reply", id: "r1", thread: after }, { url: DEL_URL("r1") }));
    await settle();
    const tree = m.render();
    assert.equal(dialogs(tree).length, 0, "閉じない");
    assert.deepEqual(rowIds(tree), ["t1", "t2"], "行の並びが変わった");
    assert.ok(text(threadButton(tree, "t1")).includes("未回答"), "未回答に戻っていない");
    assert.ok(text(threadButton(tree, "t1")).includes("返信 1件"), "返信の件数が変わっていない");
    assert.deepEqual(deleteButtonsIn(region(tree, "t1")).map((b) => b.props["aria-label"]), ["この質問を削除", "受講生エー の返信「受講生の追記です」を削除"]);
    assert.ok(statusTexts(tree).includes(adminQuestions.REPLY_DELETED_NOW_UNANSWERED_MESSAGE), "知らせがない");
    assert.equal(m.focused(), deleteStatusEl(tree), "削除の知らせへフォーカスを移していない");
  });

  it("成功（返信）：回答済みのままなら「返信を削除しました」だけ", async () => {
    const m = await opened();
    click(deleteButton(m.render(), "受講生エー の返信「受講生の追記です」を削除"), m.target("reply"));
    click(button(dialog(m.render()), "削除する"));
    const after = thread("t1", { replies: [T1_REPLIES[0]], replyCount: 1, answered: true });
    deleteReqs(m)[0].release(res({ kind: "reply", id: "r2", thread: after }, { url: DEL_URL("r2") }));
    await settle();
    assert.ok(statusTexts(m.render()).includes(adminQuestions.REPLY_DELETED_MESSAGE));
  });

  it("404（質問）：「すでに削除されています」と出して行を除く", async () => {
    const { m } = await questionDialog();
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ error: "Comment not found" }, { status: 404, ok: false, url: DEL_URL("t1") }));
    await settle();
    const tree = m.render();
    assert.equal(dialogs(tree).length, 0);
    assert.deepEqual(rowIds(tree), ["t2"]);
    assert.ok(statusTexts(tree).includes("すでに削除されています"));
  });

  it("404 でも本文が HTML（JSON でない）なら削除済みと言い切らず、ダイアログに文言を出して行を残す", async () => {
    const { m } = await questionDialog();
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release({ ...res(null, { status: 404, ok: false, url: DEL_URL("t1") }), json: () => Promise.reject(new SyntaxError("x")) });
    await settle();
    const tree = m.render();
    assert.deepEqual(alerts(dialog(tree)), [adminQuestions.DELETE_UNKNOWN_RESULT_MESSAGE]);
    assert.deepEqual(rowIds(tree), ["t1", "t2"], "HTML の 404 で行を除いた");
    assert.ok(!statusTexts(tree).includes("すでに削除されています"));
  });

  it("404（返信）：「すでに削除されています」と出して、その返信だけを除く", async () => {
    const m = await opened();
    click(deleteButton(m.render(), "講師ビー の返信「講師の回答です」を削除"), m.target("reply"));
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ error: "Comment not found" }, { status: 404, ok: false, url: DEL_URL("r1") }));
    await settle();
    const tree = m.render();
    assert.deepEqual(rowIds(tree), ["t1", "t2"], "質問の行まで消した");
    assert.deepEqual(deleteButtonsIn(region(tree, "t1")).map((b) => b.props["aria-label"]), ["この質問を削除", "受講生エー の返信「受講生の追記です」を削除"]);
    assert.ok(text(threadButton(tree, "t1")).includes("未回答"), "講師の返信がなくなったのに回答済みのまま");
    assert.ok(statusTexts(tree).includes("すでに削除されています"));
  });

  for (const [label, act, expected] of [
    ["500", (r: Req) => r.release(res({ error: "x" }, { status: 500, ok: false, url: DEL_URL("t1") })), /サーバーでエラー/],
    ["403", (r: Req) => r.release(res({ error: "Forbidden" }, { status: 403, ok: false, url: DEL_URL("t1") })), /権限がありません/],
    ["通信エラー", (r: Req) => r.fail(new TypeError("Failed to fetch")), /確かめられませんでした/],
    ["503（HTML）", (r: Req) => r.release({ ...res(null, { status: 503, ok: false, url: DEL_URL("t1") }), json: () => Promise.reject(new SyntaxError("x")) }), /確かめられませんでした/],
    ["200 で別の id", (r: Req) => r.release(res({ kind: "question", id: "other", deletedReplies: 0 }, { url: DEL_URL("t1") })), /確かめられませんでした/],
  ] as const) {
    it(`失敗（${label}）：ダイアログに文言を出し、行は残す。押し直すと送り直せる`, async () => {
      const { m } = await questionDialog();
      click(button(dialog(m.render()), "削除する"));
      act(deleteReqs(m)[0]);
      await settle();
      const tree = m.render();
      const d = dialog(tree);
      assert.equal(alerts(d).length, 1, "ダイアログに文言がない");
      assert.match(alerts(d)[0], expected);
      assert.deepEqual(rowIds(tree), ["t1", "t2"], "失敗なのに行を除いた");
      assert.ok(!statusTexts(tree).some((s) => s.includes("削除しました")), "失敗なのに削除の知らせを出した");
      const confirm = button(d, "削除する");
      assert.equal(confirm.props.disabled, false, "失敗後に押せない");
      click(confirm);
      assert.equal(deleteReqs(m).length, 2, "押し直しても送らない");
      assert.equal(alerts(dialog(m.render())).length, 0, "押し直しても前の文言が残る");
    });
  }

  it("閉じて開き直すと、前の失敗の文言は消えている", async () => {
    const { m } = await questionDialog();
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ error: "x" }, { status: 500, ok: false, url: DEL_URL("t1") }));
    await settle();
    click(button(dialog(m.render()), "キャンセル"));
    m.render();
    click(deleteButton(m.render(), "この質問を削除"), m.target("q"));
    assert.equal(alerts(dialog(m.render())).length, 0);
  });

  it("セッション切れ（401）：行は残し、その後は削除のダイアログを開かない", async () => {
    const { m } = await questionDialog();
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ error: "Unauthorized" }, { status: 401, ok: false, url: DEL_URL("t1") }));
    await settle();
    let tree = m.render();
    assert.deepEqual(rowIds(tree), ["t1", "t2"]);
    click(button(dialog(tree), "キャンセル"));
    tree = m.render();
    click(deleteButton(tree, "この質問を削除"), m.target("q"));
    assert.equal(dialogs(m.render()).length, 0, "セッション切れの後もダイアログを開いた");
  });
});

// ───────────── 回答の送信中・結果不明 ─────────────

describe("AdminQuestions 削除：回答の送信中・結果不明の質問", () => {
  it("回答の送信中は、その質問と返信の削除ボタンを押せず、理由の補足を説明に付ける。別の質問は押せる", async () => {
    const m = await opened({ threads: [t1(), thread("t2")], nextCursor: null });
    click(threadButton(m.render(), "t2"));
    change(textareaOf(m.render(), "t1"), "講師の回答です");
    const sendT1 = findAll(region(m.render(), "t1"), (e) => e.type === Button && text(e).trim() === "回答を送信")[0];
    click(sendT1);
    const tree = m.render();
    const blocked = deleteButtonsIn(region(tree, "t1"));
    assert.equal(blocked.length, 3);
    for (const b of blocked) {
      assert.equal(b.props.disabled, true, `${b.props["aria-label"]} が押せる`);
      assert.equal(b.props["aria-describedby"], "admin-question-delete-blocked-t1");
    }
    const hint = findAll(tree, (e) => e.props.id === "admin-question-delete-blocked-t1");
    assert.equal(hint.length, 1);
    assert.equal(text(hint[0]), adminQuestions.DELETE_BLOCKED_HINT);
    for (const b of deleteButtonsIn(region(tree, "t2"))) {
      assert.equal(b.props.disabled, false, "別の質問の削除まで止めた");
      assert.equal(b.props["aria-describedby"], undefined);
    }
  });

  it("送信結果が分からない（通信エラー）間も止め、一覧の読み直しで判定できたら押せる", async () => {
    const m = await opened({ threads: [thread("t1")], nextCursor: null });
    change(textareaOf(m.render(), "t1"), "講師の回答です");
    click(button(m.render(), "回答を送信"));
    m.reqs.find((r) => r.url === "/api/admin/comments/t1/replies")!.fail(new TypeError("Failed to fetch"));
    await settle();
    assert.equal(deleteButton(m.render(), "この質問を削除").props.disabled, true, "結果不明なのに押せる");
    click(button(m.render(), "一覧を再読み込み"));
    const saved = thread("t1", { replies: [reply("r9", "講師の回答です", true, "講師ビー")], replyCount: 1, answered: true });
    listReqs(m)[listReqs(m).length - 1].release(res({ threads: [saved], nextCursor: null }));
    await settle();
    assert.equal(deleteButton(m.render(), "この質問を削除").props.disabled, false, "判定した後も押せない");
  });

  it("送信結果が分からない間は、開いていたダイアログからも送らない（ボタンを止める前に開いた場合に備える）", async () => {
    const m = await opened({ threads: [thread("t1")], nextCursor: null });
    // 先にダイアログを開いてから、回答を送って通信エラーにする（実際の画面ではダイアログが前面にあるが、
    // 開いた後に送信中・結果不明になった場合も handleDelete で止めることを確かめる）
    click(deleteButton(m.render(), "この質問を削除"), m.target("q"));
    change(textareaOf(m.render(), "t1"), "講師の回答です");
    click(button(m.render(), "回答を送信"));
    m.reqs.find((r) => r.url === "/api/admin/comments/t1/replies")!.fail(new TypeError("Failed to fetch"));
    await settle();
    click(button(dialog(m.render()), "削除する"));
    assert.equal(deleteReqs(m).length, 0, "結果不明の質問を削除した");
    assert.equal(alerts(dialog(m.render()))[0], adminQuestions.DELETE_BLOCKED_HINT);
  });
});

// ───────────── 追加（tester） ─────────────

function tabButton(tree: El, label: string): El {
  const hit = findAll(tree, (e) => e.type === "button" && "aria-pressed" in e.props && text(e).trim() === label);
  assert.equal(hit.length, 1, `タブ「${label}」が 1 つでない`);
  return hit[0];
}

describe("AdminQuestions 削除（追加）：応答ごとの扱い", () => {
  for (const [label, act, expected] of [
    ["400", (r: Req) => r.release(res({ error: "Invalid request", reason: "invalid_id" }, { status: 400, ok: false, url: DEL_URL("t1") })), /対象が正しくありません/],
    ["502", (r: Req) => r.release(res(null, { status: 502, ok: false, url: DEL_URL("t1") })), /確かめられませんでした/],
    ["504", (r: Req) => r.release(res(null, { status: 504, ok: false, url: DEL_URL("t1") })), /確かめられませんでした/],
    ["200 で本文が JSON でない", (r: Req) => r.release({ ...res(null, { url: DEL_URL("t1") }), json: () => Promise.reject(new SyntaxError("x")) }), /確かめられませんでした/],
    ["200 で kind が違う", (r: Req) => r.release(res({ kind: "reply", id: "t1", thread: t1() }, { url: DEL_URL("t1") })), /確かめられませんでした/],
  ] as const) {
    it(`質問の失敗（${label}）：ダイアログに文言を出し、行も開いた状態も残す`, async () => {
      const { m } = await questionDialog();
      click(button(dialog(m.render()), "削除する"));
      act(deleteReqs(m)[0]);
      await settle();
      const tree = m.render();
      assert.match(alerts(dialog(tree))[0] ?? "", expected);
      assert.deepEqual(rowIds(tree), ["t1", "t2"], "失敗なのに行を除いた");
      assert.equal(threadButton(tree, "t1").props["aria-expanded"], true, "失敗なのにスレッドを閉じた");
      assert.equal(text(deleteStatusEl(tree)), "", "失敗なのに削除の知らせを出した");
    });
  }

  for (const [label, body] of [
    ["thread の id が別の質問", { kind: "reply", id: "r1", thread: thread("t2", { replies: [] }) }],
    ["thread がない", { kind: "reply", id: "r1" }],
    ["thread.replies が配列でない", { kind: "reply", id: "r1", thread: { ...t1(), replies: "x" } }],
    ["kind が question", { kind: "question", id: "r1", deletedReplies: 0 }],
  ] as const) {
    it(`返信の 200 で形が違う（${label}）：成功としない。どの行も書き換えない`, async () => {
      const m = await opened();
      click(deleteButton(m.render(), "講師ビー の返信「講師の回答です」を削除"), m.target("reply"));
      click(button(dialog(m.render()), "削除する"));
      deleteReqs(m)[0].release(res(body, { url: DEL_URL("r1") }));
      await settle();
      const tree = m.render();
      assert.match(alerts(dialog(tree))[0] ?? "", /確かめられませんでした/);
      assert.deepEqual(rowIds(tree), ["t1", "t2"]);
      assert.deepEqual(
        deleteButtonsIn(region(tree, "t1")).map((b) => b.props["aria-label"]),
        ["この質問を削除", "講師ビー の返信「講師の回答です」を削除", "受講生エー の返信「受講生の追記です」を削除"],
        "返信の並びが変わった"
      );
      assert.ok(text(threadButton(tree, "t1")).includes("回答済み"), "回答済みが変わった");
    });
  }

  it("返信の 404：押したボタンは消えたので、削除の知らせへフォーカスを移す", async () => {
    const m = await opened();
    const trigger = m.target("reply");
    click(deleteButton(m.render(), "講師ビー の返信「講師の回答です」を削除"), trigger);
    click(button(dialog(m.render()), "削除する"));
    trigger.isConnected = false;
    deleteReqs(m)[0].release(res({ error: "Comment not found" }, { status: 404, ok: false, url: DEL_URL("r1") }));
    await settle();
    const tree = m.render();
    assert.equal(m.focused(), deleteStatusEl(tree), "削除の知らせへフォーカスを移していない");
    assert.ok(text(threadButton(tree, "t1")).includes("返信 1件"), "返信の件数を減らしていない");
  });

  it("失敗の後にキャンセルすると、押したボタン（残っている）にフォーカスを戻す", async () => {
    const { m, trigger } = await questionDialog();
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ error: "x" }, { status: 500, ok: false, url: DEL_URL("t1") }));
    await settle();
    click(button(dialog(m.render()), "キャンセル"));
    m.render();
    assert.equal(m.focused(), trigger);
  });

  it("未回答の質問で受講生の返信を消したとき：wasAnswered は false なので「返信を削除しました」だけ", async () => {
    const t3 = thread("t3", { replies: [reply("r5", "受講生の補足", false, "受講生エー")], replyCount: 1 });
    const m = await opened({ threads: [t1(), t3], nextCursor: null });
    click(threadButton(m.render(), "t3"));
    click(deleteButton(region(m.render(), "t3"), "受講生エー の返信「受講生の補足」を削除"), m.target("r5"));
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ kind: "reply", id: "r5", thread: thread("t3") }, { url: DEL_URL("r5") }));
    await settle();
    const tree = m.render();
    assert.equal(text(deleteStatusEl(tree)), adminQuestions.REPLY_DELETED_MESSAGE);
    assert.ok(text(region(tree, "t3")).includes("まだ返信はありません"), "返信 0 件の表示になっていない");
  });
});

describe("AdminQuestions 削除（追加）：セッション切れ", () => {
  it("/login へリダイレクトされた応答：セッション切れの文言を出し、行は残し、押し直しても送らない", async () => {
    const { m } = await questionDialog();
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res("<html>login</html>", { status: 200, ok: true, redirected: true, url: `${ORIGIN}/login` }));
    await settle();
    const tree = m.render();
    assert.equal(alerts(dialog(tree))[0], commentForm.COMMENT_SESSION_EXPIRED_MESSAGE);
    assert.deepEqual(rowIds(tree), ["t1", "t2"]);
    click(button(dialog(tree), "削除する"));
    assert.equal(deleteReqs(m).length, 1, "セッション切れの後に送り直した");
  });

  it("401 の後は、開いたままのダイアログの「削除する」でも送らない", async () => {
    const { m } = await questionDialog();
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ error: "Unauthorized" }, { status: 401, ok: false, url: DEL_URL("t1") }));
    await settle();
    click(button(dialog(m.render()), "削除する"));
    assert.equal(deleteReqs(m).length, 1, "401 の後に送り直した");
    assert.equal(m.reqs.length, 3, "削除以外の通信も始めた");
  });

  it("403（権限なし）はセッション切れとして扱わない：押し直すと送れる", async () => {
    const { m } = await questionDialog();
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ error: "Forbidden" }, { status: 403, ok: false, url: DEL_URL("t1") }));
    await settle();
    click(button(dialog(m.render()), "削除する"));
    assert.equal(deleteReqs(m).length, 2);
  });
});

describe("AdminQuestions 削除（追加）：連続した削除と他の機能", () => {
  it("続けて別の質問を削除できる（deletingRef が残らない）。知らせは新しい結果に置き換わる", async () => {
    const { m } = await questionDialog();
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ kind: "question", id: "t1", deletedReplies: 2 }, { url: DEL_URL("t1") }));
    await settle();
    let tree = m.render();
    click(threadButton(tree, "t2"));
    tree = m.render();
    click(deleteButton(tree, "この質問を削除"), m.target("t2"));
    tree = m.render();
    assert.equal(text(deleteStatusEl(tree)), "", "ダイアログを開いたのに前の知らせが残っている");
    assert.ok(text(dialog(tree)).includes("この質問を削除します。元に戻せません。"));
    click(button(dialog(tree), "削除する"));
    assert.equal(deleteReqs(m).length, 2);
    assert.equal(deleteReqs(m)[1].url, "/api/admin/comments/t2");
    deleteReqs(m)[1].release(res({ kind: "question", id: "t2", deletedReplies: 0 }, { url: DEL_URL("t2") }));
    await settle();
    tree = m.render();
    assert.equal(text(deleteStatusEl(tree)), "質問を削除しました");
    assert.ok(text(tree).includes("未回答の質問はありません"), "最後の行を消しても空の案内が出ない");
  });

  it("失敗→キャンセル→開き直して押すと 1 本だけ送る（二重に送らない）", async () => {
    const { m } = await questionDialog();
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ error: "x" }, { status: 500, ok: false, url: DEL_URL("t1") }));
    await settle();
    click(button(dialog(m.render()), "キャンセル"));
    m.render();
    click(deleteButton(m.render(), "この質問を削除"), m.target("q"));
    const confirm = button(dialog(m.render()), "削除する");
    click(confirm);
    click(confirm);
    assert.equal(deleteReqs(m).length, 2, "開き直した後の連打で 2 本以上送った");
  });

  it("タブを切り替えると削除の知らせを消す", async () => {
    const { m } = await questionDialog();
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ kind: "question", id: "t1", deletedReplies: 2 }, { url: DEL_URL("t1") }));
    await settle();
    assert.notEqual(text(deleteStatusEl(m.render())), "");
    click(tabButton(m.render(), "すべて"));
    assert.equal(text(deleteStatusEl(m.render())), "");
  });

  it("「もっと見る」の読み込み中に質問を消しても、続きの行は足され、消した行は戻らない", async () => {
    const m = await opened({ threads: [t1(), thread("t2")], nextCursor: "c1" });
    click(button(m.render(), "もっと見る"));
    const more = listReqs(m)[listReqs(m).length - 1];
    assert.match(more.url, /cursor=c1/);
    click(deleteButton(m.render(), "この質問を削除"), m.target("q"));
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ kind: "question", id: "t1", deletedReplies: 2 }, { url: DEL_URL("t1") }));
    await settle();
    more.release(res({ threads: [thread("t3")], nextCursor: null }));
    await settle();
    const tree = m.render();
    assert.deepEqual(rowIds(tree), ["t2", "t3"]);
    assert.equal(text(deleteStatusEl(tree)), "質問と返信 2 件を削除しました");
  });

  it("返信を消した後も、その質問に回答を送れる（回答欄・送信は変わらない）", async () => {
    const m = await opened();
    click(deleteButton(m.render(), "講師ビー の返信「講師の回答です」を削除"), m.target("reply"));
    click(button(dialog(m.render()), "削除する"));
    const after = thread("t1", { replies: [T1_REPLIES[1]], replyCount: 1, answered: false });
    deleteReqs(m)[0].release(res({ kind: "reply", id: "r1", thread: after }, { url: DEL_URL("r1") }));
    await settle();
    change(textareaOf(m.render(), "t1"), "改めて回答します");
    click(button(m.render(), "回答を送信"));
    const sent = m.reqs.filter((r) => r.url === "/api/admin/comments/t1/replies");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].init?.body, JSON.stringify({ content: "改めて回答します" }));
  });

  it("質問を消すと「保存されていました」の知らせ（replyNotices）も片付ける", async () => {
    const m = await opened({ threads: [t1()], nextCursor: null });
    change(textareaOf(m.render(), "t1"), "講師の追加回答");
    click(button(m.render(), "回答を送信"));
    m.reqs.find((r) => r.url === "/api/admin/comments/t1/replies")!.fail(new TypeError("Failed to fetch"));
    await settle();
    click(button(m.render(), "一覧を再読み込み"));
    const saved = thread("t1", { replies: [...T1_REPLIES, reply("r9", "講師の追加回答", true, "講師ビー")], replyCount: 3, answered: true });
    listReqs(m)[listReqs(m).length - 1].release(res({ threads: [saved], nextCursor: null }));
    await settle();
    let tree = m.render();
    const notice = findAll(tree, (e) => e.props.id === "admin-question-reply-notice-t1");
    assert.equal(notice.length, 1, "前提：保存されていましたの知らせが出ていない");
    click(deleteButton(tree, "この質問を削除"), m.target("q"));
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res({ kind: "question", id: "t1", deletedReplies: 3 }, { url: DEL_URL("t1") }));
    await settle();
    // 同じ id の行が再び出ても（削除と行き違った読み込みなど）、知らせは残っていない
    click(tabButton(m.render(), "すべて"));
    listReqs(m)[listReqs(m).length - 1].release(res({ threads: [saved], nextCursor: null }));
    await settle();
    click(threadButton(m.render(), "t1"));
    tree = m.render();
    assert.equal(findAll(tree, (e) => e.props.id === "admin-question-reply-notice-t1").length, 0, "消した質問の知らせが残っている");
  });
});

describe("AdminQuestions 削除（追加）：回答の送信中とダイアログ", () => {
  it("ダイアログを開いた後に回答の送信が始まったら「削除する」で送らず、送信が終われば送れる", async () => {
    const m = await opened();
    click(deleteButton(m.render(), "受講生エー の返信「受講生の追記です」を削除"), m.target("r2"));
    change(textareaOf(m.render(), "t1"), "講師の回答です");
    click(button(m.render(), "回答を送信"));
    click(button(dialog(m.render()), "削除する"));
    assert.equal(deleteReqs(m).length, 0, "回答の送信中の質問の返信を削除した");
    assert.equal(alerts(dialog(m.render()))[0], adminQuestions.DELETE_BLOCKED_HINT);
    const replyReq = m.reqs.find((r) => r.url === "/api/admin/comments/t1/replies")!;
    replyReq.release(res({ thread: thread("t1", { replies: [...T1_REPLIES, reply("r8", "講師の回答です", true, "講師ビー")], replyCount: 3, answered: true }) }, { url: `${DEL_URL("t1")}/replies` }));
    await settle();
    click(button(dialog(m.render()), "削除する"));
    assert.equal(deleteReqs(m).length, 1, "送信が終わった後も送れない");
    assert.equal(deleteReqs(m)[0].url, "/api/admin/comments/r2");
  });

  it("別の質問の回答の送信中・結果不明は、この質問の削除を止めない", async () => {
    const m = await opened();
    click(threadButton(m.render(), "t2"));
    change(textareaOf(m.render(), "t2"), "t2 への回答");
    click(button(region(m.render(), "t2"), "回答を送信"));
    m.reqs.find((r) => r.url === "/api/admin/comments/t2/replies")!.fail(new TypeError("Failed to fetch"));
    await settle();
    assert.equal(deleteButton(region(m.render(), "t2"), "この質問を削除").props.disabled, true, "前提：t2 が止まっていない");
    click(deleteButton(region(m.render(), "t1"), "この質問を削除"), m.target("q"));
    click(button(dialog(m.render()), "削除する"));
    assert.equal(deleteReqs(m).length, 1);
    assert.equal(deleteReqs(m)[0].url, "/api/admin/comments/t1");
  });
});

describe("AdminQuestions 削除（追加）：引用・名前", () => {
  it("見えない文字だけの本文は引用（blockquote）を出さない", async () => {
    const m = await opened({ threads: [thread("t1", { content: "\u200B\u202E\uFEFF" })], nextCursor: null });
    click(deleteButton(m.render(), "この質問を削除"), m.target("q"));
    const d = dialog(m.render());
    assert.equal(findAll(d, (e) => e.type === "blockquote").length, 0, "空の引用を出した");
    assert.ok(text(d).includes("この質問を削除します。元に戻せません。"));
  });

  it("改行を含む本文は 1 行にまとめて引用する。ZWJ の絵文字は途中で切らない", async () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const content = `一行目\n\n二行目 ${"あ".repeat(adminQuestions.DELETE_QUOTE_MAX_CHARS)}`;
    const m = await opened({ threads: [thread("t1", { content: `${family}${content}` })], nextCursor: null });
    click(deleteButton(m.render(), "この質問を削除"), m.target("q"));
    const q = findAll(dialog(m.render()), (e) => e.type === "blockquote");
    assert.equal(q.length, 1);
    const t = text(q[0]);
    assert.ok(t.startsWith(`「${family}一行目 二行目 `), `改行をまとめていない・絵文字を壊した：${JSON.stringify(t)}`);
    assert.ok(t.endsWith("…」"), "長い本文を切っていない");
    assert.ok(!t.includes("\n"), "改行が残っている");
  });

  it("無効化済み受講生（名前が null）の返信は「受講生 の返信「…」を削除」。向きの制御文字を含む名前は aria-label から除く", async () => {
    const t3 = thread("t1", {
      replies: [
        { ...reply("r1", "無効化済みの受講生の返信", false, "x"), author: { name: null, isInstructor: false } },
        reply("r2", "講師の返信", true, "\u202E講師\u200Bシー"),
      ],
      replyCount: 2,
      answered: true,
    });
    const m = await opened({ threads: [t3], nextCursor: null });
    const labels = deleteButtonsIn(region(m.render(), "t1")).map((b) => String(b.props["aria-label"]));
    assert.deepEqual(labels, ["この質問を削除", "受講生 の返信「無効化済みの受講生の返信」を削除", "講師シー の返信「講師の返信」を削除"]);
    for (const l of labels) assert.doesNotMatch(l, /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/, `見えない文字が残っている：${JSON.stringify(l)}`);
  });

  it("2 桁の返信数は「返信 12 件」と出す（画面の replyCount を使う）", async () => {
    const many = Array.from({ length: 12 }, (_, i) => reply(`r${i}`, `返信${i}`, i === 0, "講師ビー"));
    const m = await opened({ threads: [thread("t1", { replies: many, replyCount: 12, answered: true })], nextCursor: null });
    click(deleteButton(m.render(), "この質問を削除"), m.target("q"));
    assert.ok(text(dialog(m.render())).includes("この質問と返信 12 件を削除します。元に戻せません。"));
  });
});

describe("AdminQuestions 削除：削除の通信中の回答の送信", () => {
  const sendButtonIn = (n: El) => {
    const hit = findAll(n, (e) => e.type === Button && (text(e).trim() === "回答を送信" || text(e).trim() === "送信中..."));
    assert.equal(hit.length, 1, "送信ボタンが 1 つでない");
    return hit[0];
  };

  it("質問の削除の通信中は、同じ質問の回答欄と送信ボタンを止め、（古い描画のボタンで）押しても送らない。別の質問へは送れる", async () => {
    const m = await opened();
    click(threadButton(m.render(), "t2"));
    change(textareaOf(m.render(), "t1"), "t1 への回答");
    change(textareaOf(m.render(), "t2"), "t2 への回答");
    const staleSendT1 = sendButtonIn(region(m.render(), "t1"));
    click(deleteButton(region(m.render(), "t1"), "この質問を削除"), m.target("q"));
    click(button(dialog(m.render()), "削除する"));
    const tree = m.render();
    assert.equal(sendButtonIn(region(tree, "t1")).props.disabled, true, "削除中の質問の送信ボタンが押せる");
    assert.equal(textareaOf(tree, "t1").props.readOnly, true, "削除中の質問の回答欄を書き換えられる");
    click(sendButtonIn(region(tree, "t1")));
    click(staleSendT1);
    assert.equal(m.reqs.filter((r) => r.url === "/api/admin/comments/t1/replies").length, 0, "削除中の質問へ回答を送った");
    const sendT2 = sendButtonIn(region(tree, "t2"));
    assert.equal(sendT2.props.disabled, false, "別の質問の送信まで止めた");
    assert.equal(textareaOf(tree, "t2").props.readOnly, false);
    click(sendT2);
    assert.equal(m.reqs.filter((r) => r.url === "/api/admin/comments/t2/replies").length, 1, "別の質問へ送れない");
  });

  it("返信の削除の通信中も、その質問へは送らない。失敗して処理が終われば送れる", async () => {
    const m = await opened();
    change(textareaOf(m.render(), "t1"), "t1 への回答");
    click(deleteButton(region(m.render(), "t1"), "受講生エー の返信「受講生の追記です」を削除"), m.target("r2"));
    click(button(dialog(m.render()), "削除する"));
    click(sendButtonIn(region(m.render(), "t1")));
    assert.equal(m.reqs.filter((r) => r.url === "/api/admin/comments/t1/replies").length, 0, "返信の削除中にその質問へ回答を送った");
    deleteReqs(m)[0].release(res({ error: "x" }, { status: 500, ok: false, url: DEL_URL("r2") }));
    await settle();
    click(button(dialog(m.render()), "キャンセル"));
    const tree = m.render();
    assert.equal(sendButtonIn(region(tree, "t1")).props.disabled, false, "処理が終わっても送れない");
    click(sendButtonIn(region(tree, "t1")));
    assert.equal(m.reqs.filter((r) => r.url === "/api/admin/comments/t1/replies").length, 1);
  });
});

describe("AdminQuestions 削除：同じ名前の人の返信", () => {
  it("同じ名前の返信が複数あっても、削除ボタンの読み上げ名は本文の先頭で区別できる", async () => {
    const t = thread("t1", {
      replies: [reply("r1", "一つ目の回答", true, "講師ビー"), reply("r2", "二つ目の回答", true, "講師ビー")],
      replyCount: 2,
      answered: true,
    });
    const m = await opened({ threads: [t], nextCursor: null });
    const labels = deleteButtonsIn(region(m.render(), "t1")).map((b) => String(b.props["aria-label"]));
    assert.deepEqual(labels, ["この質問を削除", "講師ビー の返信「一つ目の回答」を削除", "講師ビー の返信「二つ目の回答」を削除"]);
    assert.equal(new Set(labels).size, labels.length, "読み上げ名が重なっている");
    for (const b of deleteButtonsIn(region(m.render(), "t1"))) assert.equal(text(b).trim(), "削除", "見える文字が「削除」でない");
  });
});

describe("AdminQuestions 削除：開いた後に対象の行が変わったとき", () => {
  it("開いた後に回答が保存されて回答済みになると、送信時の今の一覧で「未回答に戻ったか」を判定する", async () => {
    // opened() は t1 を開く。未回答の t1（受講生の返信だけ）
    const m = await opened({ threads: [thread("t1", { replies: [reply("r5", "受講生の補足", false, "受講生エー")], replyCount: 1 })], nextCursor: null });
    click(deleteButtonsIn(region(m.render(), "t1"))[1], m.target("r5"));
    change(textareaOf(m.render(), "t1"), "講師の回答");
    click(button(region(m.render(), "t1"), "回答を送信"));
    const answered = thread("t1", { replies: [reply("r5", "受講生の補足", false, "受講生エー"), reply("r6", "講師の回答", true, "講師ビー")], replyCount: 2, answered: true });
    m.reqs.find((r) => r.url === "/api/admin/comments/t1/replies")!.release(res({ thread: answered }, { url: `${DEL_URL("t1")}/replies` }));
    await settle();
    click(button(dialog(m.render()), "削除する"));
    // 講師の返信も消えて未回答に戻った（別の講師が同時に消した等）応答
    const after = thread("t1", { replies: [], replyCount: 0, answered: false });
    deleteReqs(m)[0].release(res({ kind: "reply", id: "r5", thread: after }, { url: DEL_URL("r5") }));
    await settle();
    assert.ok(statusTexts(m.render()).includes(adminQuestions.REPLY_DELETED_NOW_UNANSWERED_MESSAGE), "開いた時点の未回答を使って判定した");
  });

  it("開いた後に対象の返信が一覧から消えたら、見つからないと出して「削除する」を押せなくし、送らない", async () => {
    const m = await opened();
    click(deleteButtonsIn(region(m.render(), "t1"))[2], m.target("r2"));
    change(textareaOf(m.render(), "t1"), "講師の追加回答");
    click(button(region(m.render(), "t1"), "回答を送信"));
    const without = thread("t1", { replies: [T1_REPLIES[0], reply("r9", "講師の追加回答", true, "講師ビー")], replyCount: 2, answered: true });
    m.reqs.find((r) => r.url === "/api/admin/comments/t1/replies")!.release(res({ thread: without }, { url: `${DEL_URL("t1")}/replies` }));
    await settle();
    const d = dialog(m.render());
    assert.ok(text(d).includes(adminQuestions.DELETE_TARGET_MISSING_MESSAGE), `見つからない文言がない：${text(d)}`);
    assert.equal(findAll(d, (e) => e.type === "blockquote").length, 0, "消えた対象の引用を出した");
    const confirm = button(d, "削除する");
    assert.equal(confirm.props.disabled, true, "見つからないのに押せる");
    click(confirm);
    assert.equal(deleteReqs(m).length, 0, "見つからない対象を送った");
    assert.equal(button(dialog(m.render()), "キャンセル").props.disabled, false, "閉じられない");
  });
});

describe("AdminQuestions 削除：ダイアログが開いている間・処理中の背後のボタン", () => {
  it("確認ダイアログが開いている間は、背後のすべての削除ボタンが押せない。閉じたら押せる", async () => {
    const m = await opened();
    click(threadButton(m.render(), "t2"));
    click(deleteButton(region(m.render(), "t1"), "この質問を削除"), m.target("q"));
    let tree = m.render();
    const all = deleteButtonsIn(tree);
    assert.equal(all.length, 4);
    for (const b of all) assert.equal(b.props.disabled, true, `${b.props["aria-label"]} が押せる`);
    click(button(dialog(tree), "キャンセル"));
    tree = m.render();
    for (const b of deleteButtonsIn(tree)) assert.equal(b.props.disabled, false, `閉じた後も ${b.props["aria-label"]} が押せない`);
  });

  it("削除の処理中は背後の削除ボタンが押せず、押しても（古い描画のボタン）対象を差し替えない", async () => {
    const m = await opened();
    click(threadButton(m.render(), "t2"));
    const staleT2 = deleteButton(region(m.render(), "t2"), "この質問を削除");
    click(deleteButton(region(m.render(), "t1"), "この質問を削除"), m.target("q"));
    click(button(dialog(m.render()), "削除する"));
    const tree = m.render();
    for (const b of deleteButtonsIn(tree)) assert.equal(b.props.disabled, true, `処理中に ${b.props["aria-label"]} が押せる`);
    click(staleT2, m.target("t2"));
    const d = dialog(m.render());
    assert.ok(text(d).includes("「t1 の質問本文」"), `処理中に対象が差し替わった：${text(d)}`);
    assert.equal(deleteReqs(m).length, 1);
  });
});

describe("AdminQuestions 削除（追加）：以前の既知の問題（処理中の差し替え・開いた後の件数）", () => {
  it(
    "削除の処理中に別の行の削除ボタン（キーボードでダイアログの外へ移れる）を押しても、対象と失敗の文言が入れ替わらない",
    async () => {
      const { m } = await questionDialog();
      click(button(dialog(m.render()), "削除する"));
      click(threadButton(m.render(), "t2"));
      click(deleteButton(region(m.render(), "t2"), "この質問を削除"), m.target("t2"));
      deleteReqs(m)[0].release(res({ error: "x" }, { status: 500, ok: false, url: DEL_URL("t1") }));
      await settle();
      const d = dialog(m.render());
      assert.ok(text(d).includes("「t1 の質問本文」"), `t1 の失敗が別の対象のダイアログに出た：${text(d)}`);
    }
  );

  it(
    "ダイアログを開いた後にその質問へ回答が保存されたら、確認の文言の返信の件数も変わる（古い件数のまま削除させない）",
    async () => {
      const m = await opened();
      click(threadButton(m.render(), "t2"));
      click(deleteButton(region(m.render(), "t2"), "この質問を削除"), m.target("t2"));
      change(textareaOf(m.render(), "t2"), "t2 への回答");
      click(button(region(m.render(), "t2"), "回答を送信"));
      m.reqs
        .find((r) => r.url === "/api/admin/comments/t2/replies")!
        .release(res({ thread: thread("t2", { replies: [reply("r7", "t2 への回答", true, "講師ビー")], replyCount: 1, answered: true }) }, { url: `${DEL_URL("t2")}/replies` }));
      await settle();
      assert.ok(text(dialog(m.render())).includes("返信 1 件"), `確認の文言が古い：${text(dialog(m.render()))}`);
    }
  );
});
