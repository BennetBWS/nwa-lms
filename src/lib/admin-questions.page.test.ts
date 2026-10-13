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

// #32 A-2 管理画面の質問対応ページ：page.tsx（// @ts-nocheck）の AdminQuestions を
// 1. ソースで検査する（ナビ・pages への登録、authFetch、Enter で送信しない、二重送信の防止、生徒側を変えていない）
// 2. typescript の transpileModule で JSX から変換し、偽の React で「描画」して表示・状態遷移・リクエストを確かめる
//    （admin-students.render.page.test.ts と同じ器）
// DOM・DB・ネットワークなし。データはすべてダミー。
//
// 検証しないこと：setState による再描画（テストが render() を呼んだときだけ描画）、key の重複、CSS の見た目、
// 実際のブラウザでの IME の挙動（Enter の扱いは「keydown を扱わない・form にしない」ことをソースと木で確かめる）。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const compSrc = component("AdminQuestions");
const questionsSrc = component("Questions");

// ───────────── ソースの検査 ─────────────

describe("AdminQuestions：配線", () => {
  it("adminNav に「質問対応」（admin-questions）があり、studentNav にはない", () => {
    const sidebar = component("Sidebar");
    const admin = sidebar.slice(sidebar.indexOf("const adminNav"), sidebar.indexOf("const nav ="));
    const student = sidebar.slice(sidebar.indexOf("const studentNav"), sidebar.indexOf("const adminNav"));
    assert.match(admin, /\{ id: "admin-questions", icon: MessageSquare, label: "質問対応" \}/);
    assert.doesNotMatch(student, /admin-questions/);
  });

  it("pages に AdminQuestions を登録する", () => {
    assert.match(src, /"admin-questions": <AdminQuestions \/>,/);
  });

  it("admin-questions と comment-form から必要な関数を import する", () => {
    const m = src.match(/import \{([^}]*)\} from "@\/lib\/admin-questions";/);
    assert.ok(m, "admin-questions の import がない");
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const n of [
      "ADMIN_QUESTION_TABS",
      "DEFAULT_ADMIN_QUESTION_TAB",
      "REPLY_SENT_MESSAGE",
      "adminReplyUrl",
      "adminThreadListUrl",
      "adminThreadsEmptyMessage",
      "adminThreadsMoreHint",
      "interpretReplyResponse",
      "replaceThreadRow",
      "toCourseOptions",
    ]) {
      assert.ok(names.includes(n), n);
    }
    assert.match(src, /import \{ commentFormState, commentSubmitErrorMessage, isUncertainSubmitError \} from "@\/lib\/comment-form";/);
  });

  it("API は authFetch で呼び、素の fetch は使わない", () => {
    assert.match(compSrc, /authFetch\(url\)/);
    assert.match(compSrc, /authFetch\("\/api\/admin\/courses"\)/);
    assert.match(compSrc, /authFetch\(adminReplyUrl\(id\), \{ method: "POST"/);
    assert.doesNotMatch(compSrc, /(?<![\w$.])fetch\s*\(/);
  });

  it("送信中は ref で同じ質問への再送を止める（authFetch より前で判定する）", () => {
    const guard = compSrc.indexOf("sendingRef.current.has(id)) return;");
    const add = compSrc.indexOf("sendingRef.current.add(id);");
    const post = compSrc.indexOf("authFetch(adminReplyUrl(id)");
    assert.ok(guard >= 0 && add > guard && post > add, "判定・印付け・送信の順になっていない");
    assert.match(compSrc, /finally \{\s*sendingRef\.current\.delete\(id\);/);
  });

  it("Enter で送信しない：keydown を扱わず、form にしない", () => {
    assert.doesNotMatch(compSrc, /onKey(Down|Press|Up)\b/);
    assert.doesNotMatch(compSrc, /<form\b|onSubmit/);
  });

  it("メールアドレス・avatar・userId を参照しない", () => {
    assert.doesNotMatch(compSrc, /\.email\b|\.avatar\b|userId/);
  });

  it("生徒側の Questions には回答欄・管理の関数を入れていない", () => {
    assert.doesNotMatch(questionsSrc, /adminThreadListUrl|adminReplyUrl|commentFormState|<textarea\b|method:\s*"POST"/);
  });
});

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

// ───────────── 描画 ─────────────

describe("AdminQuestions 描画：前提", () => {
  it("JSX の変換：診断なしで、import / export を含まない", () => {
    assert.deepEqual(transpiled.diagnostics ?? [], []);
    assert.doesNotMatch(compiled, /^\s*(import|export)\b/m);
  });
});

describe("AdminQuestions 描画：読み込み", () => {
  it("最初は読み込み中で、未回答の一覧とコースを 1 回ずつ読む（再描画で読み直さない）", () => {
    const m = mount();
    const tree = m.render();
    assert.ok(text(tree).includes("Loading..."), "読み込み中が出ていない");
    assert.deepEqual(m.reqs.map((r) => r.url), ["/api/comments?status=unanswered", "/api/admin/courses"]);
    m.render();
    assert.equal(m.reqs.length, 2);
    assert.equal(tab(tree, "未回答").props["aria-pressed"], true);
    assert.equal(tab(tree, "回答済み").props["aria-pressed"], false);
  });

  it("一覧：名前（無効化された受講生は「受講生」、講師は名前と「講師」バッジ）・状態・場所", async () => {
    const m = await loaded();
    const tree = m.render();
    const rows = threadButtons(tree);
    assert.equal(rows.length, 2);
    assert.ok(text(rows[0]).startsWith("受講生"), `匿名の表示でない：${text(rows[0])}`);
    assert.ok(text(rows[0]).includes("未回答"), "状態のバッジがない");
    assert.ok(text(rows[0]).includes("STEP1 ダミー / レッスン1"), "場所がない");
    const badges = findAll(rows[1], (e) => e.type === Badge).map((b) => text(b));
    assert.ok(text(rows[1]).includes("講師シー"), "講師の名前がない");
    assert.ok(badges.includes("講師"), "講師バッジがない");
  });

  it("失敗（500）は role=alert と再読み込み。押すと同じ URL を読み直す", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res({ error: "Internal server error" }, { status: 500, ok: false }));
    m.reqs[1].release(res(COURSES));
    await settle();
    const tree = m.render();
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1);
    assert.ok(text(alerts[0]).includes("質問を読み込めませんでした"), "失敗の文言がない");
    click(button(tree, "再読み込み"));
    assert.equal(m.reqs.length, 3);
    assert.equal(m.reqs[2].url, "/api/comments?status=unanswered");
    // 読み込み中の連打では読み直さない
    click(button(tree, "再読み込み"));
    assert.equal(m.reqs.length, 3, "読み込み中に二重に読んだ");
  });

  it("通信エラー・形の違う本文も失敗", async () => {
    for (const settleWith of [(r: Req) => r.fail(new Error("network")), (r: Req) => r.release(res([]))]) {
      const m = mount();
      m.render();
      settleWith(m.reqs[0]);
      await settle();
      assert.equal(byRole(m.render(), "alert").length, 1);
    }
  });

  it("セッション切れ（401）は失敗にせず読み込み中のまま。その後タブを押しても読まない", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res(null, { status: 401, ok: false }));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.ok(text(tree).includes("Loading..."), "読み込み中のままでない");
    click(tab(tree, "回答済み"));
    assert.equal(m.reqs.length, 2, "セッション切れの後に読んだ");
  });

  it("0 件なら空の文言（タブごと）", async () => {
    const m = await loaded({ threads: [], nextCursor: null });
    assert.ok(text(m.render()).includes("未回答の質問はありません"), "空の文言がない");
  });

  it("0 件で続きがあれば説明と「もっと見る」。押すと cursor 付きで読む", async () => {
    const m = await loaded({ threads: [], nextCursor: "123.t9" });
    const tree = m.render();
    assert.ok(text(tree).includes(adminQuestions.adminThreadsMoreHint("unanswered")), "説明がない");
    click(button(tree, "もっと見る"));
    assert.equal(m.reqs[2].url, "/api/comments?status=unanswered&cursor=123.t9");
    m.reqs[2].release(res({ threads: [thread("t9")], nextCursor: null }));
    await settle();
    const after = m.render();
    assert.equal(threadButtons(after).length, 1);
    assert.ok(statusTexts(after).includes("1 件を追加しました"), "追加の知らせがない");
  });
});

