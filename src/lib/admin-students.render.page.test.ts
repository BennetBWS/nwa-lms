import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import ts from "typescript";
import { classifyAuthFailure } from "./client-session";
import * as view from "./admin-student-view";

// #32 生徒管理：page.tsx（// @ts-nocheck）の AdminStudents を typescript の transpileModule で変換し、
// 偽の React（useState / useRef / useEffect と要素の木）で「描画」して、表示とリクエストを確かめる。
// quiz-page.render.page.test.ts と同じ方式。DOM・DB・ネットワークなし。データはすべてダミー（example.com）。
//
// useEffect は依存配列が変わったときだけ（依存配列がなければ毎回）、描画の後に実行し、再実行の前に cleanup を呼ぶ。
// ref は描画のたびに前の描画の ref を外し（callback ref は null で呼ぶ・object ref は null にする）、新しい木の要素ごとに
// 偽の要素（focus() を呼ぶと focused() がその要素を返す。前の描画の偽の要素は isConnected が false になる）を付ける。
// 検証しないこと：setState による再描画（テストが render() を呼んだときだけ描画）、
// ModalPortal の Portal 化（admin-dialog.page*.test.ts）。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const compSrc = component("AdminStudents");
const transpiled = ts.transpileModule(compSrc, {
  fileName: "AdminStudents.jsx",
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

// ───────────── 偽の React ─────────────

type El = { type: unknown; props: Record<string, unknown>; children: Node[] };
type Node = El | string | number;

function stub(name: string) {
  const f = () => null;
  Object.defineProperty(f, "name", { value: name });
  return f;
}

const Button = stub("Button");
const ModalPortal = stub("ModalPortal");
const COMPONENTS = {
  ScrollArea: stub("ScrollArea"),
  FadeIn: stub("FadeIn"),
  Button,
  Badge: stub("Badge"),
  Avatar: stub("Avatar"),
  AvatarFallback: stub("AvatarFallback"),
  Search: stub("Search"),
  Plus: stub("Plus"),
  ArrowLeft: stub("ArrowLeft"),
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
  return { status: 200, ok: true, redirected: false, url: `${ORIGIN}/api/admin/students`, json: () => Promise.resolve(body), ...p };
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
  // 偽の DOM 要素。focus() を呼ぶと、その要素（El）が focused になる
  type FakeNode = { el: El; isConnected: boolean; focus: () => void };
  let focused: El | null = null;
  let attached: Array<{ ref: unknown; node: FakeNode }> = [];

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
  const window = { addEventListener: () => {}, removeEventListener: () => {} };
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
    ...view,
    T,
    glassStyle: () => ({}),
    ...COMPONENTS,
  };
  const names = Object.keys(scope);
  const AdminStudents = new Function(...names, `${compiled}\nreturn AdminStudents;`)(...names.map((n) => scope[n])) as (
    props: Record<string, unknown>
  ) => El;

  const render = (): El => {
    si = 0;
    ri = 0;
    ei = 0;
    pending = [];
    const tree = AdminStudents({ setCurrentPage: () => {} });
    assertRenderable(tree);
    // 前の描画の ref を外し、新しい木の要素に付け直す
    for (const { ref, node } of attached) {
      node.isConnected = false;
      if (typeof ref === "function") ref(null);
      else if (ref && typeof ref === "object") (ref as { current: unknown }).current = null;
    }
    attached = [];
    for (const el of findAll(tree, (e) => e.props.ref !== undefined && e.props.ref !== null)) {
      const node: FakeNode = { el, isConnected: true, focus: () => (focused = el) };
      const ref = el.props.ref;
      if (typeof ref === "function") ref(node);
      else (ref as { current: unknown }).current = node;
      attached.push({ ref, node });
    }
    // 依存配列が変わった effect を実行する（前回の cleanup を先に呼ぶ）
    for (const { i, fn, deps } of pending) {
      effectSlots[i]?.cleanup?.();
      const cleanup = fn();
      effectSlots[i] = { deps, cleanup: typeof cleanup === "function" ? (cleanup as () => void) : undefined };
    }
    return tree;
  };
  // テストからフォーカスを動かす（タブのボタンを押す前にフォーカスを置く、など）
  const setFocused = (el: El | null) => {
    focused = el;
  };
  return { render, reqs, focused: () => focused, setFocused };
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
const nameButtons = (tree: El) => findAll(tree, (e) => e.type === "button" && e.props.title === "詳細を表示");
function nameButton(tree: El, name: string): El {
  const hit = nameButtons(tree).filter((b) => text(b).trim() === name);
  assert.equal(hit.length, 1, `名前のボタン「${name}」が 1 つでない`);
  return hit[0];
}
const searchInput = (tree: El) => {
  const hit = findAll(tree, (e) => e.type === "input" && e.props.type === "search");
  assert.equal(hit.length, 1, "検索欄が 1 つでない");
  return hit[0];
};
const type = (input: El, value: string) => (input.props.onChange as (e: unknown) => void)({ target: { value } });
const shownNames = (tree: El) => nameButtons(tree).map((b) => text(b).trim());

// ───────────── データ（ダミー） ─────────────

const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  email: `${id}@example.com`,
  avatar: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  completedLessons: 5,
  totalLessons: 10,
  lastActive: "2026-09-30T16:00:00.000Z",
  status: "active",
  deactivatedAt: null,
  currentCourse: { id: "c2", name: "STEP2 ダミー" },
  ...extra,
});

