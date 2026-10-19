import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import ts from "typescript";
import { classifyAuthFailure } from "./client-session";
import {
  PASSING_PERCENT,
  QUIZ_ATTEMPTS_ENABLED,
  QUIZ_CHANGED_MESSAGE,
  QUIZ_DUPLICATE_MESSAGE,
  QUIZ_RATE_LIMITED_LEAVE_NOTE,
  buildSubmitBody,
  classifyQuizSubmitResponse,
  quizAttemptRuleText,
  quizRateLimitedMessage,
  quizResultTitle,
  quizWaitMessage,
  toQuizCourseItems,
  toQuizTakeView,
} from "./student-quizzes";

// #32 確認テストのページ：page.tsx（// @ts-nocheck）の QuizPage 全体を typescript（devDependencies）の
// transpileModule で JSX から変換し、偽の React（useState / useRef / useEffect と要素の木）で「描画」して、
// 表示される文言・ボタン・状態遷移を確かめる。
// quiz-page.page.test.ts（ソースの検査と関数単位の実行）の補強。DOM・DB・ネットワークなし。データはすべてダミー。
//
// テストの範囲：本物の React ではなく偽の React で描画する。そのため次のことは検証しない。
// - useEffect の依存配列（最初の描画の後に 1 回だけ実行する）と cleanup（呼ばない）
// - setState による再描画（state を書き換えるだけ。描画はテストが render() を呼んだときだけ）
// - key の重複や欠け
// - hook の呼び出し順が描画ごとに変わらないこと（呼ばれた順に番号で state を割り当てるだけ）
// 検証するのは、各描画の結果（要素の木）と、ボタンなどのハンドラを呼んだ後の state・リクエスト。
// 木に React が子にできないオブジェクトが混ざっていないか（assertRenderable）は、描画のたびに確かめる。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const quizPageSrc = component("QuizPage");
// JSX を h(type, props, ...children) / Frag に変換する。module は ESNext（import / export を足さない）、
// target は ES2022（構文をそのまま残す）。結果は new Function の本体として評価する
const transpiled = ts.transpileModule(quizPageSrc, {
  fileName: "QuizPage.jsx",
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

/** 要素・文字列・数値以外（React では子にできず例外になるオブジェクト）が木に混ざっていないか */
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
    classifyQuizSubmitResponse,
    buildSubmitBody,
    quizResultTitle,
    quizAttemptRuleText,
    quizRateLimitedMessage,
    quizWaitMessage,
    QUIZ_CHANGED_MESSAGE,
    QUIZ_DUPLICATE_MESSAGE,
    QUIZ_RATE_LIMITED_LEAVE_NOTE,
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
  // 形だけが正しいダミーのトークン（#51 選択肢のシャッフル）
  attemptToken: `v1.${"A".repeat(22)}.${"B".repeat(43)}`,
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

  it("JSX の変換：診断なしで、import / export を含まない（new Function で評価できる）", () => {
    assert.deepEqual(transpiled.diagnostics ?? [], []);
    assert.doesNotMatch(compiled, /^\s*(import|export)\b/m);
    assert.match(compiled, /\bh\(/);
  });

  it("useState の並びが取れている（器の前提）", () => {
    for (const n of ["quizData", "loading", "loadFailed", "activeQuizId", "takeQuiz", "answers", "currentQ", "submitting", "submitFailed", "result"]) {
      assert.ok(STATE_NAMES.includes(n), n);
    }
  });
});

// 一覧の読み込みと一覧の中身は、受験の開閉（QUIZ_ATTEMPTS_ENABLED）によらない。true（本番）と false（止めたとき）の両方で確かめる
for (const enabled of [true, false]) {
  describe(`QuizPage 描画：一覧の読み込み（QUIZ_ATTEMPTS_ENABLED が ${enabled}）`, () => {
    it("最初は読み込み中で、/api/quizzes を 1 回だけ読む（オプションなし）", () => {
      const m = mount(enabled);
      const tree = m.render();
      assert.ok(text(tree).includes("Loading..."), "読み込み中の表示がない");
      assert.equal(m.reqs.length, 1);
      assert.equal(m.reqs[0].url, "/api/quizzes");
      assert.equal(m.reqs[0].init, undefined);
      // 再描画しても取得し直さない
      m.render();
      assert.equal(m.reqs.length, 1);
    });

    it("失敗（500）は role=alert と再読み込みボタン。押すともう一度読み、成功すれば一覧を出す", async () => {
      const m = mount(enabled);
      m.render();
      m.reqs[0].release(res({ error: "Internal server error" }, { status: 500, ok: false }));
      await settle();
      let tree = m.render();
      const alerts = byRole(tree, "alert");
      assert.equal(alerts.length, 1);
      assert.ok(text(alerts[0]).includes("確認テストを読み込めませんでした"), "失敗の文言がない");
      click(button(tree, "再読み込み"));
      assert.equal(m.reqs.length, 2);
      tree = m.render();
      assert.ok(text(tree).includes("Loading..."), "再読み込み中の表示がない");
      m.reqs[1].release(res(LIST));
      await settle();
      tree = m.render();
      assert.equal(byRole(tree, "alert").length, 0);
      assert.ok(text(tree).includes("STEP1 ダミー"), "一覧が出ていない");
    });

    it("courses が空なら「受けられる確認テストはまだありません」で、準備中の案内も受験ボタンも出さない", async () => {
      const m = await loadedList(enabled, { courses: [] });
      const tree = m.render();
      const t = text(tree);
      assert.ok(t.includes("受けられる確認テストはまだありません"), "空の文言がない");
      assert.ok(!t.includes("受験は準備中です"), "空の一覧に準備中の案内を出した");
      assert.deepEqual(buttonLabels(tree), []);
    });

    it(`見出しと合格基準（${PASSING_PERCENT}%）を出し、見本の文言は出さない`, async () => {
      const m = await loadedList(enabled);
      const t = text(m.render());
      assert.ok(t.includes("確認テスト受講"), "見出しがない");
      assert.ok(t.includes(`${PASSING_PERCENT}%以上の正解で合格です。`), "合格基準がない");
      for (const s of ["15分", "20分", "Flexbox", "PC基本操作", "STEP1〜3のみ", "合格！"]) assert.ok(!t.includes(s), s);
    });
  });

  describe(`QuizPage 描画：一覧の中身（QUIZ_ATTEMPTS_ENABLED が ${enabled}）`, () => {
    it("コース名・件数・修了テスト／ミニテストの見出し・問題数・受験回数・最高点・合否", async () => {
      const m = await loadedList(enabled);
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
      assert.ok(!t.includes("レッスン2 · 2問 · 受験"), "未受験の行に受験回数を出した");
      assert.equal((t.match(/最高 /g) ?? []).length, 2);
    });

    it("ロックの表示はロックされたコース（STEP2）だけ", async () => {
      const m = await loadedList(enabled);
      const t = text(m.render());
      assert.equal((t.match(/前のコースを終えると受けられます/g) ?? []).length, 1);
      assert.ok(t.indexOf("前のコースを終えると受けられます") > t.indexOf("STEP2 ダミー"), "ロックの表示が STEP2 の行にない");
    });

    it("画面に出す文言に、正解・回答・受験日時・ID を含まない", async () => {
      const m = await loadedList(enabled);
      const t = text(m.render());
      for (const s of ["correctIndex", "answers", "lastAttemptAt", "2026-10-07", "fin1", "mini2"]) assert.ok(!t.includes(s), s);
    });
  });
}

describe("QuizPage 描画：一覧（QUIZ_ATTEMPTS_ENABLED が false＝受験を止めたとき）", () => {
  it("受験ボタンを 1 つも出さず、「受験は準備中です」を role=status で出す", async () => {
    const m = await loadedList(false);
    const tree = m.render();
    assert.deepEqual(buttonLabels(tree), []);
    const status = byRole(tree, "status");
    assert.equal(status.length, 1);
    assert.ok(text(status[0]).includes("受験は準備中です"), "準備中の案内がない");
  });

  it("受験中の状態が残っていても（activeQuizId があっても）受験画面は開かず、一覧を出す", async () => {
    const m = mount(false, { activeQuizId: "fin1", takeQuiz: toQuizTakeView(TAKE), answers: [null, null] });
    m.render();
    m.reqs[0].release(res(LIST));
    await settle();
    const t = text(m.render());
    assert.ok(t.includes("STEP1 ダミー"), "一覧が出ていない");
    assert.ok(!t.includes("ダミー問1"), "受験画面の問題を出した");
    assert.ok(!t.includes("回答を送信する"), "送信ボタンを出した");
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
  const iconCount = (tree: El, type: unknown) => findAll(tree, (e) => e.type === type).length;

  it("登録されたアイコン（it）はその部品を出す", async () => {
    const m = await loadedList(true, withIcons(["it"]), ICONS);
    const tree = m.render();
    assertRenderable(tree);
    assert.equal(iconCount(tree, IconIt), 1);
  });

  for (const icon of BUILTINS) {
    it(`icon が ${icon} のコースでも例外を出さず、Object の組み込みを使わずに既定のアイコン（BookOpen）を出す`, async () => {
      const m = await loadedList(true, withIcons([icon, "it"]), ICONS);
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
    const m = await loadedList(true, withIcons(["constructor"]));
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

  it("送信は 1 回だけ（連打しても）。body は { answers, questionIds, attemptToken } だけで、送信中はボタンが「送信中...」で押せず、一覧にも戻れない", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    let tree = m.render();
    const send = button(tree, "回答を送信する");
    click(send);
    click(send);
    assert.equal(m.reqs.length, 3);
    assert.equal(m.reqs[2].url, "/api/quizzes/mini2/submit");
    assert.equal(m.reqs[2].init?.method, "POST");
    assert.deepEqual(JSON.parse(String(m.reqs[2].init?.body)), { answers: [1, 2], questionIds: ["q1", "q2"], attemptToken: TAKE.attemptToken });
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
      assert.deepEqual(JSON.parse(String(m.reqs[3].init?.body)), { answers: [1, 2], questionIds: ["q1", "q2"], attemptToken: TAKE.attemptToken });
      tree = m.render();
      assert.equal(byRole(tree, "alert").length, 0);
    });
  }

  it("もう一度受ける：問題を読み直し（GET 1 回）、読み込めたら未回答で 1 問目から（#51）", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ score: 50, passed: false, total: 2, correct: 1, results: [false, true] }));
    await settle();
    const before = m.reqs.length;
    click(button(m.render(), "もう一度受ける"));
    assert.equal(m.reqs.length, before + 1, "GET が 1 回走っていない");
    assert.equal(m.reqs[before].url, "/api/quizzes/mini2");
    assert.ok(text(m.render()).includes("Loading..."), "読み込み中でない");
    m.reqs[before].release(res(TAKE, { url: `${ORIGIN}/api/quizzes/mini2` }));
    await settle();
    const tree = m.render();
    assert.ok(text(tree).includes("問題 1 / 2"));
    assert.deepEqual(byRole(tree, "radio").map((r) => r.props["aria-checked"]), [false, false]);
    assert.equal(byRole(tree, "status").length, 0, "retryAfterSeconds がないのに案内を出した");
    assert.equal(m.reqs.length, before + 1);
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

// ───────────── 受験の公開前の修正（#51） ─────────────

describe("QuizPage 描画：受験の制限と問題の入れ替え（#51、true の経路）", () => {
  const SUBMIT = `${ORIGIN}/api/quizzes/mini2/submit`;

  it("受験画面に、ミニテストの受験の規則（定数から作った文言）を出す。結果の画面には出さない", async () => {
    const m = await openTake();
    const t = text(m.render());
    assert.ok(t.includes(quizAttemptRuleText("MINI")), "規則の文言がない");
    assert.ok(t.includes("1 分あけて") && t.includes("10 回まで"), "規則の数値が違う");
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ score: 50, passed: false, total: 2, correct: 1, results: [false, true], duplicate: false }, { url: SUBMIT }));
    await settle();
    assert.ok(!text(m.render()).includes(quizAttemptRuleText("MINI")), "結果の画面に規則を出している");
  });

  it("修了テストの規則は 30 分・3 回", async () => {
    const m = await loadedList(true);
    click(buttons(m.render())[2]);
    m.reqs[1].release(res({ ...TAKE, type: "FINAL" }));
    await settle();
    assert.ok(text(m.render()).includes("修了テストは前回の受験から 30 分あけて、24 時間に 3 回まで受けられます。"));
  });

  it("GET に retryAfterSeconds があれば、冒頭に role=status の案内（目安つき）を出し、回答は始められる", async () => {
    const m = await loadedList(true);
    click(buttons(m.render())[2]);
    m.reqs[1].release(res({ ...TAKE, retryAfterSeconds: 600 }));
    await settle();
    const tree = m.render();
    const status = byRole(tree, "status").map(text);
    assert.ok(status.includes(quizWaitMessage(600)), `案内がない: ${status.join(" / ")}`);
    assert.ok(quizWaitMessage(600).includes("（目安：約 10 分後）"));
    assert.equal(byRole(tree, "radio").length, 2, "回答を始められない");
  });

  it("retryAfterSeconds がなければ案内を出さない", async () => {
    const m = await openTake();
    assert.equal(byRole(m.render(), "status").length, 0);
  });

  it("429：role=alert に上限の文言・目安・一覧に戻ると回答が消える旨を出し、回答は残る", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ error: "Too many requests", reason: "rate_limited", retryAfterSeconds: 1800 }, { status: 429, ok: false, url: SUBMIT }));
    await settle();
    const tree = m.render();
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1);
    assert.equal(text(alerts[0]).trim(), quizRateLimitedMessage(1800) + QUIZ_RATE_LIMITED_LEAVE_NOTE);
    assert.ok(text(alerts[0]).includes("（目安：約 30 分後）"));
    assert.ok(!text(tree).includes("送信できませんでした。回答はそのまま残っています。もう一度送信してください。"), "通常の失敗の文言も出ている");
    assert.deepEqual(byRole(tree, "radio").map((x) => x.props["aria-checked"]), [false, false, true]);
    assert.equal(m.reqs.length, 3, "一覧を読み直した・自動で再送した");
    assert.equal(button(tree, "もう一度送信する").props.disabled, false);
  });

  it("409 quiz_changed：問題を読み直し、成功したら role=status で知らせ、回答は空", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ error: "Conflict", reason: "quiz_changed" }, { status: 409, ok: false, url: SUBMIT }));
    await settle();
    assert.equal(m.reqs[3].url, "/api/quizzes/mini2");
    let tree = m.render();
    assert.ok(text(tree).includes("Loading..."), "読み込み中でない");
    assert.ok(!text(tree).includes(QUIZ_CHANGED_MESSAGE), "読み込み前に知らせた");
    const v2 = { ...TAKE, questionCount: 3, questions: [...TAKE.questions, { id: "q3", question: "ダミー問3", options: ["選択肢F", "選択肢G"] }] };
    m.reqs[3].release(res(v2, { url: `${ORIGIN}/api/quizzes/mini2` }));
    await settle();
    tree = m.render();
    const status = byRole(tree, "status").map(text);
    assert.ok(status.includes(QUIZ_CHANGED_MESSAGE), "知らせがない");
    assert.ok(text(tree).includes("問題 1 / 3"));
    assert.deepEqual(byRole(tree, "radio").map((x) => x.props["aria-checked"]), [false, false]);
    assert.equal(byRole(tree, "alert").length, 0);
  });

  it("409 quiz_changed の読み直しに失敗したら「テストを読み込めませんでした」で、更新の知らせは出さない", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ error: "Conflict", reason: "quiz_changed" }, { status: 409, ok: false, url: SUBMIT }));
    await settle();
    m.reqs[3].release(res({ error: "Internal server error" }, { status: 500, ok: false }));
    await settle();
    const t = text(m.render());
    assert.ok(t.includes("テストを読み込めませんでした"));
    assert.ok(!t.includes(QUIZ_CHANGED_MESSAGE));
  });

  it("重複（duplicate: true）：結果の上に role=status で知らせ、結果は通常どおり。一覧も読み直す", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ score: 50, passed: false, total: 2, correct: 1, results: [false, true], duplicate: true }, { url: SUBMIT }));
    await settle();
    const tree = m.render();
    assert.deepEqual(byRole(tree, "status").map(text), [QUIZ_DUPLICATE_MESSAGE]);
    assert.ok(text(tree).includes("50点（2問中 1問正解）"));
    assert.ok(text(tree).indexOf(QUIZ_DUPLICATE_MESSAGE) < text(tree).indexOf("50点"), "知らせが結果の上にない");
    assert.equal(m.reqs[3].url, "/api/quizzes");
  });

  it("duplicate: false の結果には重複の知らせを出さない", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ score: 50, passed: false, total: 2, correct: 1, results: [false, true], duplicate: false }, { url: SUBMIT }));
    await settle();
    assert.ok(!text(m.render()).includes(QUIZ_DUPLICATE_MESSAGE));
  });
});

