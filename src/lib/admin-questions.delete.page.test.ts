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
/** aria-label が label の削除ボタン（質問は「この質問を削除」、返信は「<名前> の返信を削除」） */
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
      ["この質問を削除", "講師ビー の返信を削除", "受講生エー の返信を削除"]
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
    click(deleteButton(m.render(), "受講生エー の返信を削除"), m.target("reply"));
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
    const long = "‮あ​い" + "う".repeat(60);
    const m = await opened({ threads: [thread("t1", { content: long })], nextCursor: null });
    click(deleteButton(m.render(), "この質問を削除"), m.target("q"));
    const t = text(dialog(m.render()));
    assert.ok(!t.includes("‮") && !t.includes("​"), "見えない文字が残っている");
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
    click(deleteButton(m.render(), "講師ビー の返信を削除"), trigger);
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
    assert.deepEqual(deleteButtonsIn(region(tree, "t1")).map((b) => b.props["aria-label"]), ["この質問を削除", "受講生エー の返信を削除"]);
    assert.ok(statusTexts(tree).includes(adminQuestions.REPLY_DELETED_NOW_UNANSWERED_MESSAGE), "知らせがない");
    assert.equal(m.focused(), deleteStatusEl(tree), "削除の知らせへフォーカスを移していない");
  });

  it("成功（返信）：回答済みのままなら「返信を削除しました」だけ", async () => {
    const m = await opened();
    click(deleteButton(m.render(), "受講生エー の返信を削除"), m.target("reply"));
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

  it("404（返信）：「すでに削除されています」と出して、その返信だけを除く", async () => {
    const m = await opened();
    click(deleteButton(m.render(), "講師ビー の返信を削除"), m.target("reply"));
    click(button(dialog(m.render()), "削除する"));
    deleteReqs(m)[0].release(res(null, { status: 404, ok: false, url: DEL_URL("r1") }));
    await settle();
    const tree = m.render();
    assert.deepEqual(rowIds(tree), ["t1", "t2"], "質問の行まで消した");
    assert.deepEqual(deleteButtonsIn(region(tree, "t1")).map((b) => b.props["aria-label"]), ["この質問を削除", "受講生エー の返信を削除"]);
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