const LIST = [
  row("stu/a", "あおき"),
  row("stu_b", "いとう", { currentCourse: null }),
  row("stu_c", "うえだ", { status: "deactivated", deactivatedAt: "2026-09-01T00:00:00.000Z", completedLessons: 0, lastActive: null }),
];

const detailOf = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  email: `${id}@example.com`,
  createdAt: "2026-04-01T00:00:00.000Z",
  status: "active",
  deactivatedAt: null,
  currentCourse: { id: "c2", name: "STEP2 ダミー" },
  courseProgress: [
    { courseId: "c1", courseName: "STEP1 ダミー", totalLessons: 4, completedLessons: 4, lastCompletedAt: "2026-09-02T00:00:00.000Z" },
    { courseId: "c2", courseName: "STEP2 ダミー", totalLessons: 3, completedLessons: 1, lastCompletedAt: null },
  ],
  quizAttempts: [{ id: "qa1", quizTitle: "ダミー修了テスト", quizType: "FINAL", score: 67, passed: false, createdAt: "2026-09-10T00:00:00.000Z" }],
  assignments: [{ id: "as1", title: "ダミー課題", courseName: "STEP1 ダミー", status: "REVIEW", deadline: "2026-10-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" }],
  ...extra,
});

async function loaded(body: unknown = LIST) {
  const m = mount();
  m.render();
  assert.equal(m.reqs.length, 1);
  m.reqs[0].release(res(body));
  await settle();
  return m;
}

// ───────────── テスト ─────────────

describe("AdminStudents 描画：前提", () => {
  it("JSX の変換：診断なしで、import / export を含まない", () => {
    assert.deepEqual(transpiled.diagnostics ?? [], []);
    assert.doesNotMatch(compiled, /^\s*(import|export)\b/m);
  });
});

describe("AdminStudents 描画：一覧の読み込み", () => {
  it("最初は読み込み中で、/api/admin/students?status=all を 1 回だけ読む", () => {
    const m = mount();
    const tree = m.render();
    assert.ok(text(tree).includes("Loading..."), "読み込み中が出ていない");
    assert.equal(m.reqs.length, 1);
    assert.equal(m.reqs[0].url, "/api/admin/students?status=all");
    m.render();
    assert.equal(m.reqs.length, 1);
  });

  it("失敗（500）は role=alert と再読み込み。押すともう一度読み、成功すれば一覧を出す", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res({ error: "Internal server error" }, { status: 500, ok: false }));
    await settle();
    let tree = m.render();
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1);
    assert.ok(text(alerts[0]).includes("受講生の一覧を読み込めませんでした"), "失敗の文言がない");
    click(button(tree, "再読み込み"));
    assert.equal(m.reqs.length, 2);
    assert.ok(text(m.render()).includes("Loading..."), "再読み込み中に読み込み中が出ていない");
    m.reqs[1].release(res(LIST));
    await settle();
    tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.deepEqual(shownNames(tree), ["あおき", "いとう"]);
  });

  it("通信エラー・配列でない本文も失敗", async () => {
    for (const settleWith of [(r: Req) => r.fail(new Error("network")), (r: Req) => r.release(res({ rows: [] }))]) {
      const m = mount();
      m.render();
      settleWith(m.reqs[0]);
      await settle();
      assert.equal(byRole(m.render(), "alert").length, 1);
    }
  });

  it("セッション切れ（401）は失敗にせず、読み込み中のまま（authFetch がサインアウトする）", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res(null, { status: 401, ok: false }));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.ok(text(tree).includes("Loading..."), "読み込み中のままでない");
  });

  it("0 人なら「受講生はまだいません」", async () => {
    const m = await loaded([]);
    assert.ok(text(m.render()).includes("受講生はまだいません"), "空の文言がない");
  });
});

