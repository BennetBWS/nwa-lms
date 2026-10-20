import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { classifyAuthFailure } from "./client-session";
import { greetingTitle } from "./user-display";
import { isInProgress, nextUpEmptyMessage, pickActiveCourse, toActivityItems, toNewsItems } from "./student-dashboard";
import { countCourseLessons, isCourseLocked, type LessonCounts } from "./course-lock";

// #78 PR A のテスト担当による追加。page.tsx（// @ts-nocheck）のコース一覧（CourseList）と、ダッシュボード（StudentDashboard）の
// カリキュラム欄・「学習を続ける」を、typescript の transpileModule で変換して偽の React で「描画」し、
// - いまの page.tsx（API の locked を表示するだけ）と、
// - main の page.tsx（画面で isCourseLocked を計算していた。いまのソースの該当行を main の行に戻して作る）
// を、同じ API の応答（locked は main の規則の値）で描画して、要素の木と、クリック・マウスを乗せたときの動きが同じことを確かめる。
// あわせて、いまの page.tsx は API の locked だけを表示する（件数から計算し直さない）ことを確かめる。
// 要素の props の関数は名前だけを比べ、onClick / onMouseEnter は実際に呼んで、画面の移動と先読みの記録を比べる。
// DOM・DB・ネットワークなし。データはすべてダミー。乱数はシード固定。
// 寿命：このテストは page.tsx の決まった行（`const locked = c.locked === true;` や、目印のコメントの行）を replaceOnce で main の行に戻して比べるため、
// CourseList・StudentDashboard の該当の行やコメントを変えると「置き換える箇所がちょうど 1 つでない」で落ちる。
// #78 PR E（受講生の画面）でこの部分を変えるときに、削除するか書き直す（main との比較は PR A の移行の確認のためのもの）。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** source の from を to に 1 回だけ置き換える（見つからない・複数あるなら失敗。page.tsx が変わったらこのテストを見直す） */
function replaceOnce(source: string, from: string, to: string): string {
  const parts = source.split(from);
  assert.equal(parts.length, 2, `main の行に戻す箇所がちょうど 1 つでない: ${from}`);
  return parts.join(to);
}

const CURRENT = { CourseList: component("CourseList"), StudentDashboard: component("StudentDashboard") };

/** main（dfce745）の page.tsx の、ロックを画面で計算していた行に戻したもの */
const MAIN = {
  CourseList: replaceOnce(
    replaceOnce(CURRENT.CourseList, "const courses = apiCourses.map((c) => {", "const courses = apiCourses.map((c, i) => {"),
    "const locked = c.locked === true;",
    "const locked = isCourseLocked(i > 0 ? countCourseLessons(apiCourses[i - 1]) : null, countCourseLessons(c));"
  ),
  StudentDashboard: replaceOnce(
    replaceOnce(
      CURRENT.StudentDashboard,
      "    // The lock is decided by the API only (#78); the screen just shows it\n    locked: c.locked === true,\n",
      ""
    ),
    "const isLock = c.locked;",
    "const isLock = isCourseLocked(i > 0 ? courses[i - 1] : null, c);"
  ),
};

const compiled = new Map<string, string>();
function compile(code: string, name: string): string {
  const hit = compiled.get(code);
  if (hit !== undefined) return hit;
  const out = ts.transpileModule(code, {
    fileName: `${name}.jsx`,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: "h", jsxFragmentFactory: "Frag", module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, allowJs: true },
  });
  assert.deepEqual(out.diagnostics ?? [], [], `${name} の変換で診断が出た`);
  compiled.set(code, out.outputText);
  return out.outputText;
}

// ───────────── 偽の React ─────────────

type El = { type: unknown; props: Record<string, unknown>; children: Node[] };
type Node = El | string | number;

