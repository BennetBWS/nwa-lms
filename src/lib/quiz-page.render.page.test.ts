import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { createRequire } from "node:module";
import { join } from "node:path";
import { classifyAuthFailure } from "./client-session";
import {
  PASSING_PERCENT,
  QUIZ_ATTEMPTS_ENABLED,
  buildSubmitBody,
  quizResultTitle,
  toQuizCourseItems,
  toQuizResultView,
  toQuizTakeView,
} from "./student-quizzes";

// #32 確認テストのページ：page.tsx（// @ts-nocheck）の QuizPage 全体を esbuild（tsx の依存）で JSX から変換し、
// 偽の React（useState / useRef / useEffect と要素の木）で「描画」して、表示される文言・ボタン・状態遷移を確かめる。
// quiz-page.page.test.ts（ソースの検査と関数単位の実行）の補強。DOM・DB・ネットワークなし。データはすべてダミー。

const esbuild = createRequire(__filename)("esbuild") as {
  transformSync: (code: string, opts: Record<string, unknown>) => { code: string };
};

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const quizPageSrc = component("QuizPage");
const compiled = esbuild.transformSync(quizPageSrc, { loader: "jsx", jsxFactory: "h", jsxFragment: "Frag" }).code;

// useState の並び（ソースの順）。名前で初期値を差し替えられるようにする
const STATE_NAMES = Array.from(quizPageSrc.matchAll(/const \[(\w+), set\w+\] = useState\(/g)).map((m) => m[1]);

// ───────────── 偽の React ─────────────

type El = { type: unknown; props: Record<string, unknown>; children: Node[] };
type Node = El | string | number;

function stub(name: string) {
  const f = () => null;
  Object.defineProperty(f, "name", { value: name });
  return f;
}

const Button = stub("Button");
const COMPONENTS = {
  ScrollArea: stub("ScrollArea"),
  FadeIn: stub("FadeIn"),
  Button,
  Badge: stub("Badge"),
  Lock: stub("Lock"),
  CheckCircle2: stub("CheckCircle2"),
  Award: stub("Award"),
  BookOpen: stub("BookOpen"),
  ArrowLeft: stub("ArrowLeft"),
  ChevronRight: stub("ChevronRight"),
  ResponsiveContainer: stub("ResponsiveContainer"),
  RadialBarChart: stub("RadialBarChart"),
  PolarAngleAxis: stub("PolarAngleAxis"),
  RadialBar: stub("RadialBar"),
};

function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
  const flat = (children.flat(Infinity) as unknown[]).filter(
    (c) => c !== null && c !== undefined && c !== false && c !== true && c !== ""
  ) as Node[];
  return { type, props: props ?? {}, children: flat };
}
const Frag = "Frag";

type FakeRes = { status: number; ok: boolean; redirected: boolean; url: string; json: () => Promise<unknown> };
const ORIGIN = "https://nwa-lms.example.com";
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function res(body: unknown, p: Partial<FakeRes> = {}): FakeRes {
  return { status: 200, ok: true, redirected: false, url: `${ORIGIN}/api/quizzes`, json: () => Promise.resolve(body), ...p };
}

type Req = { url: string; init?: RequestInit; release: (r: FakeRes) => void; fail: (e: unknown) => void };

/**
 * QuizPage を描画する小さな器。enabled で QUIZ_ATTEMPTS_ENABLED の値を差し替える（ほかの lib 関数は本物）。
 * courseIcons は page.tsx の CourseIcons の代わり（既定は空のオブジェクト。Object の組み込みは prototype から見える）
 */