describe("AdminStudents 描画：一覧・タブ・検索", () => {
  it("タブの件数、Course 列（現在のコース・全コース修了）、最終学習日（日本時間）", async () => {
    const m = await loaded();
    const t = text(m.render());
    for (const s of ["有効（2）", "無効（1）", "すべて（3）", "STEP2 ダミー", "全コース修了", "2026/10/01", "最終学習日"]) {
      assert.ok(t.includes(s), s);
    }
    assert.ok(!t.includes("Last Seen"), "Last Seen が残っている");
  });

  it("タブで切り替える（無効・すべて）", async () => {
    const m = await loaded();
    let tree = m.render();
    click(buttons(tree).find((b) => text(b).startsWith("無効（"))!);
    tree = m.render();
    assert.deepEqual(shownNames(tree), ["うえだ"]);
    assert.ok(text(tree).includes("無効化日 2026/09/01"), "無効化日がない");
    click(buttons(tree).find((b) => text(b).startsWith("すべて（"))!);
    assert.deepEqual(shownNames(m.render()), ["あおき", "いとう", "うえだ"]);
  });

  it("検索：名前・メールで絞り込み、タブの件数は変えない。一致しなければ「該当する受講生はいません」", async () => {
    const m = await loaded();
    type(searchInput(m.render()), "いと");
    let tree = m.render();
    assert.deepEqual(shownNames(tree), ["いとう"]);
    assert.equal(searchInput(tree).props.value, "いと");
    assert.ok(text(tree).includes("有効（2）"), "件数が検索後になっている");
    type(searchInput(tree), " STU_B@EXAMPLE ");
    assert.deepEqual(shownNames(m.render()), ["いとう"]);
    type(searchInput(m.render()), "zzz");
    tree = m.render();
    assert.deepEqual(shownNames(tree), []);
    assert.ok(text(tree).includes("該当する受講生はいません"), "該当なしの文言がない");
  });

  it("検索欄は placeholder と aria-label を持つ", async () => {
    const m = await loaded();
    const input = searchInput(m.render());
    assert.equal(input.props.placeholder, "名前・メールで検索");
    assert.ok(typeof input.props["aria-label"] === "string" && input.props["aria-label"] !== "", "aria-label がない");
  });
});

describe("AdminStudents 描画：詳細表示", () => {
  it("名前を押すと /api/admin/students/<encodeURIComponent(id)> を読み、詳細に切り替える", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "あおき"));
    assert.equal(m.reqs.length, 2);
    assert.equal(m.reqs[1].url, "/api/admin/students/stu%2Fa");
    let tree = m.render();
    assert.ok(text(tree).includes("Loading..."), "詳細の読み込み中が出ていない");
    assert.deepEqual(shownNames(tree), [], "詳細の読み込み中に一覧が出ている");
    m.reqs[1].release(res(detailOf("stu/a", "あおき")));
    await settle();
    tree = m.render();
    const t = text(tree);
    for (const s of [
      "あおき",
      "stu/a@example.com",
      "登録日",
      "2026/04/01",
      "有効",
      "現在のコース",
      "STEP2 ダミー",
      "コースごとの進捗",
      "STEP1 ダミー",
      "4 / 4 レッスン · 100% · 最終学習日 2026/09/02",
      "1 / 3 レッスン · 33%",
      "小テストの履歴",
      "ダミー修了テスト",
      "修了テスト · 2026/09/10",
      "67点",
      "不合格",
      "課題",
      "ダミー課題",
      "期限 2026/10/01",
      "確認待ち",
    ]) {
      assert.ok(t.includes(s), s);
    }
    assert.equal(byRole(tree, "progressbar").length, 2);
    assert.ok(buttonLabels(tree).includes("無効化"), "詳細に無効化ボタンがない");
  });

  it("履歴・課題が 0 件なら「受験履歴はありません」「課題はありません」、全修了なら「全コース修了」", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "いとう"));
    m.reqs[1].release(res(detailOf("stu_b", "いとう", { currentCourse: null, quizAttempts: [], assignments: [] })));
    await settle();
    const t = text(m.render());
    for (const s of ["受験履歴はありません", "課題はありません", "全コース修了"]) assert.ok(t.includes(s), s);
  });

  it("「一覧に戻る」で一覧に戻り、詳細を読み直さない", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "あおき"));
    m.reqs[1].release(res(detailOf("stu/a", "あおき")));
    await settle();
    click(button(m.render(), "一覧に戻る"));
    const tree = m.render();
    assert.deepEqual(shownNames(tree), ["あおき", "いとう"]);
    assert.ok(!text(tree).includes("コースごとの進捗"), "詳細が残っている");
    assert.equal(m.reqs.length, 2);
  });

  it("古い応答を捨てる：戻った後・別の受講生を開いた後に届いた応答は表示しない", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "あおき"));
    click(button(m.render(), "一覧に戻る"));
    click(nameButton(m.render(), "いとう"));
    assert.equal(m.reqs[2].url, "/api/admin/students/stu_b");
    // 先に開いた「あおき」の応答が後から届く
    m.reqs[1].release(res(detailOf("stu/a", "あおき")));
    await settle();
    let tree = m.render();
    assert.ok(text(tree).includes("Loading..."), "古い応答で読み込み中が終わった");
    assert.ok(!text(tree).includes("stu/a@example.com"), "古い応答を表示している");
    m.reqs[2].release(res(detailOf("stu_b", "いとう")));
    await settle();
    tree = m.render();
    assert.ok(text(tree).includes("stu_b@example.com"), "新しい応答を表示していない");
    assert.ok(!text(tree).includes("stu/a@example.com"), "古い応答を表示している");
  });

  it("戻った後に届いた応答・失敗で一覧が変わらない", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "あおき"));
    click(button(m.render(), "一覧に戻る"));
    m.reqs[1].fail(new Error("network"));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.deepEqual(shownNames(tree), ["あおき", "いとう"]);
  });

  it("別の受講生の本文（id が違う）は失敗として扱う", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "あおき"));
    m.reqs[1].release(res(detailOf("stu_b", "いとう")));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 1);
    assert.ok(!text(tree).includes("stu_b@example.com"), "別の受講生を表示している");
  });

  it("404 は「見つかりません」、500 は失敗と再読み込み（押すと同じ受講生を読み直す）", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "あおき"));
    m.reqs[1].release(res({ error: "Student not found" }, { status: 404, ok: false }));
    await settle();
    let tree = m.render();
    assert.equal(byRole(tree, "alert").length, 1);
    assert.ok(text(byRole(tree, "alert")[0]).includes(view.DETAIL_NOT_FOUND_MESSAGE), "404 の文言がない");
    assert.ok(!buttonLabels(tree).includes("再読み込み"), "404 に再読み込みがある");

    click(button(tree, "一覧に戻る"));
    click(nameButton(m.render(), "いとう"));
    m.reqs[2].release(res({ error: "Internal server error" }, { status: 500, ok: false }));
    await settle();
    tree = m.render();
    assert.ok(text(byRole(tree, "alert")[0]).includes(view.DETAIL_LOAD_FAILED_MESSAGE), "失敗の文言がない");
    click(button(tree, "再読み込み"));
    assert.equal(m.reqs[3].url, "/api/admin/students/stu_b");
    m.reqs[3].release(res(detailOf("stu_b", "いとう")));
    await settle();
    assert.ok(text(m.render()).includes("stu_b@example.com"), "再読み込みで表示されない");
  });

  it("詳細のセッション切れ（401）は失敗にせず、読み込み中のまま", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "あおき"));
    m.reqs[1].release(res(null, { status: 401, ok: false }));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.ok(text(tree).includes("Loading..."), "読み込み中のままでない");
  });
});

