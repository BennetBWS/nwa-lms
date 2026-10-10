import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import ts from "typescript";
import { classifyAuthFailure } from "./client-session";
import { toAdminDashboardView } from "./admin-stats";

// #32 PR B 管理ダッシュボード：page.tsx（// @ts-nocheck）の AdminDashboard を typescript の transpileModule で変換し、
// 偽の React（useState / useRef / useEffect と要素の木）で「描画」して、表示とリクエストを確かめる。
// admin-students.render.page.test.ts と同じ方式（部品・グラフは描画しない関数に差し替え、要素の props を見る）。
// setState では再描画しない（テストが render() を呼んだときだけ描画）。DOM・DB・ネットワークなし。データはすべてダミー。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const transpiled = ts.transpileModule(component("AdminDashboard"), {
  fileName: "AdminDashboard.jsx",
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

const STUB_NAMES = [
  "ScrollArea", "FadeIn", "Button", "AnimNum", "Users", "Target", "MessageSquare", "Award", "ChevronRight",
  "ResponsiveContainer", "AreaChart", "Area", "XAxis", "YAxis", "CartesianGrid", "Tooltip", "PieChart", "Pie", "Cell",
] as const;
const C = Object.fromEntries(STUB_NAMES.map((n) => [n, stub(n)])) as Record<(typeof STUB_NAMES)[number], () => null>;

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
  return { status: 200, ok: true, redirected: false, url: `${ORIGIN}/api/admin/stats`, json: () => Promise.resolve(body), ...p };
}
type Req = { url: string; release: (r: FakeRes) => void; fail: (e: unknown) => void };

