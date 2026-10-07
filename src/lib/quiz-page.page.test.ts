import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAuthFailure } from "./client-session";
import { buildSubmitBody, toQuizResultView, toQuizTakeView } from "./student-quizzes";

// #32 確認テストのページ：page.tsx（// @ts-nocheck）の QuizPage をソースで検査し、
// 読み込み・受験・送信の関数を取り出して、偽の useState / useRef / authFetch と本物の lib 関数で動かす。
// レンダリング・DB・ネットワークなし。データはすべてダミー。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const quizPage = component("QuizPage");

function between(from: string, to: string): string {
  const a = quizPage.indexOf(from);
  const b = quizPage.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} 〜 ${to} が見つからない`);
  return quizPage.slice(a, b);
}

const loadSrc = between("const loadQuizzes", "useEffect(");
const takeSrc = between("const openQuiz", "const spinner");

// ───────────── ソースの検査 ─────────────

describe("QuizPage：見本データを残さない", () => {
  const banned: Array<[string, RegExp]> = [
    ["steps（見本のコース）", /\bsteps\b/],
    ["demoQuestions", /demoQuestions/],
    ["見本の問題（Flexbox）", /Flexbox/],
    ["見本の問題（flex-direction）", /flex-direction/],
    ["固定の所要時間（15分）", /15分/],
    ["固定の所要時間（20分）", /20分/],
    ["固定の点数（score: 90）", /score: \d+/],
    ["見本のミニテスト名（PC基本操作）", /PC基本操作/],
    ["固定の説明（STEP1〜3のみ）", /STEP1〜3のみ/],
    ["固定の説明（STEP4〜8 はテストなし）", /STEP4〜8/],
    ["合格！", /合格！/],
    ["不合格…", /不合格…/],
    ["絵文字（パーティー）", new RegExp(String.fromCodePoint(0x1f389))],
    ["絵文字（メモ）", new RegExp(String.fromCodePoint(0x1f4dd))],
  ];
  for (const [label, re] of banned) {
    it(`${label} がない`, () => {
      assert.doesNotMatch(quizPage, re);
    });
  }

  it("絵文字を使わない", () => {
    assert.doesNotMatch(quizPage, new RegExp("\\p{Extended_Pictographic}", "u"));
  });
});

describe("QuizPage：データの配線", () => {
  it("student-quizzes から必要な関数と QUIZ_ATTEMPTS_ENABLED を import する", () => {
    const m = src.match(/import \{([^}]*)\} from "@\/lib\/student-quizzes";/);
    assert.ok(m, "import がない");
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const n of ["QUIZ_ATTEMPTS_ENABLED", "PASSING_PERCENT", "buildSubmitBody", "quizResultTitle", "toQuizCourseItems", "toQuizResultView", "toQuizTakeView"]) {
      assert.ok(names.includes(n), n);
    }
  });

  it("QUIZ_ATTEMPTS_ENABLED を page.tsx の中で定義・上書きしない", () => {
    assert.doesNotMatch(src, /(const|let|var)\s+QUIZ_ATTEMPTS_ENABLED\b/);
    assert.doesNotMatch(src, /QUIZ_ATTEMPTS_ENABLED\s*=[^=]/);
  });

  it("/api/quizzes を authFetch で読み、失効は classifyAuthFailure で判定する", () => {
    assert.match(quizPage, /authFetch\("\/api\/quizzes"\)/);
    assert.match(quizPage, /classifyAuthFailure\(\{ status: res\.status, redirected: res\.redirected, url: res\.url \}\) === "expired"/);
    assert.match(quizPage, /const courses = toQuizCourseItems\(quizData\);/);
  });

  it("useRef で二重読み込み・二重送信を防ぐ", () => {
    assert.match(quizPage, /const quizzesInFlight = useRef\(false\);/);
    assert.match(quizPage, /if \(quizzesInFlight\.current\) return;/);
    assert.match(quizPage, /const submitInFlight = useRef\(false\);/);
  });

  it("画面で採点しない（正解・正解率の計算がない。結果はサーバーの値を toQuizResultView で使う）", () => {
    assert.doesNotMatch(quizPage, /correctIndex|\.correct\b(?!\})|q\.correct|correct:/);
    assert.doesNotMatch(quizPage, /0\.7|\/ questions\.length|score \+/);
    assert.match(quizPage, /toQuizResultView\(data, questionCount\)/);
  });

  it("URL の quizId は encodeURIComponent する", () => {
    assert.match(quizPage, /`\/api\/quizzes\/\$\{encodeURIComponent\(quizId\)\}`/);
    assert.match(quizPage, /`\/api\/quizzes\/\$\{encodeURIComponent\(takeQuiz\.id\)\}\/submit`/);
  });
});

describe("QuizPage：表示", () => {
  it("空・失敗の文言、失敗は role=alert と再読み込み（読み込み中は disabled）", () => {
    assert.ok(quizPage.includes("受けられる確認テストはまだありません"));
    assert.ok(quizPage.includes("確認テストを読み込めませんでした"));
    assert.match(quizPage, /role="alert"/);
    assert.match(quizPage, /onClick=\{loadQuizzes\} disabled=\{loading\}/);
  });

  it("受験ボタンは QUIZ_ATTEMPTS_ENABLED が true で、ロックされていないコースだけ。false の間は「受験は準備中です」", () => {
    assert.match(quizPage, /\{QUIZ_ATTEMPTS_ENABLED && !course\.locked && \(\s*<Button[^>]*onClick=\{\(\) => openQuiz\(quiz\.id\)\}/);
    assert.match(quizPage, /\{!QUIZ_ATTEMPTS_ENABLED && \(\s*<div role="status"[^>]*>\s*受験は準備中です/);
    // openQuiz を呼ぶのは受験ボタンと、受験画面の再読み込みだけ
    const calls = quizPage.match(/openQuiz\(/g) ?? [];
    assert.equal(calls.length, 2, "受験ボタン 1 + 受験画面の再読み込み 1");
  });

  it("受験画面は QUIZ_ATTEMPTS_ENABLED が true のときだけ開く", () => {
    assert.match(quizPage, /if \(QUIZ_ATTEMPTS_ENABLED && activeQuizId !== null\) \{/);
    assert.match(takeSrc, /const openQuiz = \(quizId\) => \{\s*if \(!QUIZ_ATTEMPTS_ENABLED\) return;/);
    assert.match(takeSrc, /if \(!QUIZ_ATTEMPTS_ENABLED \|\| submitInFlight\.current \|\| !takeQuiz\) return;/);
  });

  it("ロック中のコースは「前のコースを終えると受けられます」", () => {
    assert.match(quizPage, /\{course\.locked && \(/);
    assert.ok(quizPage.includes("前のコースを終えると受けられます"));
  });

  it("コースごとに「修了テスト」「ミニテスト」、問題数・最高点・合否", () => {
    for (const s of [">修了テスト<", ">ミニテスト<", "{quiz.questionCount}問", "最高 {quiz.bestScore}点", "{quiz.statusLabel}"]) {
      assert.ok(quizPage.includes(s), s);
    }
  });

  it("結果は点数・合否・正解数・問題ごとの正誤（文言だけ）", () => {
    assert.match(quizPage, /\{quizResultTitle\(result\.passed\)\}/);
    assert.ok(quizPage.includes("{result.score}点（{result.total}問中 {result.correct}問正解）"));
    assert.ok(quizPage.includes('{result.results[i] ? "正解" : "不正解"}'));
    // 正解の選択肢そのもの（options）は結果に出さない
    const resultBlock = quizPage.slice(quizPage.indexOf("} else if (result) {"), quizPage.indexOf("} else {", quizPage.indexOf("} else if (result) {")));
    assert.doesNotMatch(resultBlock, /options/);
  });

  it("途中で戻ると保存されない旨を表示し、送信中は戻れない", () => {
    assert.ok(quizPage.includes("途中で戻ると、それまでの回答は保存されません。"));
    assert.match(quizPage, /onClick=\{closeQuiz\} disabled=\{submitting\}/);
  });

  it("送信失敗は role=alert で、回答を残してもう一度送信できる", () => {
    assert.ok(quizPage.includes("送信できませんでした。回答はそのまま残っています。"));
    assert.match(quizPage, /submitFailed \? "もう一度送信する" : "回答を送信する"/);
    assert.match(quizPage, /disabled=\{!submitBody \|\| submitting\}/);
  });
});

// ───────────── 実行：loadQuizzes ─────────────

type FakeRes = { status: number; ok: boolean; redirected: boolean; url: string; json: () => Promise<unknown> };
const ORIGIN = "https://nwa-lms.example.com";
const settle = () => new Promise((r) => setTimeout(r, 0));

function res(p: Partial<FakeRes> & { body?: unknown }, url = `${ORIGIN}/api/quizzes`): FakeRes {
  const { body, ...rest } = p;
  return { status: 200, ok: true, redirected: false, url, json: () => Promise.resolve(body), ...rest };
}

function deferred() {
  let release!: (r: FakeRes) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<FakeRes>((r, j) => {
    release = r;
    fail = j;
  });
  return { promise, release, fail };
}

function refOf<T>(get: () => T, set: (v: T) => void) {
  return {
    get current() {
      return get();
    },
    set current(v: T) {
      set(v);
    },
  };
}

function listHarness() {
  const st = { data: null as unknown, loading: true, loadFailed: false, inFlight: false, urls: [] as string[] };
  const reqs: Array<ReturnType<typeof deferred>> = [];
  const authFetch = (url: string) => {
    st.urls.push(url);
    const d = deferred();
    reqs.push(d);
    return d.promise;
  };
  const make = new Function("authFetch", "classifyAuthFailure", "quizzesInFlight", "setQuizData", "setLoading", "setLoadFailed", `${loadSrc}\nreturn loadQuizzes;`);
  const load = make(
    authFetch,
    classifyAuthFailure,
    refOf(() => st.inFlight, (v) => (st.inFlight = v)),
    (v: unknown) => (st.data = v),
    (v: boolean) => (st.loading = v),
    (v: boolean) => (st.loadFailed = v)
  ) as () => void;
  return { st, load, reqs };
}

describe("loadQuizzes：状態遷移（実行）", () => {
  it("成功：courses の配列があれば setQuizData、loading=false", async () => {
    const { st, load, reqs } = listHarness();
    load();
    assert.deepEqual(st.urls, ["/api/quizzes"]);
    reqs[0].release(res({ body: { courses: [] } }));
    await settle();
    assert.deepEqual(st.data, { courses: [] });
    assert.equal(st.loading, false);
    assert.equal(st.loadFailed, false);
    assert.equal(st.inFlight, false);
  });

  it("読み込み中にもう一度呼んでも取得しない", () => {
    const { st, load } = listHarness();
    load();
    load();
    assert.equal(st.urls.length, 1);
  });

  for (const [label, r] of [
    ["/login へのリダイレクト", { redirected: true, url: `${ORIGIN}/login?callbackUrl=%2F` }],
    ["401", { status: 401, ok: false }],
  ] as Array<[string, Partial<FakeRes>]>) {
    it(`失効（${label}）：読み込み中のまま、失敗にしない、再取得しない`, async () => {
      const { st, load, reqs } = listHarness();
      load();
      reqs[0].release(res(r));
      await settle();
      assert.equal(st.loading, true);
      assert.equal(st.loadFailed, false);
      assert.equal(st.data, null);
      load();
      assert.equal(st.urls.length, 1);
    });
  }

  for (const [label, r] of [
    ["500", { status: 500, ok: false, body: { error: "Internal server error" } }],
    ["/ へのリダイレクト", { redirected: true, url: `${ORIGIN}/` }],
    ["courses がない", { body: { error: "x" } }],
    ["courses が配列でない", { body: { courses: "x" } }],
    ["配列そのもの", { body: [] }],
    ["null", { body: null }],
  ] as Array<[string, Partial<FakeRes> & { body?: unknown }]>) {
    it(`失敗（${label}）：loadFailed、loading=false、もう一度読める`, async () => {
      const { st, load, reqs } = listHarness();
      load();
      reqs[0].release(res(r));
      await settle();
      assert.equal(st.loadFailed, true);
      assert.equal(st.loading, false);
      assert.equal(st.inFlight, false);
      load();
      assert.equal(st.urls.length, 2);
      assert.equal(st.loadFailed, false);
    });
  }

  it("例外（ネットワーク）も失敗", async () => {
    const { st, load, reqs } = listHarness();
    load();
    reqs[0].fail(new TypeError("Failed to fetch"));
    await settle();
    assert.equal(st.loadFailed, true);
    assert.equal(st.loading, false);
  });
});

// ───────────── 実行：受験（openQuiz / closeQuiz / selectAnswer / submitQuiz / retakeQuiz） ─────────────

type Take = {
  openQuiz: (id: string) => void;
  closeQuiz: () => void;
  selectAnswer: (oi: number) => void;
  submitQuiz: () => void;
  retakeQuiz: () => void;
};

const QUIZ = {
  id: "quiz/1",
  title: "ダミーテスト",
  type: "MINI",
  questionCount: 2,
  questions: [
    { id: "q1", question: "問1", options: ["a", "b"] },
    { id: "q2", question: "問2", options: ["c", "d", "e"] },
  ],
  attemptCount: 0,
  bestScore: null,
  passed: null,
};
const RESULT = { score: 50, passed: false, total: 2, correct: 1, results: [true, false] };

/**
 * 受験まわりの関数を、React の再描画のように「いまの state」で作り直しながら動かす。
 * ref（takeSeq・submitInFlight）は描画をまたいで残る
 */
function takeHarness(enabled: boolean) {
  const st = {
    activeQuizId: null as string | null,
    takeQuiz: null as ReturnType<typeof toQuizTakeView>,
    takeLoading: false,
    takeFailed: false,
    answers: [] as Array<number | null>,
    currentQ: 0,
    submitting: false,
    submitFailed: false,
    result: null as unknown,
    seq: 0,
    submitInFlight: false,
    reloads: 0,
  };
  const reqs: Array<{ url: string; init?: RequestInit } & ReturnType<typeof deferred>> = [];
  const authFetch = (url: string, init?: RequestInit) => {
    const d = deferred();
    reqs.push({ url, init, ...d });
    return d.promise;
  };
  const set = <K extends keyof typeof st>(k: K) => (v: unknown) => {
    st[k] = (typeof v === "function" ? (v as (p: unknown) => unknown)(st[k]) : v) as (typeof st)[K];
  };
  const make = new Function(
    "QUIZ_ATTEMPTS_ENABLED",
    "authFetch",
    "classifyAuthFailure",
    "toQuizTakeView",
    "toQuizResultView",
    "buildSubmitBody",
    "loadQuizzes",
    "takeSeq",
    "submitInFlight",
    "takeQuiz",
    "answers",
    "currentQ",
    "setActiveQuizId",
    "setTakeQuiz",
    "setTakeLoading",
    "setTakeFailed",
    "setAnswers",
    "setCurrentQ",
    "setSubmitting",
    "setSubmitFailed",
    "setResult",
    `${takeSrc}\nreturn { openQuiz, closeQuiz, selectAnswer, submitQuiz, retakeQuiz };`
  );
  const takeSeq = refOf(() => st.seq, (v) => (st.seq = v));
  const submitInFlight = refOf(() => st.submitInFlight, (v) => (st.submitInFlight = v));
  /** いまの state で関数を作る（1 回の描画に相当） */
  const render = (): Take =>
    make(
      enabled,
      authFetch,
      classifyAuthFailure,
      toQuizTakeView,
      toQuizResultView,
      buildSubmitBody,
      () => st.reloads++,
      takeSeq,
      submitInFlight,
      st.takeQuiz,
      st.answers,
      st.currentQ,
      set("activeQuizId"),
      set("takeQuiz"),
      set("takeLoading"),
      set("takeFailed"),
      set("answers"),
      set("currentQ"),
      set("submitting"),
      set("submitFailed"),
      set("result")
    ) as Take;
  return { st, reqs, render };
}

async function openLoaded(enabled = true) {
  const h = takeHarness(enabled);
  h.render().openQuiz(QUIZ.id);
  h.reqs[0].release(res({ body: QUIZ }, `${ORIGIN}/api/quizzes/quiz%2F1`));
  await settle();
  return h;
}

function answerAll(h: ReturnType<typeof takeHarness>, picks: number[]) {
  picks.forEach((p, i) => {
    h.st.currentQ = i;
    h.render().selectAnswer(p);
  });
}

describe("QUIZ_ATTEMPTS_ENABLED が false", () => {
  it("openQuiz も submitQuiz も何もしない（取得・送信しない）", () => {
    const h = takeHarness(false);
    h.render().openQuiz("quiz1");
    assert.equal(h.reqs.length, 0);
    assert.equal(h.st.activeQuizId, null);
    h.st.takeQuiz = toQuizTakeView(QUIZ);
    h.st.answers = [0, 0];
    h.render().submitQuiz();
    assert.equal(h.reqs.length, 0);
    assert.equal(h.st.submitting, false);
  });
});

describe("受験：問題の読み込み（QUIZ_ATTEMPTS_ENABLED が true の経路）", () => {
  it("GET /api/quizzes/<id>（エンコード済み）を読み、問題と未回答の配列を用意する", async () => {
    const h = await openLoaded();
    assert.equal(h.reqs[0].url, "/api/quizzes/quiz%2F1");
    assert.equal(h.reqs[0].init, undefined);
    assert.equal(h.st.activeQuizId, QUIZ.id);
    assert.deepEqual(h.st.takeQuiz, { id: QUIZ.id, title: QUIZ.title, questions: QUIZ.questions });
    assert.deepEqual(h.st.answers, [null, null]);
    assert.equal(h.st.takeLoading, false);
    assert.equal(h.st.takeFailed, false);
  });

  for (const [label, r] of [
    ["409", { status: 409, ok: false, body: { error: "Quiz unavailable", reason: "quiz_unavailable" } }],
    ["壊れた応答（問題 0 件）", { body: { ...QUIZ, questions: [] } }],
    ["壊れた応答（選択肢 1 件）", { body: { ...QUIZ, questions: [{ id: "q1", question: "問1", options: ["a"] }] } }],
  ] as Array<[string, Partial<FakeRes> & { body?: unknown }]>) {
    it(`失敗（${label}）：takeFailed`, async () => {
      const h = takeHarness(true);
      h.render().openQuiz("quiz1");
      h.reqs[0].release(res(r));
      await settle();
      assert.equal(h.st.takeFailed, true);
      assert.equal(h.st.takeQuiz, null);
      assert.equal(h.st.takeLoading, false);
    });
  }

  it("失効：読み込み中のまま", async () => {
    const h = takeHarness(true);
    h.render().openQuiz("quiz1");
    h.reqs[0].release(res({ status: 401, ok: false }));
    await settle();
    assert.equal(h.st.takeLoading, true);
    assert.equal(h.st.takeFailed, false);
  });

  it("一覧に戻ったあとに届いた応答は捨てる（同じクイズを開き直しても古い応答は使わない）", async () => {
    const h = takeHarness(true);
    h.render().openQuiz("quiz1");
    h.render().closeQuiz();
    h.render().openQuiz("quiz1");
    h.reqs[0].release(res({ body: { ...QUIZ, title: "古い" } }));
    await settle();
    assert.equal(h.st.takeQuiz, null);
    assert.equal(h.st.takeLoading, true);
    h.reqs[1].release(res({ body: QUIZ }));
    await settle();
    assert.equal(h.st.takeQuiz?.title, QUIZ.title);
  });
});

describe("受験：回答と送信（QUIZ_ATTEMPTS_ENABLED が true の経路）", () => {
  it("1 問ずつ選び、未回答が残っていれば送信しない", async () => {
    const h = await openLoaded();
    answerAll(h, [1]);
    assert.deepEqual(h.st.answers, [1, null]);
    h.render().submitQuiz();
    assert.equal(h.reqs.length, 1);
  });

  it("全問回答で 1 回だけ POST し、body は { answers } だけ（正解・採点を送らない）", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    const t = h.render();
    t.submitQuiz();
    t.submitQuiz();
    h.render().submitQuiz();
    assert.equal(h.reqs.length, 2, "二重送信しない");
    const post = h.reqs[1];
    assert.equal(post.url, "/api/quizzes/quiz%2F1/submit");
    assert.equal(post.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(post.init?.body)), { answers: [1, 2] });
    assert.equal(h.st.submitting, true);
  });

  it("送信中は回答を変えられず、一覧にも戻れない", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.st.currentQ = 0;
    h.render().selectAnswer(0);
    assert.deepEqual(h.st.answers, [1, 2]);
    h.render().closeQuiz();
    assert.equal(h.st.activeQuizId, QUIZ.id);
  });

  it("成功：サーバーの結果をそのまま表示し、一覧を読み直す", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res({ body: RESULT }));
    await settle();
    assert.deepEqual(h.st.result, RESULT);
    assert.equal(h.st.submitting, false);
    assert.equal(h.st.submitFailed, false);
    assert.equal(h.st.submitInFlight, false);
    assert.equal(h.st.reloads, 1);
  });

  for (const [label, r] of [
    ["500", { status: 500, ok: false, body: { error: "Internal server error" } }],
    ["400", { status: 400, ok: false, body: { error: "Invalid request", reason: "invalid_answers" } }],
    ["壊れた結果（results の長さ違い）", { body: { ...RESULT, results: [true] } }],
  ] as Array<[string, Partial<FakeRes> & { body?: unknown }]>) {
    it(`失敗（${label}）：回答を残して submitFailed、同じ回答で再送信できる`, async () => {
      const h = await openLoaded();
      answerAll(h, [1, 2]);
      h.render().submitQuiz();
      h.reqs[1].release(res(r));
      await settle();
      assert.equal(h.st.submitFailed, true);
      assert.equal(h.st.result, null);
      assert.deepEqual(h.st.answers, [1, 2]);
      assert.equal(h.st.submitting, false);
      assert.equal(h.st.reloads, 0);
      h.render().submitQuiz();
      assert.equal(h.reqs.length, 3);
      assert.deepEqual(JSON.parse(String(h.reqs[2].init?.body)), { answers: [1, 2] });
      assert.equal(h.st.submitFailed, false);
    });
  }

  it("例外（ネットワーク）も失敗で、回答は残る", async () => {
    const h = await openLoaded();
    answerAll(h, [0, 0]);
    h.render().submitQuiz();
    h.reqs[1].fail(new TypeError("Failed to fetch"));
    await settle();
    assert.equal(h.st.submitFailed, true);
    assert.deepEqual(h.st.answers, [0, 0]);
  });

  it("失効：送信中のまま（/login へ移るのを待つ）", async () => {
    const h = await openLoaded();
    answerAll(h, [0, 0]);
    h.render().submitQuiz();
    h.reqs[1].release(res({ redirected: true, url: `${ORIGIN}/login` }));
    await settle();
    assert.equal(h.st.submitting, true);
    assert.equal(h.st.submitFailed, false);
    assert.equal(h.st.result, null);
  });

  it("もう一度受ける：回答と結果を消して 1 問目から", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res({ body: RESULT }));
    await settle();
    h.render().retakeQuiz();
    assert.deepEqual(h.st.answers, [null, null]);
    assert.equal(h.st.currentQ, 0);
    assert.equal(h.st.result, null);
    assert.equal(h.reqs.length, 2, "問題は読み直さない");
  });

  it("一覧に戻ると受験の状態を消す", async () => {
    const h = await openLoaded();
    answerAll(h, [1]);
    h.render().closeQuiz();
    assert.equal(h.st.activeQuizId, null);
    assert.equal(h.st.takeQuiz, null);
    assert.deepEqual(h.st.answers, []);
  });
});