describe("AdminStudents 描画：招待・無効化・再有効化（従来と同じエンドポイント）", () => {
  it("招待：POST /api/admin/students/invite に名前とメールを送り、成功したら一覧を読み直す", async () => {
    const m = await loaded();
    click(button(m.render(), "招待"));
    let tree = m.render();
    const inputs = findAll(tree, (e) => e.type === "input" && e.props.type !== "search");
    assert.equal(inputs.length, 2);
    type(inputs[0], "ダミー 新規");
    type(inputs[1], "new-32@example.com");
    tree = m.render();
    click(button(tree, "招待する"));
    const req = m.reqs[1];
    assert.equal(req.url, "/api/admin/students/invite");
    assert.equal(req.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(req.init?.body)), { email: "new-32@example.com", name: "ダミー 新規" });
    req.release(res({ email: "new-32@example.com", password: "dummy-initial" }, { status: 201 }));
    await settle();
    assert.equal(m.reqs[2].url, "/api/admin/students?status=all");
    assert.ok(text(m.render()).includes("アカウント作成完了"), "招待の結果が出ていない");
  });

  it("一覧の無効化：確認ダイアログから PUT /api/admin/students/<id>/deactivate、成功で行を無効にして一覧を読み直す", async () => {
    const m = await loaded();
    const tree = m.render();
    const rowButtons = buttons(tree).filter((b) => text(b).trim() === "無効化");
    assert.equal(rowButtons.length, 2);
    click(rowButtons[0], { focus() {}, isConnected: true });
    let dialogTree = m.render();
    assert.equal(byRole(dialogTree, "dialog").length, 1);
    assert.ok(text(dialogTree).includes("あおき さんを無効化しますか？"), "確認の文言がない");
    click(button(dialogTree, "無効化する"));
    assert.equal(m.reqs[1].url, "/api/admin/students/stu%2Fa/deactivate");
    assert.equal(m.reqs[1].init?.method, "PUT");
    m.reqs[1].release(res({ id: "stu/a", status: "deactivated", deactivatedAt: "2026-10-08T00:00:00.000Z" }));
    await settle();
    assert.equal(m.reqs[2].url, "/api/admin/students?status=all");
    dialogTree = m.render();
    assert.ok(text(dialogTree).includes("無効（2）"), "行が無効になっていない");
    // 読み直しが終わるまではダイアログが開いたまま（従来どおり）
    m.reqs[2].release(res(LIST));
    await settle();
    assert.equal(byRole(m.render(), "dialog").length, 0);
  });

  it("詳細の再有効化：PUT .../reactivate、成功で詳細の状態も有効になる", async () => {
    const m = await loaded();
    let tree = m.render();
    click(buttons(tree).find((b) => text(b).startsWith("無効（"))!);
    click(nameButton(m.render(), "うえだ"));
    m.reqs[1].release(res(detailOf("stu_c", "うえだ", { status: "deactivated", deactivatedAt: "2026-09-01T00:00:00.000Z" })));
    await settle();
    tree = m.render();
    assert.ok(text(tree).includes("無効（無効化日 2026/09/01）"), "詳細に無効の状態がない");
    click(button(tree, "再有効化"));
    click(button(m.render(), "再有効化する"));
    assert.equal(m.reqs[2].url, "/api/admin/students/stu_c/reactivate");
    m.reqs[2].release(res({ id: "stu_c", status: "active", deactivatedAt: null }));
    await settle();
    m.reqs[3].release(res(LIST.map((r) => (r.id === "stu_c" ? { ...r, status: "active", deactivatedAt: null } : r))));
    await settle();
    tree = m.render();
    assert.equal(byRole(tree, "dialog").length, 0);
    assert.ok(buttonLabels(tree).includes("無効化"), "詳細のボタンが無効化に変わっていない");
    assert.ok(!text(tree).includes("無効（無効化日"), "詳細の状態が無効のまま");
  });
});