function mount() {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const effectDeps: Array<unknown[] | undefined> = [];
  let si = 0;
  let ri = 0;
  let ei = 0;
  let pending: Array<() => unknown> = [];
  const reqs: Req[] = [];
  const pages: string[] = [];

  const useState = (init: unknown) => {
    const i = si++;
    if (!(i in states)) states[i] = init;
    return [states[i], (v: unknown) => (states[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(states[i]) : v)];
  };
  const useRef = (init: unknown) => {
    const i = ri++;
    if (!(i in refs)) refs[i] = { current: init };
    return refs[i];
  };
  const useEffect = (fn: () => unknown, deps?: unknown[]) => {
    const i = ei++;
    const prev = effectDeps[i];
    const first = !(i in effectDeps);
    if (first || deps === undefined || prev === undefined || deps.some((d, k) => !Object.is(d, prev[k]))) pending.push(fn);
    effectDeps[i] = deps;
  };
  const authFetch = (url: string) => new Promise<FakeRes>((release, fail) => reqs.push({ url, release, fail }));

  const scope: Record<string, unknown> = {
    h,
    Frag,
    useState,
    useRef,
    useEffect,
    authFetch,
    classifyAuthFailure,
    toAdminDashboardView,
    T: new Proxy({}, { get: () => "#000000" }),
    glassStyle: () => ({}),
    ...C,
  };
  const names = Object.keys(scope);
  const AdminDashboard = new Function(...names, `${compiled}\nreturn AdminDashboard;`)(...names.map((n) => scope[n])) as (
    props: Record<string, unknown>
  ) => El;

  const render = (): El => {
    si = 0;
    ri = 0;
    ei = 0;
    pending = [];
    const tree = AdminDashboard({ setCurrentPage: (p: string) => pages.push(p) });
    assertRenderable(tree);
    for (const fn of pending) fn();
    return tree;
  };
  return { render, reqs, pages };
}

function text(n: Node): string {
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
const byType = (tree: El, t: unknown) => findAll(tree, (e) => e.type === t);
const byRole = (tree: El, role: string) => findAll(tree, (e) => e.props.role === role);
function button(tree: El, label: string): El {
  const hit = byType(tree, C.Button).filter((b) => text(b).trim().startsWith(label));
  assert.equal(hit.length, 1, `ボタン「${label}」が 1 つでない`);
  return hit[0];
}
const click = (b: El) => (b.props.onClick as () => void)();

/** カードの値（AnimNum の value。未取得・null は "—"）を、カードの見出しの順に */
function cardValues(tree: El): Array<number | string> {
  const labels = ["Active Students", "Avg Progress", "Open Questions", "Completions"];
  return labels.map((label) => {
    const card = findAll(tree, (e) => e.type === "div" && e.children.some((c) => typeof c === "object" && c.type === "span" && text(c) === label));
    assert.equal(card.length, 1, `カード「${label}」が 1 つでない`);
    const anim = byType(card[0], C.AnimNum);
    if (anim.length === 1) return anim[0].props.value as number;
    assert.ok(text(card[0]).includes("—"), `カード「${label}」に値も「—」もない`);
    return "—";
  });
}

const STATS = {
  generatedAt: "2026-10-09T03:00:00.000Z",
  timeZone: "Asia/Tokyo",
  cards: { activeStudents: 5, avgProgressPercent: 40, openQuestions: 2, completions: 3 },
  monthly: [
    { month: "2026-05", activeStudents: 0, completions: 0 },
    { month: "2026-06", activeStudents: 1, completions: 0 },
    { month: "2026-07", activeStudents: 2, completions: 1 },
    { month: "2026-08", activeStudents: 3, completions: 0 },
    { month: "2026-09", activeStudents: 4, completions: 1 },
    { month: "2026-10", activeStudents: 2, completions: 1 },
  ],
  distribution: [
    { courseId: "c1", name: "STEP1 ダミー", color: "#6366F1", students: 3 },
    { courseId: "c2", name: "STEP2 ダミー", color: "#EF4444", students: 0 },
    { courseId: null, name: "全コース修了", color: "#94A3B8", students: 2 },
  ],
};

describe("AdminDashboard 描画：前提", () => {
  it("JSX の変換：診断なしで、import / export を含まない", () => {
    assert.deepEqual(transpiled.diagnostics ?? [], []);
    assert.doesNotMatch(compiled, /^\s*(import|export)\b/m);
  });
});

describe("AdminDashboard 描画：読み込み", () => {
  it("最初は読み込み中（カードは「—」、グラフの代わりに Loading...）。/api/admin/stats を 1 回だけ読む", () => {
    const m = mount();
    const tree = m.render();
    assert.deepEqual(m.reqs.map((r) => r.url), ["/api/admin/stats"]);
    assert.deepEqual(cardValues(tree), ["—", "—", "—", "—"]);
    assert.ok(text(tree).includes("Loading..."), "読み込み中が出ていない");
    assert.equal(byType(tree, C.AreaChart).length, 0, "読み込み中にグラフが出ている");
    m.render();
    assert.equal(m.reqs.length, 1, "再描画で読み直している");
  });

  it("成功：カードは応答の値、推移は「5月」〜「10月」、分布は 1 人以上だけを円に、凡例は全区分を人数つきで", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res(STATS));
    await settle();
    const tree = m.render();
    assert.deepEqual(cardValues(tree), [5, 40, 2, 3]);
    assert.equal(byRole(tree, "alert").length, 0);
    const area = byType(tree, C.AreaChart);
    assert.equal(area.length, 1);
    assert.deepEqual((area[0].props.data as Array<{ m: string }>).map((d) => d.m), ["5月", "6月", "7月", "8月", "9月", "10月"]);
    const pie = byType(tree, C.Pie);
    assert.equal(pie.length, 1);
    assert.deepEqual((pie[0].props.data as Array<{ name: string }>).map((d) => d.name), ["STEP1 ダミー", "全コース修了"]);
    assert.deepEqual(byType(tree, C.Cell).map((c) => c.props.fill), ["#6366F1", "#94A3B8"]);
    const t = text(tree);
    for (const s of ["STEP1 ダミー 3名", "STEP2 ダミー 0名", "全コース修了 2名"]) assert.ok(t.includes(s), `凡例に「${s}」がない`);
    assert.ok(!t.includes("+3") && !t.includes("+5%"), "増減の表示が残っている");
  });

  it("平均進捗が null（有効な受講生 0 人）なら「—」で「%」を付けない。分布が全員 0 なら円の代わりに文言", async () => {
    const m = mount();
    m.render();
    const body = {
      ...STATS,
      cards: { activeStudents: 0, avgProgressPercent: null, openQuestions: 0, completions: 0 },
      distribution: STATS.distribution.map((d) => ({ ...d, students: 0 })),
    };
    m.reqs[0].release(res(body));
    await settle();
    const tree = m.render();
    assert.deepEqual(cardValues(tree), [0, "—", 0, 0]);
    assert.ok(!text(tree).includes("%"), "「%」が出ている");
    assert.equal(byType(tree, C.Pie).length, 0, "0 人なのに円グラフがある");
    assert.ok(text(tree).includes("有効な受講生はいません"), "0 人の文言がない");
  });

  for (const [label, settleWith] of [
    ["500", (r: Req) => r.release(res({ error: "Internal server error" }, { status: 500, ok: false }))],
    ["403（講師でない）", (r: Req) => r.release(res({ error: "Forbidden" }, { status: 403, ok: false }))],
    ["通信エラー", (r: Req) => r.fail(new Error("network"))],
    ["形の違う本文", (r: Req) => r.release(res({ cards: {} }))],
    ["/login 以外へのリダイレクト", (r: Req) => r.release(res(STATS, { redirected: true, url: `${ORIGIN}/somewhere` }))],
  ] as Array<[string, (r: Req) => void]>) {
    it(`失敗（${label}）は role="alert" と再読み込み。押すともう一度読み、成功すればグラフを出す`, async () => {
      const m = mount();
      m.render();
      settleWith(m.reqs[0]);
      await settle();
      let tree = m.render();
      const alerts = byRole(tree, "alert");
      assert.equal(alerts.length, 1);
      assert.ok(text(alerts[0]).includes("統計を読み込めませんでした"), "失敗の文言がない");
      assert.deepEqual(cardValues(tree), ["—", "—", "—", "—"]);
      const reload = button(tree, "再読み込み");
      click(reload);
      click(reload);
      assert.equal(m.reqs.length, 2, "二重に読んでいる");
      tree = m.render();
      assert.equal(byRole(tree, "alert").length, 0, "再読み込み中に alert が残っている");
      assert.ok(text(tree).includes("Loading..."), "再読み込み中に読み込み中が出ていない");
      m.reqs[1].release(res(STATS));
      await settle();
      tree = m.render();
      assert.equal(byType(tree, C.AreaChart).length, 1);
      assert.deepEqual(cardValues(tree), [5, 40, 2, 3]);
    });
  }

  for (const [label, p] of [
    ["401", { status: 401, ok: false }],
    ["/login へのリダイレクト", { redirected: true, url: `${ORIGIN}/login?callbackUrl=%2F` }],
  ] as Array<[string, Partial<FakeRes>]>) {
    it(`セッション切れ（${label}）は失敗にせず、読み込み中のまま（authFetch がサインアウトする）`, async () => {
      const m = mount();
      m.render();
      m.reqs[0].release(res(null, p));
      await settle();
      const tree = m.render();
      assert.equal(byRole(tree, "alert").length, 0);
      assert.ok(text(tree).includes("Loading..."), "読み込み中のままでない");
      m.render();
      assert.equal(m.reqs.length, 1, "読み直している");
    });
  }

  it("「生徒管理を開く」は admin-students に移る", () => {
    const m = mount();
    click(button(m.render(), "生徒管理を開く"));
    assert.deepEqual(m.pages, ["admin-students"]);
  });
});