// ───────────── テスト担当の追加（#51） ─────────────

// ロックとの関係（403 course_locked）は、この器がロック用の部品を持たないため quiz-page.page.test.ts で確かめる
describe("QuizPage 描画：#51 の追加の観点", () => {
  const SUBMIT = `${ORIGIN}/api/quizzes/mini2/submit`;
  const RATE = res({ error: "Too many requests", reason: "rate_limited", retryAfterSeconds: 600 }, { status: 429, ok: false, url: SUBMIT });

  async function openWithWait(seconds: number) {
    const m = await loadedList(true);
    click(buttons(m.render())[2]);
    m.reqs[1].release(res({ ...TAKE, retryAfterSeconds: seconds }));
    await settle();
    return m;
  }

  it("事前の案内は送信を始めると消え、429 のあとは role=alert だけで案内は出し直さない", async () => {
    const m = await openWithWait(600);
    assert.ok(byRole(m.render(), "status").map(text).includes(quizWaitMessage(600)), "案内がない");
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    let tree = m.render();
    assert.ok(!text(tree).includes(quizWaitMessage(600)), "送信中も案内が残る");
    m.reqs[2].release(RATE);
    await settle();
    tree = m.render();
    assert.equal(byRole(tree, "status").length, 0, "429 のあとに案内を出し直した");
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1, "alert が 1 つでない");
    assert.ok(text(alerts[0]).includes(QUIZ_RATE_LIMITED_LEAVE_NOTE), "一覧に戻ると消える旨がない");
  });

  it("429 のあとに送り直すと alert が消え、200 で結果を出す（規則の文言は結果の画面に出さない）", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(RATE);
    await settle();
    click(button(m.render(), "もう一度送信する"));
    assert.equal(byRole(m.render(), "alert").length, 0, "送信中に 429 の alert が残る");
    m.reqs[3].release(res({ score: 50, passed: false, total: 2, correct: 1, results: [false, true], duplicate: false }, { url: SUBMIT }));
    await settle();
    const t = text(m.render());
    assert.ok(t.includes("50点（2問中 1問正解）"), "結果がない");
    assert.ok(!t.includes(quizAttemptRuleText("MINI")), "結果の画面に規則を出した");
  });

  it("読み込み中・読み込み失敗の画面には規則・案内を出さない", async () => {
    const m = await loadedList(true);
    click(buttons(m.render())[2]);
    let t = text(m.render());
    assert.ok(t.includes("Loading..."), "読み込み中でない");
    assert.ok(!t.includes(quizAttemptRuleText("MINI")), "読み込み中に規則を出した");
    m.reqs[1].release(res({ error: "Internal server error" }, { status: 500, ok: false }));
    await settle();
    t = text(m.render());
    assert.ok(t.includes("テストを読み込めませんでした"), "失敗の画面でない");
    assert.ok(!t.includes(quizAttemptRuleText("MINI")), "失敗の画面に規則を出した");
  });

  it("種類が不明なクイズは規則の文言を出さない（受験はできる）", async () => {
    const m = await loadedList(true);
    click(buttons(m.render())[2]);
    m.reqs[1].release(res({ ...TAKE, type: "OTHER" }));
    await settle();
    const t = text(m.render());
    assert.ok(!t.includes("前回の受験から"), "不明な種類で規則を出した");
    assert.equal(byRole(m.render(), "radio").length, 2, "受験できない");
  });

  it("読み直しに retryAfterSeconds があれば、更新の知らせと事前の案内を両方 role=status で出す", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ error: "Conflict", reason: "quiz_changed" }, { status: 409, ok: false, url: SUBMIT }));
    await settle();
    m.reqs[3].release(res({ ...TAKE, retryAfterSeconds: 30 }));
    await settle();
    const status = byRole(m.render(), "status").map(text);
    assert.deepEqual(status, [QUIZ_CHANGED_MESSAGE, quizWaitMessage(30)]);
  });

});