// ───────────── #32（テスト担当の追加）：応答の取り違え・同期・セッション切れ・Portal ─────────────

/** 本文（json）を後から返す応答 */
function deferredRes(p: Partial<FakeRes> = {}) {
  let resolveBody: (v: unknown) => void = () => {};
  let rejectBody: (e: unknown) => void = () => {};
  const body = new Promise<unknown>((ok, ng) => {
    resolveBody = ok;
    rejectBody = ng;
  });
  return { r: res(null, { ...p, json: () => body }), resolveBody, rejectBody };
}

async function openedDetail(id: string, name: string, extra: Record<string, unknown> = {}) {
  const m = await loaded();
  let tree = m.render();
  if (extra.status === "deactivated") {
    click(buttons(tree).find((b) => text(b).startsWith("すべて（"))!);
    tree = m.render();
  }
  click(nameButton(tree, name));
  const req = m.reqs.at(-1)!;
  req.release(res(detailOf(id, name, extra)));
  await settle();
  return m;
}

describe("AdminStudents 描画：古い応答の破棄（追加）", () => {
  it("新しい受講生の応答が先、古い応答が後から届いても、新しい受講生のまま", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "あおき"));
    click(button(m.render(), "一覧に戻る"));
    click(nameButton(m.render(), "いとう"));
    m.reqs[2].release(res(detailOf("stu_b", "いとう")));
    await settle();
    m.reqs[1].release(res(detailOf("stu/a", "あおき")));
    await settle();
    const t = text(m.render());
    assert.ok(t.includes("stu_b@example.com"), "新しい受講生が表示されていない");
    assert.ok(!t.includes("stu/a@example.com"), "古い応答で上書きされた");
  });

  it("応答の本文（json）が切り替えの後に届いても捨てる", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "あおき"));
    const d = deferredRes();
    m.reqs[1].release(d.r);
    await settle();
    click(button(m.render(), "一覧に戻る"));
    click(nameButton(m.render(), "いとう"));
    d.resolveBody(detailOf("stu/a", "あおき"));
    await settle();
    const tree = m.render();
    assert.ok(text(tree).includes("Loading..."), "古い本文で読み込み中が終わった");
    assert.ok(!text(tree).includes("stu/a@example.com"), "古い本文を表示している");
  });

  it("切り替えの後に古い応答が失敗しても、新しい受講生の表示に失敗が出ない", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "あおき"));
    click(button(m.render(), "一覧に戻る"));
    click(nameButton(m.render(), "いとう"));
    m.reqs[1].fail(new Error("network"));
    m.reqs[2].release(res(detailOf("stu_b", "いとう")));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.ok(text(tree).includes("stu_b@example.com"), "新しい受講生が表示されていない");
  });

  it("前の受講生を表示した後、別の受講生を開くと、読み込み中に前の人の情報が残らない", async () => {
    const m = await openedDetail("stu/a", "あおき");
    assert.ok(text(m.render()).includes("stu/a@example.com"), "前提：あおきが表示されていない");
    click(button(m.render(), "一覧に戻る"));
    click(nameButton(m.render(), "いとう"));
    const t = text(m.render());
    assert.ok(t.includes("Loading..."), "読み込み中でない");
    for (const s of ["stu/a@example.com", "ダミー修了テスト", "ダミー課題", "コースごとの進捗"]) {
      assert.ok(!t.includes(s), `前の受講生の ${s} が残っている`);
    }
  });

  it("同じ受講生を開き直すと、もう一度取得する", async () => {
    const m = await openedDetail("stu/a", "あおき");
    click(button(m.render(), "一覧に戻る"));
    click(nameButton(m.render(), "あおき"));
    assert.equal(m.reqs.at(-1)!.url, "/api/admin/students/stu%2Fa");
    assert.equal(m.reqs.length, 3);
  });
});