function mount(enabled: boolean, initial: Record<string, unknown> = {}, courseIcons: Record<string, unknown> = {}) {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  let si = 0;
  let ri = 0;
  let first = true;
  const effects: Array<() => void> = [];
  const reqs: Req[] = [];

  const useState = (init: unknown) => {
    const i = si++;
    if (!(i in states)) states[i] = STATE_NAMES[i] in initial ? initial[STATE_NAMES[i]] : init;
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
    QUIZ_ATTEMPTS_ENABLED: enabled,
    PASSING_PERCENT,
    toQuizCourseItems,
    toQuizTakeView,
    toQuizResultView,
    buildSubmitBody,
    quizResultTitle,
    T,
    glassStyle: () => ({}),
    CourseIcons: courseIcons,
    ...COMPONENTS,
  };
  const names = Object.keys(scope);
  const QuizPage = new Function(...names, `${compiled}\nreturn QuizPage;`)(...names.map((n) => scope[n])) as () => El;

  const render = (): El => {
    si = 0;
    ri = 0;
    const tree = QuizPage();
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
  const hit = buttons(tree).filter((b) => text(b).trim().startsWith(label));
  assert.equal(hit.length, 1, `ボタン「${label}」が 1 つでない：${buttonLabels(tree).join(" / ")}`);
  return hit[0];
}
const click = (b: El) => (b.props.onClick as (e?: unknown) => void)({ preventDefault() {} });
const byRole = (tree: El, role: string) => findAll(tree, (e) => e.props.role === role);

// ───────────── データ（ダミー） ─────────────

const LIST = {
  courses: [
    {
      id: "c1",
      name: "STEP1 ダミー",
      order: 1,
      icon: "it",
      color: "#6366F1",
      locked: false,
      finalQuizzes: [
        { id: "fin1", title: "STEP1 修了テスト", type: "FINAL", lessonId: null, lessonTitle: null, questionCount: 3, attemptCount: 2, bestScore: 67, passed: false, lastAttemptAt: "2026-10-07T10:00:00.000Z" },
      ],
      miniQuizzes: [
        { id: "mini/1", title: "L1 ミニ", type: "MINI", lessonId: "l1", lessonTitle: "レッスン1", questionCount: 1, attemptCount: 1, bestScore: 100, passed: true, lastAttemptAt: "2026-10-07T11:00:00.000Z" },
        { id: "mini2", title: "L2 ミニ", type: "MINI", lessonId: "l2", lessonTitle: "レッスン2", questionCount: 2, attemptCount: 0, bestScore: null, passed: null, lastAttemptAt: null },
      ],
    },
    {
      id: "c2",
      name: "STEP2 ダミー",
      order: 2,
      icon: "html",
      color: "#EF4444",
      locked: true,
      finalQuizzes: [
        { id: "fin2", title: "STEP2 修了テスト", type: "FINAL", lessonId: null, lessonTitle: null, questionCount: 1, attemptCount: 0, bestScore: null, passed: null, lastAttemptAt: null },
      ],
      miniQuizzes: [],
    },
  ],
};

const TAKE = {
  id: "mini2",
  title: "L2 ミニ",
  type: "MINI",
  questionCount: 2,
  questions: [
    { id: "q1", question: "ダミー問1", options: ["選択肢A", "選択肢B"] },
    { id: "q2", question: "ダミー問2", options: ["選択肢C", "選択肢D", "選択肢E"] },
  ],
  attemptCount: 0,
  bestScore: null,
  passed: null,
};

async function loadedList(enabled: boolean, body: unknown = LIST, courseIcons: Record<string, unknown> = {}) {
  const m = mount(enabled, {}, courseIcons);
  m.render();
  assert.equal(m.reqs.length, 1);
  m.reqs[0].release(res(body));
  await settle();
  return m;
}

// ───────────── 一覧 ─────────────

describe("QuizPage 描画：前提", () => {
  it("本番の QUIZ_ATTEMPTS_ENABLED は false（以下の false の描画が本番と同じ）", () => {
    assert.equal(QUIZ_ATTEMPTS_ENABLED, false);
  });

  it("useState の並びが取れている（器の前提）", () => {
    for (const n of ["quizData", "loading", "loadFailed", "activeQuizId", "takeQuiz", "answers", "currentQ", "submitting", "submitFailed", "result"]) {
      assert.ok(STATE_NAMES.includes(n), n);
    }
  });
});

describe("QuizPage 描画：一覧の読み込み", () => {
  it("最初は読み込み中で、/api/quizzes を 1 回だけ読む（オプションなし）", () => {
    const m = mount(false);
    const tree = m.render();
    assert.ok(text(tree).includes("Loading..."));
    assert.equal(m.reqs.length, 1);
    assert.equal(m.reqs[0].url, "/api/quizzes");
    assert.equal(m.reqs[0].init, undefined);
    // 再描画しても取得し直さない
    m.render();
    assert.equal(m.reqs.length, 1);
  });

  it("失敗（500）は role=alert と再読み込みボタン。押すともう一度読み、成功すれば一覧を出す", async () => {
    const m = mount(false);
    m.render();
    m.reqs[0].release(res({ error: "Internal server error" }, { status: 500, ok: false }));
    await settle();
    let tree = m.render();
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1);
    assert.ok(text(alerts[0]).includes("確認テストを読み込めませんでした"));
    click(button(tree, "再読み込み"));
    assert.equal(m.reqs.length, 2);
    tree = m.render();
    assert.ok(text(tree).includes("Loading..."));
    m.reqs[1].release(res(LIST));
    await settle();
    tree = m.render();
    assert.equal(byRole(tree, "alert").length, 0);
    assert.ok(text(tree).includes("STEP1 ダミー"));
  });

  it("courses が空なら「受けられる確認テストはまだありません」で、準備中の案内も出さない", async () => {
    const m = await loadedList(false, { courses: [] });
    const t = text(m.render());
    assert.ok(t.includes("受けられる確認テストはまだありません"));
    assert.ok(!t.includes("受験は準備中です"));
  });

  it(`見出しと合格基準（${PASSING_PERCENT}%）を出し、見本の文言は出さない`, async () => {
    const m = await loadedList(false);
    const t = text(m.render());
    assert.ok(t.includes("確認テスト受講"));
    assert.ok(t.includes(`${PASSING_PERCENT}%以上の正解で合格です。`));
    for (const s of ["15分", "20分", "Flexbox", "PC基本操作", "STEP1〜3のみ", "合格！"]) assert.ok(!t.includes(s), s);
  });
});