describe("AdminQuestions 描画：タブ・コース", () => {
  it("タブを切り替えると status を変えて 1 ページ目から読み、前のタブの応答は捨てる", async () => {
    const m = mount();
    let tree = m.render();
    click(tab(tree, "回答済み"));
    assert.equal(m.reqs[2].url, "/api/comments?status=answered");
    m.reqs[2].release(res({ threads: [thread("a1", { answered: true })], nextCursor: null }));
    m.reqs[0].release(res(PAGE1));
    await settle();
    tree = m.render();
    assert.equal(threadButtons(tree).length, 1, "古いタブの応答が混ざった");
    assert.ok(text(threadButtons(tree)[0]).includes("回答済み"), "回答済みの行でない");
    assert.equal(tab(tree, "回答済み").props["aria-pressed"], true);
    click(tab(tree, "すべて"));
    assert.equal(m.reqs[3].url, "/api/comments");
  });

  it("コースの選択肢は /api/admin/courses から。選ぶと courseId 付きで読み、「すべてのコース」で外す", async () => {
    const m = await loaded();
    let tree = m.render();
    const options = findAll(courseSelect(tree), (e) => e.type === "option").map((o) => [o.props.value, text(o)]);
    assert.deepEqual(options, [
      ["", "すべてのコース"],
      ["co1", "STEP1 ダミー"],
      ["co2", "STEP2 ダミー"],
    ]);
    change(courseSelect(tree), "co2");
    assert.equal(m.reqs[2].url, "/api/comments?status=unanswered&courseId=co2");
    m.reqs[2].release(res({ threads: [], nextCursor: null }));
    await settle();
    tree = m.render();
    assert.equal(courseSelect(tree).props.value, "co2");
    assert.ok(text(tree).includes("このコースに未回答の質問はありません"), "コースで絞ったときの空の文言がない");
    // タブを切り替えてもコースは保つ
    click(tab(tree, "すべて"));
    assert.equal(m.reqs[3].url, "/api/comments?courseId=co2");
    change(courseSelect(m.render()), "");
    assert.equal(m.reqs[4].url, "/api/comments");
  });

  it("コースを読めなければ「すべてのコース」だけにして案内を出す（一覧は表示する）", async () => {
    const m = await loaded(PAGE1, { error: "Forbidden" });
    const tree = m.render();
    const options = findAll(courseSelect(tree), (e) => e.type === "option");
    assert.equal(options.length, 1);
    assert.ok(text(tree).includes("コースの一覧を読み込めませんでした"), "案内がない");
    assert.equal(threadButtons(tree).length, 2);
  });
});