describe("AdminStudents 描画：セッション切れ・失敗の種類（追加）", () => {
  const LOGIN = `${ORIGIN}/login?callbackUrl=%2F`;

  it("一覧：/login へのリダイレクトはセッション切れ（読み込み中のまま、再取得しない）", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res("<html>", { redirected: true, url: LOGIN }));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.ok(text(tree).includes("Loading..."), "読み込み中のままでない");
    assert.equal(m.reqs.length, 1);
  });

  it("一覧：/login 以外へのリダイレクト・403 は失敗", async () => {
    for (const p of [{ redirected: true, url: `${ORIGIN}/elsewhere` }, { status: 403, ok: false }]) {
      const m = mount();
      m.render();
      m.reqs[0].release(res(LIST, p));
      await settle();
      assert.equal(byRole(m.render(), "alert").length, 1, JSON.stringify(p));
    }
  });

  it("詳細：/login へのリダイレクトはセッション切れ（読み込み中のまま）", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "あおき"));
    m.reqs[1].release(res("<html>", { redirected: true, url: LOGIN }));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.ok(text(tree).includes("Loading..."), "読み込み中のままでない");
  });

  it("詳細：403・JSON でない本文・/login 以外へのリダイレクトは「読み込めませんでした」と再読み込み（404 の文言ではない）", async () => {
    const cases: Array<Partial<FakeRes>> = [
      { status: 403, ok: false },
      { json: () => Promise.reject(new SyntaxError("Unexpected token <")) },
      { redirected: true, url: `${ORIGIN}/elsewhere` },
      { redirected: true, status: 404, ok: false, url: `${ORIGIN}/elsewhere` },
    ];
    for (const p of cases) {
      const m = await loaded();
      click(nameButton(m.render(), "あおき"));
      m.reqs[1].release(res(detailOf("stu/a", "あおき"), p));
      await settle();
      const tree = m.render();
      const alerts = byRole(tree, "alert");
      assert.equal(alerts.length, 1, JSON.stringify(p));
      assert.ok(text(alerts[0]).includes(view.DETAIL_LOAD_FAILED_MESSAGE), `失敗の文言でない：${JSON.stringify(p)}`);
      assert.ok(!text(tree).includes("stu/a@example.com"), "失敗なのに詳細を表示している");
      assert.ok(buttonLabels(tree).includes("再読み込み"), "再読み込みがない");
    }
  });

  it("詳細の 404 から一覧に戻ると、一覧はそのまま（読み直さない）", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "あおき"));
    m.reqs[1].release(res({ error: "Student not found" }, { status: 404, ok: false }));
    await settle();
    click(button(m.render(), "一覧に戻る"));
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.deepEqual(shownNames(tree), ["あおき", "いとう"]);
    assert.equal(m.reqs.length, 2);
  });
});

describe("AdminStudents 描画：無効化・再有効化と一覧・詳細の同期（追加）", () => {
  it("詳細から無効化：PUT の成功直後（一覧の読み直し前）に詳細が無効になり、ボタンが再有効化に変わる", async () => {
    const m = await openedDetail("stu/a", "あおき");
    click(button(m.render(), "無効化"), { focus() {}, isConnected: true });
    click(button(m.render(), "無効化する"));
    assert.equal(m.reqs[2].url, "/api/admin/students/stu%2Fa/deactivate");
    m.reqs[2].release(res({ id: "stu/a", status: "deactivated", deactivatedAt: "2026-10-08T15:30:00.000Z" }));
    await settle();
    let tree = m.render();
    assert.equal(m.reqs[3].url, "/api/admin/students?status=all");
    assert.ok(text(tree).includes("無効（無効化日 2026/10/09）"), "詳細の状態が無効（日本時間の日付）になっていない");
    // 一覧の読み直しが失敗しても、一覧の行は無効のまま（PUT の応答で更新済み）
    m.reqs[3].release(res({ error: "x" }, { status: 500, ok: false }));
    await settle();
    tree = m.render();
    assert.equal(byRole(tree, "dialog").length, 0);
    assert.ok(buttonLabels(tree).includes("再有効化"), "詳細のボタンが再有効化になっていない");
    click(button(tree, "一覧に戻る"));
    tree = m.render();
    assert.ok(text(tree).includes("無効（2）"), "一覧のタブの件数が更新されていない");
    assert.deepEqual(shownNames(tree), ["いとう"], "有効タブに無効化した受講生が残っている");
  });

  it("詳細から無効化して失敗：ダイアログに文言、詳細は有効のまま、一覧を読み直さない", async () => {
    const m = await openedDetail("stu/a", "あおき");
    click(button(m.render(), "無効化"));
    click(button(m.render(), "無効化する"));
    m.reqs[2].release(res({ error: "Forbidden" }, { status: 403, ok: false }));
    await settle();
    const tree = m.render();
    const dialog = byRole(tree, "dialog");
    assert.equal(dialog.length, 1);
    assert.ok(text(dialog[0]).includes(view.statusActionErrorMessage(403)), "403 の文言がない");
    assert.ok(!text(tree).includes("無効（無効化日"), "失敗なのに詳細が無効になった");
    assert.equal(m.reqs.length, 3, "失敗なのに一覧を読み直した");
  });

  it("別の受講生の状態の応答（id が違う）は成功として扱わない", async () => {
    const m = await openedDetail("stu/a", "あおき");
    click(button(m.render(), "無効化"));
    click(button(m.render(), "無効化する"));
    m.reqs[2].release(res({ id: "stu_b", status: "deactivated", deactivatedAt: "2026-10-08T00:00:00.000Z" }));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "dialog").length, 1);
    assert.ok(!text(tree).includes("無効（無効化日"), "別の受講生の応答で詳細が変わった");
  });

  it("一覧で再有効化：無効タブから行が消え、有効タブに出る", async () => {
    const m = await loaded();
    click(buttons(m.render()).find((b) => text(b).startsWith("無効（"))!);
    click(button(m.render(), "再有効化"));
    click(button(m.render(), "再有効化する"));
    assert.equal(m.reqs[1].url, "/api/admin/students/stu_c/reactivate");
    m.reqs[1].release(res({ id: "stu_c", status: "active", deactivatedAt: null }));
    await settle();
    m.reqs[2].release(res(LIST.map((r) => (r.id === "stu_c" ? { ...r, status: "active", deactivatedAt: null } : r))));
    await settle();
    let tree = m.render();
    assert.deepEqual(shownNames(tree), []);
    assert.ok(text(tree).includes("無効（0）"), "無効の件数が 0 でない");
    click(buttons(tree).find((b) => text(b).startsWith("有効（"))!);
    tree = m.render();
    assert.deepEqual(shownNames(tree), ["あおき", "いとう", "うえだ"]);
  });
});