function stub(name: string) {
  const f = () => null;
  Object.defineProperty(f, "name", { value: name });
  return f;
}
const STUB_NAMES = [
  "ScrollArea", "FadeIn", "Button", "AnimNum", "Badge", "Sparkles", "PlayCircle", "ResponsiveContainer", "RadialBarChart",
  "PolarAngleAxis", "RadialBar", "CheckCircle2", "Lock", "ArrowUpRight", "Bell", "BookOpen", "Flame", "Target", "Search", "Clock", "Users",
] as const;
const C = Object.fromEntries(STUB_NAMES.map((n) => [n, stub(n)])) as Record<(typeof STUB_NAMES)[number], () => null>;
const CourseIcons = { it: stub("IconIt") };
const Frag = "Frag";
function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
  const flat = (children.flat(Infinity) as unknown[]).filter((c) => c !== null && c !== undefined && c !== false && c !== true && c !== "") as Node[];
  return { type, props: props ?? {}, children: flat };
}
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

type Log = string[];

/** 部品を 1 つ組み立て、API の応答を 1 回返して描画し終えた木を返す */
async function renderWith(name: "CourseList" | "StudentDashboard", code: string, apiBody: unknown, log: Log): Promise<El> {
  const js = compile(code, name);
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  let si = 0;
  let ri = 0;
  let pending: Array<() => unknown> = [];
  const seenEffects = new Set<number>();
  let ei = 0;
  const scope: Record<string, unknown> = {
    h,
    Frag,
    useState: (init: unknown) => {
      const i = si++;
      if (!(i in states)) states[i] = init;
      return [states[i], (v: unknown) => (states[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(states[i]) : v)];
    },
    useRef: (init: unknown) => {
      const i = ri++;
      if (!(i in refs)) refs[i] = { current: init };
      return refs[i];
    },
    useEffect: (fn: () => unknown) => {
      const i = ei++;
      if (!seenEffects.has(i)) {
        seenEffects.add(i);
        pending.push(fn);
      }
    },
    authFetch: async (url: string) => {
      log.push(`fetch ${url}`);
      return { status: 200, ok: true, redirected: false, url: `https://nwa-lms.example.com${url}`, json: async () => structuredClone(apiBody) };
    },
    classifyAuthFailure,
    greetingTitle,
    isInProgress,
    nextUpEmptyMessage,
    pickActiveCourse,
    toActivityItems,
    toNewsItems,
    isCourseLocked,
    countCourseLessons,
    CourseIcons,
    T: new Proxy({}, { get: (_t, k) => (k === "mode" ? "light" : `T.${String(k)}`) }),
    glassStyle: () => ({ glass: true }),
    preload: (url: string) => log.push(`preload ${url}`),
    swrFetcher: stub("swrFetcher"),
    ...C,
  };
  const names = Object.keys(scope);
  const Comp = new Function(...names, `${js}\nreturn ${name};`)(...names.map((n) => scope[n])) as (p: Record<string, unknown>) => El;
  const props = { setCurrentPage: (page: string, arg?: unknown) => log.push(`go ${page} ${JSON.stringify(arg ?? null)}`), userName: "ダミー受講生" };
  const render = () => {
    si = 0;
    ri = 0;
    ei = 0;
    pending = [];
    const tree = Comp(props);
    for (const fn of pending) fn();
    return tree;
  };
  render();
  await settle();
  return render();
}

/** 比べるための形（関数は名前だけ） */
function shape(n: Node): unknown {
  if (typeof n !== "object") return n;
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.props)) props[k] = typeof v === "function" ? `[fn ${k}]` : v;
  return { type: typeof n.type === "function" ? `<${(n.type as { name: string }).name}>` : n.type, props, children: n.children.map(shape) };
}