describe("QuizPage 描画：QUIZ_ATTEMPTS_ENABLED が false の間は #51 の表示が出ない", () => {
  it("一覧に規則・事前の案内・429・更新・重複の文言を出さず、受験画面の状態が残っていても出さない", async () => {
    const m = mount(false, {
      activeQuizId: "mini2",
      takeQuiz: toQuizTakeView({ ...TAKE, retryAfterSeconds: 600 }),
      answers: [1, 2],
      takeChanged: true,
      takeRetryAfter: 600,
      submitFailed: true,
      submitRateLimited: { retryAfterSeconds: 600 },
    });
    m.render();
    m.reqs[0].release(res(LIST));
    await settle();
    const t = text(m.render());
    assert.ok(t.includes("受験は準備中です"), "準備中の案内がない");
    for (const s of [
      quizAttemptRuleText("MINI"),
      quizAttemptRuleText("FINAL"),
      quizWaitMessage(600),
      quizRateLimitedMessage(600),
      QUIZ_RATE_LIMITED_LEAVE_NOTE,
      QUIZ_CHANGED_MESSAGE,
      QUIZ_DUPLICATE_MESSAGE,
    ]) {
      assert.ok(!t.includes(s), `false の間に表示した: ${s}`);
    }
    assert.equal(m.reqs.length, 1, "一覧以外を読んだ");
  });
});