describe("AdminStudents 描画：検索・Course 列・ダイアログ（追加）", () => {
  it("検索語は詳細を開いて戻った後も残り、絞り込みも保たれる", async () => {
    const m = await loaded();
    type(searchInput(m.render()), "いと");
    click(nameButton(m.render(), "いとう"));
    m.reqs[1].release(res(detailOf("stu_b", "いとう")));
    await settle();
    click(button(m.render(), "一覧に戻る"));
    const tree = m.render();
    assert.equal(searchInput(tree).props.value, "いと");
    assert.deepEqual(shownNames(tree), ["いとう"]);
  });

  it("検索はタブの中だけで絞る（有効タブで無効の受講生は出ない）", async () => {
    const m = await loaded();
    type(searchInput(m.render()), "うえだ");
    let tree = m.render();
    assert.deepEqual(shownNames(tree), []);
    assert.ok(text(tree).includes("該当する受講生はいません"), "該当なしの文言がない");
    click(buttons(tree).find((b) => text(b).startsWith("すべて（"))!);
    tree = m.render();
    assert.deepEqual(shownNames(tree), ["うえだ"]);
  });

  it("見えない空白だけの検索語は全件（\\u3000・\\uFEFF）", async () => {
    const m = await loaded();
    type(searchInput(m.render()), "\u3000\uFEFF");
    assert.deepEqual(shownNames(m.render()), ["あおき", "いとう"]);
  });

  it("Course 列：レッスンが 1 件もないときは「—」（全コース修了ではない）", async () => {
    const m = await loaded([row("stu_z", "ぜろ", { currentCourse: null, totalLessons: 0, completedLessons: 0, lastActive: null })]);
    const t = text(m.render());
    assert.ok(!t.includes("全コース修了"), "レッスン 0 件で全コース修了と出ている");
    assert.ok(t.includes("—"), "「—」がない");
  });

  it("詳細：レッスンが 1 件もないなら「現在のコース」は「—」", async () => {
    const m = await openedDetail("stu_b", "いとう", {
      currentCourse: null,
      courseProgress: [{ courseId: "c0", courseName: "空のコース", totalLessons: 0, completedLessons: 0, lastCompletedAt: null }],
    });
    const t = text(m.render());
    assert.ok(t.includes("0 / 0 レッスン · 0%"), "0 件のコースの進捗がない");
    assert.ok(!t.includes("全コース修了"), "レッスン 0 件で全コース修了と出ている");
  });

  it("確認ダイアログ・招待モーダルは ModalPortal の中に描画される（詳細から開いた場合も）", async () => {
    const m = await openedDetail("stu/a", "あおき");
    click(button(m.render(), "無効化"));
    let tree = m.render();
    const portals = findAll(tree, (e) => e.type === ModalPortal);
    assert.equal(portals.length, 1, "ModalPortal が 1 つでない");
    assert.equal(byRole(portals[0], "dialog").length, 1, "確認ダイアログが ModalPortal の中にない");
    assert.equal(byRole(tree, "dialog").length, 1);

    const m2 = await loaded();
    click(button(m2.render(), "招待"));
    tree = m2.render();
    const p2 = findAll(tree, (e) => e.type === ModalPortal);
    assert.equal(p2.length, 1);
    assert.ok(text(p2[0]).includes("生徒を招待"), "招待モーダルが ModalPortal の中にない");
  });
});