/** 木の順に onClick と onMouseEnter を呼び、記録を返す */
function interact(tree: El, log: Log): Log {
  const out: Log = [];
  const walk = (n: Node) => {
    if (typeof n !== "object") return;
    for (const ev of ["onClick", "onMouseEnter"] as const) {
      const fn = n.props[ev];
      if (typeof fn !== "function") continue;
      const before = log.length;
      fn({ currentTarget: { style: {} } });
      out.push(`${ev}: ${log.slice(before).join(" | ")}`);
    }
    n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

function findAll(n: Node, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (typeof n === "object") {
    if (pred(n)) out.push(n);
    for (const c of n.children) findAll(c, pred, out);
  }
  return out;
}
const text = (n: Node): string => (typeof n === "object" ? n.children.map(text).join("") : String(n));

// ───────────── 乱数の API の応答 ─────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Gen = { counts: LessonCounts[]; names: string[]; icons: string[] };
function generate(rand: () => number): Gen {
  const n = 1 + Math.floor(rand() * 6);
  const counts: LessonCounts[] = [];
  const mode = rand();
  for (let i = 0; i < n; i++) {
    const total = rand() < 0.2 ? 0 : 1 + Math.floor(rand() * 4);
    // 先頭から順に終える・ばらばら、の両方を作る
    const completed = mode < 0.5 ? (rand() < 0.5 ? total : Math.floor(rand() * (total + 1))) : Math.floor(rand() * (total + 1));
    counts.push({ totalLessons: total, completedLessons: completed });
  }
  return { counts, names: counts.map((_, i) => `STEP${i + 1} ダミー${i}`), icons: counts.map(() => (rand() < 0.5 ? "it" : "none")) };
}

function mainLocks(counts: LessonCounts[]): boolean[] {
  return counts.map((c, i) => isCourseLocked(i > 0 ? counts[i - 1] : null, c));
}

const pct = (c: LessonCounts) => (c.totalLessons > 0 ? Math.round((c.completedLessons / c.totalLessons) * 100) : 0);

/** GET /api/courses の応答（locked はサーバーが返す値） */
function coursesBody(g: Gen, locked: unknown[]) {
  return g.counts.map((c, i) => ({
    id: `c${i}`,
    name: g.names[i],
    description: i % 2 ? `ダミー説明${i}` : null,
    icon: g.icons[i],
    color: "#123456",
    order: i + 1,
    progress: pct(c),
    locked: locked[i],
    sections: [{ id: `s${i}`, lessons: Array.from({ length: c.totalLessons }, (_, k) => ({ id: `l${i}_${k}`, title: `L${k}`, completed: k < c.completedLessons })) }],
  }));
}

/** GET /api/dashboard の応答 */
function dashboardBody(g: Gen, locked: unknown[]) {
  return {
    activeCourses: g.counts.filter((c) => c.completedLessons > 0 && c.completedLessons < c.totalLessons).length,
    completedLessons: g.counts.reduce((s, c) => s + c.completedLessons, 0),
    totalLessons: g.counts.reduce((s, c) => s + c.totalLessons, 0),
    overallProgress: 0,
    completedLast7Days: 0,
    courses: g.counts.map((c, i) => ({ id: `c${i}`, name: g.names[i], icon: g.icons[i], color: "#123456", order: i + 1, progress: pct(c), totalLessons: c.totalLessons, completedLessons: c.completedLessons, locked: locked[i] })),
    nextLessons: [],
    recentActivity: [],
    unreadNotifications: 0,
    notifications: [],
  };
}

const ITERATIONS = 150;
// main の「学習を続ける」がロック中のコースを指す場面（レッスン 0 件のコースの直後など）は少ないので多めに回す
const DASHBOARD_ITERATIONS = 500;

describe("main の page.tsx の組み立て（いまのソースの該当行を main の行に戻したもの）", () => {
  it("CourseList と StudentDashboard の両方で、戻す行が見つかり、変換できる", () => {
    for (const [name, code] of Object.entries(MAIN)) {
      assert.match(code, /isCourseLocked\(/, `${name}：main の行に戻っていない`);
      compile(code, name);
    }
    for (const [name, code] of Object.entries(CURRENT)) assert.doesNotMatch(code, /isCourseLocked|countCourseLessons/, `${name}：いまのソースが画面でロックを計算している`);
  });
});

describe("CourseList：API の locked（main の規則の値）で描画すると main と同じ", () => {
  it(`${ITERATIONS} 通りの構成で、要素の木・クリック・先読みが main と同じ`, async () => {
    const rand = mulberry32(7801);
    let lockedSeen = 0;
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const g = generate(rand);
      const locks = mainLocks(g.counts);
      lockedSeen += locks.filter(Boolean).length;
      const body = coursesBody(g, locks);
      const logMain: Log = [];
      const logCur: Log = [];
      const treeMain = await renderWith("CourseList", MAIN.CourseList, body, logMain);
      const treeCur = await renderWith("CourseList", CURRENT.CourseList, body, logCur);
      const grid = findAll(treeCur, (e) => e.props.className === "nwa-course-grid");
      assert.equal(grid.length === 1 ? grid[0].children.length : -1, g.counts.length, `seed ${seed}: 一覧を読み込めていない`);
      assert.deepEqual(shape(treeCur), shape(treeMain), `seed ${seed}: コース一覧の描画が main と違う ${JSON.stringify(g.counts)}`);
      assert.deepEqual(interact(treeCur, logCur), interact(treeMain, logMain), `seed ${seed}: コース一覧のクリック・先読みが main と違う`);
    }
    assert.ok(lockedSeen > 50, `ロック中のコースを十分に描画できていない: ${lockedSeen}`);
  });

  it("いまの CourseList は API の locked だけを表示する（件数と食い違う値でもそのまま。true 以外はロックしない）", async () => {
    const rand = mulberry32(7802);
    for (let seed = 1; seed <= 60; seed++) {
      const g = generate(rand);
      // 件数と無関係な locked。true・false のほか、true 以外の値（"true"・1・null・なし）も混ぜる
      const values: unknown[] = [true, false, "true", 1, null, undefined];
      const locked = g.counts.map(() => values[Math.floor(rand() * values.length)]);
      const log: Log = [];
      const tree = await renderWith("CourseList", CURRENT.CourseList, coursesBody(g, locked), log);
      const grid = findAll(tree, (e) => e.props.className === "nwa-course-grid");
      assert.equal(grid.length, 1, "コースの並びが見つからない");
      const cards = grid[0].children as El[];
      assert.equal(cards.length, g.counts.length, `seed ${seed}: カードの数`);
      cards.forEach((card, i) => {
        const isLocked = locked[i] === true;
        const inner = card.children[0] as El;
        const style = inner.props.style as { opacity: number; cursor: string };
        assert.equal(style.opacity, isLocked ? 0.45 : 1, `seed ${seed} コース ${i}: opacity`);
        assert.equal(style.cursor, isLocked ? "default" : "pointer", `seed ${seed} コース ${i}: cursor`);
        assert.equal(text(card).includes("Coming soon"), isLocked, `seed ${seed} コース ${i}: Coming soon の表示`);
        assert.equal(findAll(card, (e) => e.type === C.Lock).length, isLocked ? 1 : 0, `seed ${seed} コース ${i}: 鍵のアイコン`);
        const before = log.length;
        (inner.props.onClick as () => void)();
        assert.deepEqual(log.slice(before), isLocked ? [] : [`go lesson ${JSON.stringify({ courseId: `c${i}` })}`], `seed ${seed} コース ${i}: クリックの移動`);
      });
    }
  });
});

describe("StudentDashboard：カリキュラム欄・「学習を続ける」", () => {
  const curriculum = (tree: El) => {
    const hit = findAll(tree, (e) => e.type === C.FadeIn && e.props.delay === 160);
    assert.equal(hit.length, 1, "カリキュラム欄が見つからない");
    return hit[0];
  };
  // 「学習を続ける」（delay 80 の FadeIn のうち 8 列のもの。統計カードの 3 枚目も delay 80）
  const cta = (tree: El) =>
    findAll(tree, (e) => e.type === C.FadeIn && e.props.delay === 80 && (e.props.style as { gridColumn?: string } | undefined)?.gridColumn === "span 8")[0] ?? null;

  it(`${DASHBOARD_ITERATIONS} 通りの構成で、カリキュラム欄は main と同じ。「学習を続ける」は main の選んだコースが開いていれば main と同じ、ロック中なら開いているコースを選ぶ`, async () => {
    const rand = mulberry32(7803);
    let whole = 0;
    let skipped = 0;
    for (let seed = 1; seed <= DASHBOARD_ITERATIONS; seed++) {
      const g = generate(rand);
      const locks = mainLocks(g.counts);
      const body = dashboardBody(g, locks);
      const logMain: Log = [];
      const logCur: Log = [];
      const treeMain = await renderWith("StudentDashboard", MAIN.StudentDashboard, body, logMain);
      const treeCur = await renderWith("StudentDashboard", CURRENT.StudentDashboard, body, logCur);
      assert.deepEqual(shape(curriculum(treeCur)), shape(curriculum(treeMain)), `seed ${seed}: カリキュラム欄の描画が main と違う ${JSON.stringify(g.counts)}`);
      assert.deepEqual(interact(curriculum(treeCur), logCur), interact(curriculum(treeMain), logMain), `seed ${seed}: カリキュラム欄のクリックが main と違う`);

      const mainActive = pickActiveCourse(g.counts.map((c, i) => ({ ...c, i })));
      if (!mainActive || !locks[mainActive.i]) {
        // main の「学習を続ける」が開いているコース（またはコースなし）なら、画面全体が main と同じ
        whole++;
        assert.deepEqual(shape(treeCur), shape(treeMain), `seed ${seed}: ダッシュボード全体の描画が main と違う`);
        assert.deepEqual(interact(treeCur, logCur), interact(treeMain, logMain), `seed ${seed}: ダッシュボードのクリックが main と違う`);
      } else {
        // main はロック中のコースを指していた（意図した変化）。いまは開いているコースを指すか、なければ出さない
        skipped++;
        const ctaCur = cta(treeCur);
        if (ctaCur) {
          const before = logCur.length;
          ((ctaCur.children[0] as El).props.onClick as () => void)();
          const went = logCur.slice(before)[0];
          const id = JSON.parse(went.replace(/^go lesson /, "")).courseId as string;
          assert.equal(locks[Number(id.slice(1))], false, `seed ${seed}: 「学習を続ける」がロック中のコース ${id} を開く`);
        }
      }
    }
    assert.ok(whole > 50, `main と全体が同じになる場面が少ない: ${whole}`);
    assert.ok(skipped > 5, `main がロック中のコースを指していた場面が少ない: ${skipped}`);
  });

  it("いまのカリキュラム欄は API の locked だけを表示する（true のときだけ薄くする）", async () => {
    const rand = mulberry32(7804);
    for (let seed = 1; seed <= 60; seed++) {
      const g = generate(rand);
      const values: unknown[] = [true, false, "true", 1, null, undefined];
      const locked = g.counts.map(() => values[Math.floor(rand() * values.length)]);
      const tree = await renderWith("StudentDashboard", CURRENT.StudentDashboard, dashboardBody(g, locked), []);
      const rows = findAll(curriculum(tree), (e) => e.type === "div" && typeof (e.props.style as { opacity?: unknown } | undefined)?.opacity === "number");
      assert.equal(rows.length, g.counts.length, `seed ${seed}: カリキュラム欄の行の数`);
      rows.forEach((row, i) => {
        assert.equal((row.props.style as { opacity: number }).opacity, locked[i] === true ? 0.35 : 1, `seed ${seed} コース ${i}: opacity`);
      });
    }
  });
});