describe("AdminDashboard 描画：色の検証・0 人の区分・成功後（追加）", () => {
  /** 要素の木のどこか（props の文字列・style の値・テキスト）に s が出ていれば true */
  function appears(n: Node, s: string): boolean {
    if (typeof n === "string" || typeof n === "number") return String(n).includes(s);
    const inProps = Object.entries(n.props).some(([k, v]) => {
      if (k === "children") return false;
      if (typeof v === "string") return v.includes(s);
      if (k === "style" && v && typeof v === "object") return Object.values(v).some((x) => typeof x === "string" && x.includes(s));
      if (Array.isArray(v)) return JSON.stringify(v).includes(s);
      return false;
    });
    return inProps || n.children.some((c) => appears(c, s));
  }
  const swatches = (tree: El) =>
    findAll(tree, (e) => e.type === "div" && typeof (e.props.style as Record<string, unknown> | undefined)?.background === "string" && (e.props.style as { width?: number }).width === 8);

  it("応答の不正な色（CSS の注入・名前の色）は円にも凡例にも流さず、代わりの色にする", async () => {
    const evil = "#fff;background:url(https://example.com/x)";
    const m = mount();
    m.render();
    m.reqs[0].release(
      res({
        ...STATS,
        distribution: [
          { courseId: "c1", name: "STEP1 ダミー", color: evil, students: 1 },
          { courseId: "c2", name: "STEP2 ダミー", color: "red", students: 1 },
          { courseId: null, name: "全コース修了", color: "#94A3B8", students: 1 },
        ],
      })
    );
    await settle();
    const tree = m.render();
    // 推移グラフの fill="url(#ga2)" は正規の値なので、注入した URL の本体で確かめる
    assert.ok(!appears(tree, "example.com/x"), "不正な色が描画に流れている");
    const fills = byType(tree, C.Cell).map((c) => c.props.fill as string);
    assert.equal(fills.length, 3);
    for (const f of fills) assert.match(f, /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
    const bgs = swatches(tree).map((e) => (e.props.style as { background: string }).background);
    assert.deepEqual(bgs, fills, "凡例の色が円の色と違う");
    assert.ok(!fills.includes("red") && !bgs.includes("red"), "名前の色がそのまま流れている");
  });

  it("0 人の区分は円（Cell・Pie の data）に入れず、凡例には「0名」で出す。円の key は区分ごとに一意", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res(STATS));
    await settle();
    const tree = m.render();
    const pieData = byType(tree, C.Pie)[0].props.data as Array<{ name: string; value: number }>;
    assert.ok(pieData.every((d) => d.value > 0), "0 人の区分が円にある");
    // h() は key を props に入れたまま渡す
    const keys = byType(tree, C.Cell).map((c) => c.props.key);
    assert.ok(keys.every((k) => typeof k === "string" && k.length > 0), "Cell の key がない");
    assert.equal(new Set(keys).size, keys.length, "Cell の key が重複している");
    assert.equal(swatches(tree).length, 3, "凡例が全区分ぶんない");
    assert.ok(text(tree).includes("STEP2 ダミー 0名"), "0 人の区分が凡例にない");
  });

  it("成功後は alert・再読み込みボタンがなく、「%」は平均進捗の値があるときだけ。再描画で読み直さない", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release(res(STATS));
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.equal(byType(tree, C.Button).filter((b) => text(b).includes("再読み込み")).length, 0, "成功後に再読み込みボタンがある");
    assert.equal(text(tree).split("%").length - 1, 1, "「%」が平均進捗の 1 か所でない");
    assert.ok(!text(tree).includes("Loading..."), "成功後に読み込み中が残っている");
    m.render();
    m.render();
    assert.equal(m.reqs.length, 1, "再描画で読み直している");
  });

  it("読み込み中は円・凡例・推移グラフを出さず、見本の値（24・62・Jan など）も出さない", () => {
    const m = mount();
    const tree = m.render();
    assert.equal(byType(tree, C.Pie).length, 0);
    assert.equal(swatches(tree).length, 0);
    const t = text(tree);
    for (const s of ["24", "62", "Jan", "Apr", "+3", "+5%"]) assert.ok(!t.includes(s), `見本の値「${s}」が出ている`);
  });

  it("失敗中の再読み込みが失敗しても、もう一度押せる（in-flight の ref が戻る）", async () => {
    const m = mount();
    m.render();
    m.reqs[0].fail(new Error("network"));
    await settle();
    click(button(m.render(), "再読み込み"));
    m.reqs[1].release(res({ error: "x" }, { status: 500, ok: false }));
    await settle();
    click(button(m.render(), "再読み込み"));
    assert.equal(m.reqs.length, 3, "2 回目の再読み込みができない");
  });

  it("res.json() が失敗（壊れた JSON）しても失敗として扱う", async () => {
    const m = mount();
    m.render();
    m.reqs[0].release({ ...res(null), json: () => Promise.reject(new SyntaxError("Unexpected token")) });
    await settle();
    const tree = m.render();
    assert.equal(byRole(tree, "alert").length, 1, "壊れた JSON で失敗にならない");
  });
});