describe("AdminStudents 描画：フォーカスの移動", () => {
  const headingOf = (tree: El, label: string) => {
    const hit = findAll(tree, (e) => (e.type === "h2" || e.type === "h3") && text(e).trim() === label);
    assert.equal(hit.length, 1, `見出し「${label}」が 1 つでない`);
    return hit[0];
  };
  const focusedLabel = (m: { focused: () => El | null }) => {
    const f = m.focused();
    return f === null ? null : `${String(f.type)}:${text(f).trim()}`;
  };
  const tab = (tree: El, prefix: string) => {
    const hit = buttons(tree).find((b) => b.props.role === "tab" && text(b).startsWith(prefix));
    assert.ok(hit, `タブ「${prefix}」がない`);
    return hit;
  };

  it("詳細を開くと、詳細の見出し（tabIndex=-1）にフォーカスを移す（読み込み中から）", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "いとう"));
    const tree = m.render();
    const heading = headingOf(tree, "いとう の詳細");
    assert.equal(heading.props.tabIndex, -1, "詳細の見出しが tabIndex=-1 でない");
    assert.equal(m.focused(), heading, `詳細の見出しにフォーカスがない：${focusedLabel(m)}`);
  });

  it("詳細の読み込み後・再読み込みでは、フォーカスを動かさない（開いたときの 1 回だけ）", async () => {
    const m = await loaded();
    click(nameButton(m.render(), "いとう"));
    m.render();
    m.setFocused(null);
    m.reqs[1].release(res({ error: "x" }, { status: 500, ok: false }));
    await settle();
    const tree = m.render();
    assert.equal(m.focused(), null, `読み込み後にフォーカスが動いた：${focusedLabel(m)}`);
    click(button(tree, "再読み込み"));
    m.render();
    m.reqs[2].release(res(detailOf("stu_b", "いとう")));
    await settle();
    m.render();
    assert.equal(m.focused(), null, `再読み込みでフォーカスが動いた：${focusedLabel(m)}`);
  });

  it("「一覧に戻る」の後、開いていた受講生の名前ボタンにフォーカスを戻す", async () => {
    const m = await openedDetail("stu_b", "いとう");
    click(button(m.render(), "一覧に戻る"));
    const tree = m.render();
    assert.equal(m.focused(), nameButton(tree, "いとう"), `名前ボタンにフォーカスがない：${focusedLabel(m)}`);
  });

  it("戻した後にタブを切り替えて戻っても、フォーカスは名前ボタンへ再び移らない", async () => {
    const m = await openedDetail("stu_b", "いとう");
    click(button(m.render(), "一覧に戻る"));
    let tree = m.render();
    const allTab = tab(tree, "すべて（");
    m.setFocused(allTab);
    click(allTab);
    tree = m.render();
    const activeTab = tab(tree, "有効（");
    m.setFocused(activeTab);
    click(activeTab);
    m.render();
    assert.equal(m.focused(), activeTab, `タブの切り替えでフォーカスが動いた：${focusedLabel(m)}`);
  });

  it("戻る先の行が表示されていない（詳細で無効化した）ときは一覧の見出しへ移し、後でタブを切り替えてもフォーカスは移らない", async () => {
    const m = await openedDetail("stu/a", "あおき");
    click(button(m.render(), "無効化"));
    click(button(m.render(), "無効化する"));
    m.reqs[2].release(res({ id: "stu/a", status: "deactivated", deactivatedAt: "2026-10-08T15:30:00.000Z" }));
    await settle();
    m.reqs[3].release(res(LIST.map((r) => (r.id === "stu/a" ? { ...r, status: "deactivated", deactivatedAt: "2026-10-08T15:30:00.000Z" } : r))));
    await settle();
    click(button(m.render(), "一覧に戻る"));
    let tree = m.render();
    assert.deepEqual(shownNames(tree), ["いとう"], "有効タブに無効化した受講生が残っている");
    const heading = headingOf(tree, "Students");
    assert.equal(heading.props.tabIndex, -1, "一覧の見出しが tabIndex=-1 でない");
    assert.equal(m.focused(), heading, `一覧の見出しにフォーカスがない：${focusedLabel(m)}`);

    // 無効化した受講生が表示されるタブへ切り替えても、名前ボタンへフォーカスが移らない
    for (const prefix of ["無効（", "すべて（"]) {
      const t = tab(tree, prefix);
      m.setFocused(t);
      click(t);
      tree = m.render();
      assert.ok(shownNames(tree).includes("あおき"), `「${prefix}」タブに無効化した受講生が出ていない`);
      assert.equal(m.focused(), t, `「${prefix}」タブへの切り替えでフォーカスが動いた：${focusedLabel(m)}`);
    }
  });

  it("検索語を残したまま戻ると名前ボタンへ戻し、その後に検索語を変えてもフォーカスは移らない", async () => {
    const m = await loaded();
    type(searchInput(m.render()), "いと");
    click(nameButton(m.render(), "いとう"));
    m.reqs[1].release(res(detailOf("stu_b", "いとう")));
    await settle();
    click(button(m.render(), "一覧に戻る"));
    let tree = m.render();
    // 戻る先の行はある（検索語は残る）ので名前ボタンへ
    assert.equal(m.focused(), nameButton(tree, "いとう"), `名前ボタンにフォーカスがない：${focusedLabel(m)}`);
    const input = searchInput(tree);
    m.setFocused(input);
    type(input, "");
    tree = m.render();
    assert.deepEqual(shownNames(tree), ["あおき", "いとう"]);
    assert.equal(m.focused(), input, `検索語の変更でフォーカスが動いた：${focusedLabel(m)}`);
  });
});