describe("QuizPage 描画：もう一度受ける（#51、true の経路）", () => {
  const SUBMIT = `${ORIGIN}/api/quizzes/mini2/submit`;
  async function toResult() {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ score: 50, passed: false, total: 2, correct: 1, results: [false, true], duplicate: false }, { url: SUBMIT }));
    await settle();
    const before = m.reqs.length; // 一覧の読み直しを含む
    click(button(m.render(), "もう一度受ける"));
    assert.equal(m.reqs.length, before + 1, "GET が 1 回走っていない");
    assert.equal(m.reqs[before].url, "/api/quizzes/mini2");
    return { m, get: m.reqs[before] };
  }

  it("GET に retryAfterSeconds があれば、冒頭に「いまは送信できません」の案内を出す", async () => {
    const { m, get } = await toResult();
    get.release(res({ ...TAKE, retryAfterSeconds: 60 }, { url: `${ORIGIN}/api/quizzes/mini2` }));
    await settle();
    const tree = m.render();
    assert.deepEqual(byRole(tree, "status").map(text), [quizWaitMessage(60)]);
    assert.ok(text(tree).includes("いまは回答を送信できません"));
    assert.ok(text(tree).includes("問題 1 / 2"), "回答を始められない");
  });

  it("GET に retryAfterSeconds がなければ案内を出さない", async () => {
    const { m, get } = await toResult();
    get.release(res({ ...TAKE, retryAfterSeconds: null }, { url: `${ORIGIN}/api/quizzes/mini2` }));
    await settle();
    assert.equal(byRole(m.render(), "status").length, 0);
  });

  it("読み直しに失敗したら「テストを読み込めませんでした」と再読み込み", async () => {
    const { m, get } = await toResult();
    get.release(res({ error: "Internal server error" }, { status: 500, ok: false }));
    await settle();
    const tree = m.render();
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1);
    assert.ok(text(alerts[0]).includes("テストを読み込めませんでした"));
    assert.ok(!text(tree).includes("50点"), "前の結果が残っている");
    click(button(tree, "再読み込み"));
    assert.equal(m.reqs[m.reqs.length - 1].url, "/api/quizzes/mini2");
  });

  it("読み直しで問題が増えていれば、新しい問題で受ける（quiz_changed の知らせは出さない）", async () => {
    const { m, get } = await toResult();
    const v2 = { ...TAKE, questionCount: 3, questions: [...TAKE.questions, { id: "q3", question: "ダミー問3", options: ["選択肢F", "選択肢G"] }] };
    get.release(res(v2, { url: `${ORIGIN}/api/quizzes/mini2` }));
    await settle();
    const t = text(m.render());
    assert.ok(t.includes("問題 1 / 3"));
    assert.ok(!t.includes(QUIZ_CHANGED_MESSAGE));
  });

  it("読み直すと選択肢は新しい並びで出て、送信は表示位置と新しいトークン（#51 選択肢のシャッフル）", async () => {
    const { m, get } = await toResult();
    const v2 = {
      ...TAKE,
      questions: [
        { ...TAKE.questions[0], options: ["選択肢B", "選択肢A"] },
        { ...TAKE.questions[1], options: ["選択肢E", "選択肢C", "選択肢D"] },
      ],
      attemptToken: `v1.${"C".repeat(22)}.${"D".repeat(43)}`,
    };
    get.release(res(v2, { url: `${ORIGIN}/api/quizzes/mini2` }));
    await settle();
    assert.deepEqual(byRole(m.render(), "radio").map(text), ["選択肢B", "選択肢A"]);
    chooseAll(m, [1, 0]);
    const before = m.reqs.length;
    click(button(m.render(), "回答を送信する"));
    assert.equal(m.reqs.length, before + 1, "送信していない");
    assert.deepEqual(JSON.parse(String(m.reqs[before].init?.body)), { answers: [1, 0], questionIds: ["q1", "q2"], attemptToken: v2.attemptToken });
  });
});