describe("QuizPage 描画：一覧（QUIZ_ATTEMPTS_ENABLED が false＝いまの本番）", () => {
  it("受験ボタンを 1 つも出さず、「受験は準備中です」を role=status で出す", async () => {
    const m = await loadedList(false);
    const tree = m.render();
    assert.deepEqual(buttonLabels(tree), []);
    const status = byRole(tree, "status");
    assert.equal(status.length, 1);
    assert.ok(text(status[0]).includes("受験は準備中です"));
  });

  it("コース名・件数・修了テスト／ミニテストの見出し・問題数・受験回数・最高点・合否", async () => {
    const m = await loadedList(false);
    const t = text(m.render());
    for (const s of [
      "STEP1 ダミー",
      "修了テスト 1件 · ミニテスト 2件",
      "STEP2 ダミー",
      "修了テスト 1件 · ミニテスト 0件",
      "STEP1 修了テスト",
      "3問 · 受験 2回",
      "最高 67点",
      "不合格",
      "レッスン1 · 1問 · 受験 1回",
      "最高 100点",
      "合格",
      "レッスン2 · 2問",
      "未受験",
    ]) {
      assert.ok(t.includes(s), s);
    }
    // 未受験の行には最高点・受験回数を出さない
    assert.ok(!t.includes("レッスン2 · 2問 · 受験"));
    assert.equal((t.match(/最高 /g) ?? []).length, 2);
  });

  it("ロックの表示はロックされたコース（STEP2）だけ", async () => {
    const m = await loadedList(false);
    const t = text(m.render());
    assert.equal((t.match(/前のコースを終えると受けられます/g) ?? []).length, 1);
    assert.ok(t.indexOf("前のコースを終えると受けられます") > t.indexOf("STEP2 ダミー"));
  });

  it("画面に出す文言に、正解・回答・受験日時・ID を含まない", async () => {
    const m = await loadedList(false);
    const t = text(m.render());
    for (const s of ["correctIndex", "answers", "lastAttemptAt", "2026-10-07", "fin1", "mini2"]) assert.ok(!t.includes(s), s);
  });

  it("受験中の状態が残っていても（activeQuizId があっても）受験画面は開かず、一覧を出す", async () => {
    const m = mount(false, { activeQuizId: "fin1", takeQuiz: toQuizTakeView(TAKE), answers: [null, null] });
    m.render();
    m.reqs[0].release(res(LIST));
    await settle();
    const t = text(m.render());
    assert.ok(t.includes("STEP1 ダミー"));
    assert.ok(!t.includes("ダミー問1"));
    assert.ok(!t.includes("回答を送信する"));
  });
});