describe("AdminQuestions 描画：回答欄", () => {
  it("開くと全文・返信の案内・回答欄（ラベル付き、0 / 2000、送信不可）。閉じていると回答欄はない", async () => {
    const m = await loaded();
    let tree = m.render();
    assert.equal(textareas(tree).length, 0, "閉じているのに回答欄がある");
    click(threadButtons(tree)[0]);
    tree = m.render();
    const region = byRole(tree, "region")[0];
    assert.ok(text(region).includes("t1 の質問本文"), "全文がない");
    assert.ok(text(region).includes("まだ返信はありません"), "返信なしの案内がない");
    const input = textarea(tree);
    const labels = findAll(tree, (e) => e.type === "label" && e.props.htmlFor === input.props.id);
    assert.equal(labels.length, 1, "回答欄のラベルがない");
    assert.equal(input.props.value, "");
    assert.ok(text(tree).includes("0 / 2000"), "文字数の表示がない");
    assert.equal(button(tree, "回答を送信").props.disabled, true);
  });

  it("Enter で送信しない：keydown を持たず、form の中に置かない", async () => {
    const m = await typed("質問への回答");
    const tree = m.render();
    const input = textarea(tree);
    for (const k of ["onKeyDown", "onKeyPress", "onKeyUp"]) assert.equal(input.props[k], undefined, k);
    assert.equal(findAll(tree, (e) => e.type === "form").length, 0, "form がある");
  });

  it("入力すると文字数が変わり送信できる。空白だけ・見えない文字だけ・2001 字は送れない", async () => {
    const m = await typed("  回答です  ");
    let tree = m.render();
    assert.ok(text(tree).includes("4 / 2000"), "前後の空白を除いた文字数でない");
    assert.equal(button(tree, "回答を送信").props.disabled, false);
    for (const v of ["   ", "\u200B\u3000"]) {
      change(textarea(tree), v);
      tree = m.render();
      assert.equal(button(tree, "回答を送信").props.disabled, true, JSON.stringify(v));
    }
    change(textarea(tree), "あ".repeat(2001));
    tree = m.render();
    assert.equal(button(tree, "回答を送信").props.disabled, true);
    assert.ok(text(tree).includes("2001 / 2000（1 文字オーバー）"), "超えた表示がない");
    assert.equal(textarea(tree).props["aria-invalid"], true);
    // 送れない状態で押しても（disabled の反映前など）送らない
    click(button(tree, "回答を送信"));
    assert.equal(m.reqs.length, 2);
  });

  it("送信：POST /api/admin/comments/<id>/replies に content だけを送り、送信中はボタンを無効にして再送しない", async () => {
    const m = await typed("講師の回答です");
    const before = m.render();
    const sendButton = button(before, "回答を送信");
    click(sendButton);
    assert.equal(m.reqs.length, 3);
    const req = m.reqs[2];
    assert.equal(req.url, "/api/admin/comments/t1/replies");
    assert.equal(req.init?.method, "POST");
    assert.deepEqual(req.init?.headers, { "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(String(req.init?.body)), { content: "講師の回答です" });
    // 同じ描画のボタンをもう一度押す（disabled が反映される前の連打）
    click(sendButton);
    const during = m.render();
    click(button(during, "送信中..."));
    assert.equal(m.reqs.length, 3, "送信中に再送した");
    assert.equal(button(during, "送信中...").props.disabled, true);
    assert.equal(textarea(during).props.readOnly, true, "送信中に入力を変えられる");
  });

  it("成功：応答の thread で行を置き換え（未回答タブでも残して「回答済み」に）、入力を空にして知らせる", async () => {
    const m = await typed("講師の回答です");
    click(button(m.render(), "回答を送信"));
    m.reqs[2].release(res({ thread: answeredT1() }, { status: 201, url: `${ORIGIN}/api/admin/comments/t1/replies` }));
    await settle();
    const tree = m.render();
    const rows = threadButtons(tree);
    assert.equal(rows.length, 2, "行が消えた・増えた");
    assert.ok(text(rows[0]).includes("回答済み"), "バッジが回答済みにならない");
    assert.ok(text(rows[0]).includes("返信 1件"), "返信数が変わらない");
    const region = byRole(tree, "region")[0];
    assert.ok(text(region).includes("講師の回答です"), "返信が表示されない");
    assert.equal(textarea(tree).props.value, "", "入力が残っている");
    assert.equal(textarea(tree).props.readOnly, false);
    assert.ok(statusTexts(tree).includes("回答を送信しました"), "送信の知らせがない");
    assert.equal(byRole(tree, "alert").length, 0);
    // 送信が終われば同じ質問にもう一度回答できる
    change(textarea(tree), "追記です");
    click(button(m.render(), "回答を送信"));
    assert.equal(m.reqs.length, 4);
  });

  it("失敗（400 not_a_question）：入力を残し、reason の文言を role=alert で出す。もう一度送れる", async () => {
    const m = await typed("講師の回答です");
    click(button(m.render(), "回答を送信"));
    m.reqs[2].release(res({ error: "Invalid request", reason: "not_a_question" }, { status: 400, ok: false }));
    await settle();
    let tree = m.render();
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1);
    assert.equal(text(alerts[0]), commentForm.commentSubmitErrorMessage({ httpStatus: 400, reason: "not_a_question" }));
    assert.equal(textarea(tree).props.value, "講師の回答です", "入力が消えた");
    assert.equal(button(tree, "回答を送信").props.disabled, false);
    assert.ok(text(threadButtons(tree)[0]).includes("未回答"), "失敗したのに回答済みになった");
    click(button(tree, "回答を送信"));
    assert.equal(m.reqs.length, 4);
    tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0, "再送の間も前のエラーが残っている");
  });

  it("失敗（通信エラー・500・2xx で thread が読めない）はそれぞれの文言で、入力を残す", async () => {
    const cases: Array<[(r: Req) => void, string]> = [
      [(r) => r.fail(new Error("network")), commentForm.COMMENT_NETWORK_ERROR_MESSAGE],
      [(r) => r.release(res(null, { status: 500, ok: false, json: () => Promise.reject(new Error("not json")) })), commentForm.COMMENT_SERVER_ERROR_MESSAGE],
      [(r) => r.release(res({ ok: true }, { status: 201 })), commentForm.COMMENT_UNKNOWN_RESULT_MESSAGE],
    ];
    for (const [finish, message] of cases) {
      const m = await typed("講師の回答です");
      click(button(m.render(), "回答を送信"));
      finish(m.reqs[2]);
      await settle();
      const tree = m.render();
      assert.deepEqual(byRole(tree, "alert").map((a) => text(a)), [message]);
      assert.equal(textarea(tree).props.value, "講師の回答です");
    }
  });

  it("セッション切れ（401）の後は読み込み・送信をしない", async () => {
    const m = await typed("講師の回答です");
    click(button(m.render(), "回答を送信"));
    m.reqs[2].release(res(null, { status: 401, ok: false }));
    await settle();
    const tree = m.render();
    assert.equal(textarea(tree).props.value, "講師の回答です");
    click(button(tree, "回答を送信"));
    click(tab(tree, "すべて"));
    assert.equal(m.reqs.length, 3, "セッション切れの後に通信した");
  });

  it("タブを切り替えても入力は残る（同じ質問を開けば続きから書ける）", async () => {
    const m = await typed("書きかけ");
    click(tab(m.render(), "すべて"));
    m.reqs[2].release(res(PAGE1));
    await settle();
    click(threadButtons(m.render())[0]);
    assert.equal(textarea(m.render()).props.value, "書きかけ");
  });
});