describe("QuizPage 描画：選択肢のシャッフルの補強（#51、テスト担当が追加）", () => {
  const SUBMIT = `${ORIGIN}/api/quizzes/mini2/submit`;
  const tokenParts = (t: string) => [t, t.split(".")[1], t.split(".")[2]];

  it("attemptToken は受験・結果の画面のどこにも（文言にも props にも）出さない", async () => {
    const m = await openTake();
    const dump = (tree: Node) => inspect(tree, { depth: null, maxArrayLength: null, maxStringLength: null });
    for (const p of tokenParts(TAKE.attemptToken)) assert.ok(!dump(m.render()).includes(p), "受験画面にトークンが出た");
    chooseAll(m, [1, 2]);
    for (const p of tokenParts(TAKE.attemptToken)) assert.ok(!dump(m.render()).includes(p), "回答後の画面にトークンが出た");
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ score: 50, passed: false, total: 2, correct: 1, results: [false, true], duplicate: false }, { url: SUBMIT }));
    await settle();
    for (const p of tokenParts(TAKE.attemptToken)) assert.ok(!dump(m.render()).includes(p), "結果の画面にトークンが出た");
  });

  it("409 quiz_changed で読み直すと、新しい並びで出し、送信は新しい並びの表示位置と新しいトークン", async () => {
    const m = await openTake();
    chooseAll(m, [1, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ error: "Conflict", reason: "quiz_changed" }, { status: 409, ok: false, url: SUBMIT }));
    await settle();
    const v2 = {
      ...TAKE,
      questions: [
        { ...TAKE.questions[0], options: ["選択肢B", "選択肢A"] },
        { ...TAKE.questions[1], options: ["選択肢D", "選択肢E", "選択肢C"] },
      ],
      attemptToken: `v1.${"E".repeat(22)}.${"F".repeat(43)}`,
    };
    m.reqs[3].release(res(v2, { url: `${ORIGIN}/api/quizzes/mini2` }));
    await settle();
    assert.deepEqual(byRole(m.render(), "radio").map(text), ["選択肢B", "選択肢A"]);
    assert.deepEqual(byRole(m.render(), "radio").map((x) => x.props["aria-checked"]), [false, false], "前の並びの回答が残っている");
    // 前回と同じ文（選択肢B・選択肢E）を選ぶ：新しい並びでは表示位置 0・1
    chooseAll(m, [0, 1]);
    const before = m.reqs.length;
    click(button(m.render(), "回答を送信する"));
    assert.equal(m.reqs.length, before + 1, "送信していない");
    assert.deepEqual(JSON.parse(String(m.reqs[before].init?.body)), { answers: [0, 1], questionIds: ["q1", "q2"], attemptToken: v2.attemptToken });
  });

  it("結果の正誤は問題の順に出し、どの選択肢を選んだか（並び）は出さない", async () => {
    const m = await openTake();
    chooseAll(m, [0, 2]);
    click(button(m.render(), "回答を送信する"));
    m.reqs[2].release(res({ score: 50, passed: false, total: 2, correct: 1, results: [true, false], duplicate: false }, { url: SUBMIT }));
    await settle();
    const tree = m.render();
    assert.deepEqual(findAll(tree, (e) => e.type === "li").map(text), ["問題 1ダミー問1正解", "問題 2ダミー問2不正解"]);
    assert.equal(byRole(tree, "radio").length, 0, "結果の画面に選択肢を出している");
  });
});