describe("QuizPage 描画：一覧（QUIZ_ATTEMPTS_ENABLED が true の経路）", () => {
  it("受験ボタンはロックされていないコースの行だけ。受験済みは「もう一度受ける」、未受験は「受験する」", async () => {
    const m = await loadedList(true);
    const tree = m.render();
    assert.deepEqual(buttonLabels(tree), ["もう一度受ける", "もう一度受ける", "受験する"]);
    assert.ok(!text(tree).includes("受験は準備中です"));
  });

  it("ボタンはその行のクイズを開く（id はエンコードして GET）", async () => {
    const m = await loadedList(true);
    const tree = m.render();
    const rows = buttons(tree);
    click(rows[1]);
    assert.equal(m.reqs.length, 2);
    assert.equal(m.reqs[1].url, "/api/quizzes/mini%2F1");
    assert.equal(m.state("activeQuizId"), "mini/1");
  });
});

describe("QuizPage 描画：コースのアイコン", () => {
  const IconIt = stub("IconIt");
  const ICONS = { it: (p: Record<string, unknown>) => h(IconIt, p) };
  const BUILTINS = ["constructor", "valueOf", "toString", "hasOwnProperty", "__proto__"];
  // クイズの id はコースをまたいで重複すると飛ばされるので、コースごとに変える
  const withIcons = (icons: string[]) => ({
    courses: icons.map((icon, i) => ({
      ...LIST.courses[0],
      id: `c${i}`,
      name: `コース${i}`,
      icon,
      finalQuizzes: LIST.courses[0].finalQuizzes.map((q) => ({ ...q, id: `${q.id}_${i}` })),
      miniQuizzes: [],
    })),
  });
  /** 要素・文字列・数値以外（React では子にできず例外になるオブジェクト）が木に混ざっていないか */
  function assertRenderable(n: Node) {
    if (typeof n === "string" || typeof n === "number") return;
    assert.ok(n && typeof n === "object" && "type" in n && Array.isArray(n.children), `描画できない子: ${inspect(n)}`);
    for (const c of n.children) assertRenderable(c);
  }
  const iconCount = (tree: El, type: unknown) => findAll(tree, (e) => e.type === type).length;

  it("登録されたアイコン（it）はその部品を出す", async () => {
    const m = await loadedList(false, withIcons(["it"]), ICONS);
    const tree = m.render();
    assertRenderable(tree);
    assert.equal(iconCount(tree, IconIt), 1);
  });

  for (const icon of BUILTINS) {
    it(`icon が ${icon} のコースでも例外を出さず、Object の組み込みを使わずに既定のアイコン（BookOpen）を出す`, async () => {
      const m = await loadedList(false, withIcons([icon, "it"]), ICONS);
      let tree: El | undefined;
      assert.doesNotThrow(() => {
        tree = m.render();
      });
      assertRenderable(tree!);
      assert.ok(text(tree).includes("コース0"));
      assert.equal(iconCount(tree!, IconIt), 1);
      assert.equal(iconCount(tree!, COMPONENTS.BookOpen), 1);
    });
  }

  it("CourseIcons が空のときも icon が constructor のコースで例外を出さない", async () => {
    const m = await loadedList(false, withIcons(["constructor"]));
    const tree = m.render();
    assertRenderable(tree);
    assert.equal(iconCount(tree, COMPONENTS.BookOpen), 1);
  });
});

// ───────────── 受験（true の経路） ─────────────

async function openTake() {
  const m = await loadedList(true);
  click(buttons(m.render())[2]); // mini2（受験する）
  assert.equal(m.reqs[1].url, "/api/quizzes/mini2");
  assert.ok(text(m.render()).includes("Loading..."));
  m.reqs[1].release(res(TAKE, { url: `${ORIGIN}/api/quizzes/mini2` }));
  await settle();
  return m;
}

function chooseAll(m: ReturnType<typeof mount>, picks: number[]) {
  picks.forEach((p, i) => {
    const tree = m.render();
    const radios = byRole(tree, "radio");
    click(radios[p]);
    if (i < picks.length - 1) click(button(m.render(), "次へ"));
  });
}

describe("QuizPage 描画：受験（QUIZ_ATTEMPTS_ENABLED が true の経路）", () => {
  it("1 問目：タイトル・進み具合・問題文・選択肢（role=radio、未選択）。次へ・送信は押せない", async () => {
    const m = await openTake();
    const tree = m.render();
    const t = text(tree);
    for (const s of ["L2 ミニ", "問題 1 / 2", "ダミー問1", "選択肢A", "選択肢B", "途中で戻ると、それまでの回答は保存されません。"]) {
      assert.ok(t.includes(s), s);
    }
    assert.ok(!t.includes("ダミー問2"));
    const radios = byRole(tree, "radio");
    assert.equal(radios.length, 2);
    assert.deepEqual(radios.map((r) => r.props["aria-checked"]), [false, false]);
    assert.equal(button(tree, "次へ").props.disabled, true);
    assert.equal(button(tree, "前へ").props.disabled, true);
  });

  it("選んだ選択肢だけ aria-checked になり、次へで 2 問目。最後の問題は全部答えるまで送信できない", async () => {
    const m = await openTake();
    click(byRole(m.render(), "radio")[1]);
    let tree = m.render();
    assert.deepEqual(byRole(tree, "radio").map((r) => r.props["aria-checked"]), [false, true]);
    click(button(tree, "次へ"));
    tree = m.render();
    assert.ok(text(tree).includes("問題 2 / 2"));
    assert.ok(text(tree).includes("ダミー問2"));
    assert.equal(byRole(tree, "radio").length, 3);
    assert.equal(button(tree, "回答を送信する").props.disabled, true);
    click(byRole(tree, "radio")[2]);
    tree = m.render();
    assert.equal(button(tree, "回答を送信する").props.disabled, false);
    // 前へで戻ると 1 問目の回答が残っている
    click(button(tree, "前へ"));
    tree = m.render();
    assert.deepEqual(byRole(tree, "radio").map((r) => r.props["aria-checked"]), [false, true]);
  });

  it("送信は 1 回だけ（連打しても）。body は { answers } だけで、送信中はボタンが「送信中...」で押せず、一覧にも戻れない", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    let tree = m.render();
    const send = button(tree, "回答を送信する");
    click(send);
    click(send);
    assert.equal(m.reqs.length, 3);
    assert.equal(m.reqs[2].url, "/api/quizzes/mini2/submit");
    assert.equal(m.reqs[2].init?.method, "POST");
    assert.deepEqual(JSON.parse(String(m.reqs[2].init?.body)), { answers: [1, 2] });
    tree = m.render();
    assert.equal(button(tree, "送信中...").props.disabled, true);
    assert.equal(button(tree, "テスト一覧に戻る").props.disabled, true);
    assert.ok(byRole(tree, "radio").every((r) => r.props.disabled === true));
    // 送信中に戻るを押しても（disabled を無視して呼んでも）受験画面のまま
    click(button(tree, "テスト一覧に戻る"));
    assert.equal(m.state("activeQuizId"), "mini2");
  });

  it("結果：サーバーの点数・合否・正解数・問題ごとの正誤をそのまま出し、選択肢（正解）は出さない。一覧を読み直す", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ score: 50, passed: false, total: 2, correct: 1, results: [false, true] }, { url: `${ORIGIN}/api/quizzes/mini2/submit` }));
    await settle();
    const tree = m.render();
    const t = text(tree);
    assert.ok(t.includes(quizResultTitle(false)));
    assert.ok(t.includes("50点（2問中 1問正解）"));
    // 問題ごとの正誤は問題の順（取り違えがない）
    const items = findAll(tree, (e) => e.type === "li").map(text);
    assert.deepEqual(items, ["問題 1ダミー問1不正解", "問題 2ダミー問2正解"]);
    for (const s of ["選択肢A", "選択肢B", "選択肢C", "選択肢D", "選択肢E"]) assert.ok(!t.includes(s), s);
    assert.ok(!t.includes("途中で戻ると"));
    assert.deepEqual(buttonLabels(tree).filter((l) => l !== "テスト一覧に戻る"), ["もう一度受ける"]);
    // 一覧の読み直し
    assert.equal(m.reqs.length, 4);
    assert.equal(m.reqs[3].url, "/api/quizzes");
  });

  it("合格の結果は「合格です」", async () => {
    const m = await openTake();
    chooseAll(m, [0, 0]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ score: 100, passed: true, total: 2, correct: 2, results: [true, true] }));
    await settle();
    const t = text(m.render());
    assert.ok(t.includes("合格です"));
    assert.ok(!t.includes("不合格です"));
    assert.ok(t.includes("100点（2問中 2問正解）"));
  });

  for (const [label, r] of [
    ["500", res({ error: "Internal server error" }, { status: 500, ok: false })],
    ["503（受験の停止中）", res({ error: "Quiz attempts are not available yet", reason: "attempts_disabled" }, { status: 503, ok: false })],
    ["応答の形が違う（問題数と合わない）", res({ score: 100, passed: true, total: 3, correct: 3, results: [true, true, true] })],
  ] as Array<[string, FakeRes]>) {
    it(`送信の失敗（${label}）：role=alert、回答は残り、「もう一度送信する」で同じ回答を送れる`, async () => {
      const m = await openTake();
      chooseAll(m, [1, 2]);
      click(button(m.render(), "回答を送信する"));
      m.reqs[2].release(r);
      await settle();
      let tree = m.render();
      const alerts = byRole(tree, "alert");
      assert.equal(alerts.length, 1);
      assert.ok(text(alerts[0]).includes("送信できませんでした。回答はそのまま残っています。"));
      assert.deepEqual(byRole(tree, "radio").map((x) => x.props["aria-checked"]), [false, false, true]);
      assert.ok(!text(tree).includes("点（"));
      click(button(tree, "もう一度送信する"));
      assert.equal(m.reqs.length, 4);
      assert.deepEqual(JSON.parse(String(m.reqs[3].init?.body)), { answers: [1, 2] });
      tree = m.render();
      assert.equal(byRole(tree, "alert").length, 0);
    });
  }

  it("もう一度受ける：回答を消して 1 問目から（問題は読み直さない）", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ score: 50, passed: false, total: 2, correct: 1, results: [false, true] }));
    await settle();
    const before = m.reqs.length;
    click(button(m.render(), "もう一度受ける"));
    const tree = m.render();
    assert.ok(text(tree).includes("問題 1 / 2"));
    assert.deepEqual(byRole(tree, "radio").map((r) => r.props["aria-checked"]), [false, false]);
    assert.equal(m.reqs.length, before);
  });

  it("問題の読み込み失敗（409 quiz_unavailable）は role=alert と再読み込み", async () => {
    const m = await loadedList(true);
    click(buttons(m.render())[2]);
    m.reqs[1].release(res({ error: "Quiz unavailable", reason: "quiz_unavailable" }, { status: 409, ok: false }));
    await settle();
    const tree = m.render();
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1);
    assert.ok(text(alerts[0]).includes("テストを読み込めませんでした"));
    click(button(tree, "再読み込み"));
    assert.equal(m.reqs.length, 3);
    assert.equal(m.reqs[2].url, "/api/quizzes/mini2");
  });

  it("問題の応答に correctIndex が混ざっていても、画面の値には持ち込まない", async () => {
    const m = await loadedList(true);
    click(buttons(m.render())[2]);
    const leaky = { ...TAKE, questions: TAKE.questions.map((q) => ({ ...q, correctIndex: 1 })) };
    m.reqs[1].release(res(leaky));
    await settle();
    m.render();
    assert.doesNotMatch(JSON.stringify(m.state("takeQuiz")), /correctIndex/);
  });

  it("一覧に戻ると受験の状態を消して一覧を出す", async () => {
    const m = await openTake();
    chooseAll(m, [1]);
    click(button(m.render(), "テスト一覧に戻る"));
    const t = text(m.render());
    assert.ok(t.includes("STEP1 ダミー"));
    assert.equal(m.state("activeQuizId"), null);
    assert.deepEqual(m.state("answers"), []);
  });
});
