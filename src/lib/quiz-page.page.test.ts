import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAuthFailure } from "./client-session";
import { COURSE_LOCKED_DESCRIPTION, QUIZ_SUBMIT_LOCKED_MESSAGE, isCourseLockedResponse } from "./course-locked";
import { QUIZ_CHANGED_MESSAGE, buildSubmitBody, classifyQuizSubmitResponse, toQuizTakeView } from "./student-quizzes";

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
    for (const n of [
      "QUIZ_ATTEMPTS_ENABLED",
      "PASSING_PERCENT",
      "buildSubmitBody",
      "quizResultTitle",
      "toQuizCourseItems",
      "toQuizTakeView",
      // #51
      "classifyQuizSubmitResponse",
      "quizAttemptRuleText",
      "quizRateLimitedMessage",
      "quizWaitMessage",
      "QUIZ_CHANGED_MESSAGE",
      "QUIZ_DUPLICATE_MESSAGE",
      "QUIZ_RATE_LIMITED_LEAVE_NOTE",
    ]) {
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

  it("画面で採点しない（正解・正解率の計算がない。結果はサーバーの値を classifyQuizSubmitResponse〔toQuizResultView〕で使う）", () => {
    assert.doesNotMatch(quizPage, /correctIndex|\.correct\b(?!\})|q\.correct|correct:/);
    assert.doesNotMatch(quizPage, /0\.7|\/ questions\.length|score \+/);
    assert.match(quizPage, /classifyQuizSubmitResponse\(res\.status, data, questionCount\)/);
  });

  it("送信の body は画面の問題の並びの id と、GET の attemptToken を含む（#51）", () => {
    assert.match(takeSrc, /buildSubmitBody\(answers, takeQuiz\.questions\.map\(\(x\) => x\.id\), takeQuiz\.attemptToken\)/);
    assert.match(quizPage, /const submitBody = buildSubmitBody\(answers, questions\.map\(\(x\) => x\.id\), takeQuiz \? takeQuiz\.attemptToken : null\);/);
  });

  it("選択肢は API の並びのまま出し、画面では並べ替えない（#51 選択肢のシャッフルはサーバーが行う）", () => {
    assert.doesNotMatch(quizPage, /Math\.random|\.sort\(|shuffleQuestionViews|optionPermutation|toOriginalAnswers/);
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

  it("受験ボタンは QUIZ_ATTEMPTS_ENABLED が true で、ロックされていないコースだけ。false（止めたとき）は「受験は準備中です」", () => {
    assert.match(quizPage, /\{QUIZ_ATTEMPTS_ENABLED && !course\.locked && \(\s*<Button[^>]*onClick=\{\(\) => openQuiz\(quiz\.id\)\}/);
    assert.match(quizPage, /\{!QUIZ_ATTEMPTS_ENABLED && \(\s*<div role="status"[^>]*>\s*受験は準備中です/);
    // openQuiz を呼ぶのは受験ボタンと、受験画面の再読み込みと、409 quiz_changed の読み直し（#51）だけ
    const calls = quizPage.match(/openQuiz\(/g) ?? [];
    assert.equal(calls.length, 4, "受験ボタン 1 + 受験画面の再読み込み 1 + quiz_changed の読み直し 1 + もう一度受ける 1");
    // もう一度受けるは問題を読み直す（#51。GET の retryAfterSeconds で事前の案内を出すため）。読み込み中は何もしない
    assert.match(takeSrc, /const retakeQuiz = \(\) => \{\s*if \(submitInFlight\.current \|\| !takeQuiz \|\| takeLoading\) return;\s*openQuiz\(takeQuiz\.id\);\s*\};/);
    assert.match(takeSrc, /openQuiz\(quizId, true\)/);
  });

  it("受験画面は QUIZ_ATTEMPTS_ENABLED が true のときだけ開く", () => {
    assert.match(quizPage, /if \(QUIZ_ATTEMPTS_ENABLED && activeQuizId !== null\) \{/);
    assert.match(takeSrc, /const openQuiz = \(quizId, afterChange\) => \{\s*if \(!QUIZ_ATTEMPTS_ENABLED\) return;/);
    assert.match(takeSrc, /if \(!QUIZ_ATTEMPTS_ENABLED \|\| submitInFlight\.current \|\| !takeQuiz \|\| submitLocked\) return;/);
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
    assert.match(quizPage, /disabled=\{!submitBody \|\| submitting \|\| submitLocked\}/);
  });

  it("ロック中のコース（403 course_locked。#47 P5）は通信エラーと分けて表示する", () => {
    // 問題の読み込み：LessonView と同じ文言（course-locked.ts）で、再読み込みは出さず一覧へ戻るだけ
    const locked = between("} else if (takeLocked) {", "} else if (takeFailed || !takeQuiz) {");
    assert.match(locked, /role="alert"/);
    assert.ok(locked.includes("{COURSE_LOCKED_TITLE}"), "ロック中の見出しがない");
    assert.ok(locked.includes("{COURSE_LOCKED_DESCRIPTION}"), "ロック中の説明がない");
    assert.match(locked, /onClick=\{closeQuiz\}/);
    assert.ok(!locked.includes("openQuiz"), "ロック中に再読み込みを出している");
    assert.ok(!locked.includes("読み込めませんでした"), "ロック中に通信エラーの文言を出している");
    // 送信：ロック中の文言を出し、通信エラーの文言は出さない
    assert.ok(quizPage.includes("{submitLocked ? ("), "送信のロックを表示していない");
    assert.ok(quizPage.includes("{QUIZ_SUBMIT_LOCKED_MESSAGE}{COURSE_LOCKED_DESCRIPTION}"), "送信のロックの文言がない");
    assert.ok(QUIZ_SUBMIT_LOCKED_MESSAGE.length > 0 && COURSE_LOCKED_DESCRIPTION.length > 0, "文言が空");
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
  // 形だけが正しいダミーのトークン（#51 選択肢のシャッフル。画面は中身を読まずに送り返す）
  attemptToken: `v1.${"A".repeat(22)}.${"B".repeat(43)}`,
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
    takeLocked: false,
    answers: [] as Array<number | null>,
    currentQ: 0,
    submitting: false,
    submitFailed: false,
    submitLocked: false,
    result: null as unknown,
    takeChanged: false,
    takeRetryAfter: null as number | null,
    submitRateLimited: null as unknown,
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
    "isCourseLockedResponse",
    "toQuizTakeView",
    "classifyQuizSubmitResponse",
    "buildSubmitBody",
    "loadQuizzes",
    "takeSeq",
    "submitInFlight",
    "takeQuiz",
    "answers",
    "currentQ",
    "submitLocked",
    "takeLoading",
    "setActiveQuizId",
    "setTakeQuiz",
    "setTakeLoading",
    "setTakeFailed",
    "setTakeLocked",
    "setAnswers",
    "setCurrentQ",
    "setSubmitting",
    "setSubmitFailed",
    "setSubmitLocked",
    "setResult",
    "setTakeChanged",
    "setTakeRetryAfter",
    "setSubmitRateLimited",
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
      isCourseLockedResponse,
      toQuizTakeView,
      classifyQuizSubmitResponse,
      buildSubmitBody,
      () => st.reloads++,
      takeSeq,
      submitInFlight,
      st.takeQuiz,
      st.answers,
      st.currentQ,
      st.submitLocked,
      st.takeLoading,
      set("activeQuizId"),
      set("takeQuiz"),
      set("takeLoading"),
      set("takeFailed"),
      set("takeLocked"),
      set("answers"),
      set("currentQ"),
      set("submitting"),
      set("submitFailed"),
      set("submitLocked"),
      set("result"),
      set("takeChanged"),
      set("takeRetryAfter"),
      set("submitRateLimited")
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

describe("QUIZ_ATTEMPTS_ENABLED が false（受験を止めたとき）", () => {
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

describe("受験：問題の読み込み（QUIZ_ATTEMPTS_ENABLED が true＝本番）", () => {
  it("GET /api/quizzes/<id>（エンコード済み）を読み、問題と未回答の配列を用意する", async () => {
    const h = await openLoaded();
    assert.equal(h.reqs[0].url, "/api/quizzes/quiz%2F1");
    assert.equal(h.reqs[0].init, undefined);
    assert.equal(h.st.activeQuizId, QUIZ.id);
    assert.deepEqual(h.st.takeQuiz, { id: QUIZ.id, title: QUIZ.title, type: "MINI", questions: QUIZ.questions, attemptToken: QUIZ.attemptToken, retryAfterSeconds: null });
    assert.deepEqual(h.st.answers, [null, null]);
    assert.equal(h.st.takeLoading, false);
    assert.equal(h.st.takeFailed, false);
  });

  for (const [label, r] of [
    ["409", { status: 409, ok: false, body: { error: "Quiz unavailable", reason: "quiz_unavailable" } }],
    ["壊れた応答（問題 0 件）", { body: { ...QUIZ, questions: [] } }],
    ["壊れた応答（選択肢 1 件）", { body: { ...QUIZ, questions: [{ id: "q1", question: "問1", options: ["a"] }] } }],
    ["壊れた応答（attemptToken なし。#51）", { body: { ...QUIZ, attemptToken: undefined } }],
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

describe("受験：回答と送信（QUIZ_ATTEMPTS_ENABLED が true＝本番）", () => {
  it("1 問ずつ選び、未回答が残っていれば送信しない", async () => {
    const h = await openLoaded();
    answerAll(h, [1]);
    assert.deepEqual(h.st.answers, [1, null]);
    h.render().submitQuiz();
    assert.equal(h.reqs.length, 1);
  });

  it("全問回答で 1 回だけ POST し、body は { answers, questionIds } だけ（正解・採点を送らない）", async () => {
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
    assert.deepEqual(JSON.parse(String(post.init?.body)), { answers: [1, 2], questionIds: ["q1", "q2"], attemptToken: QUIZ.attemptToken });
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
    assert.deepEqual(h.st.result, { ...RESULT, duplicate: false });
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
      assert.deepEqual(JSON.parse(String(h.reqs[2].init?.body)), { answers: [1, 2], questionIds: ["q1", "q2"], attemptToken: QUIZ.attemptToken });
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

  it("もう一度受ける：結果を消して問題を読み直し（GET 1 回）、読み込めたら未回答で 1 問目から", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res({ body: RESULT }));
    await settle();
    h.render().retakeQuiz();
    assert.equal(h.reqs.length, 3, "問題を読み直していない");
    assert.equal(h.reqs[2].url, "/api/quizzes/quiz%2F1");
    assert.equal(h.reqs[2].init, undefined);
    assert.equal(h.st.result, null);
    assert.equal(h.st.takeLoading, true);
    h.reqs[2].release(res({ body: QUIZ }));
    await settle();
    assert.deepEqual(h.st.answers, [null, null]);
    assert.equal(h.st.currentQ, 0);
    assert.equal(h.st.takeLoading, false);
    assert.equal(h.reqs.length, 3, "GET が 1 回でない");
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

// ───────────── 実行：ロック中のコース（403 course_locked。#47 P5） ─────────────

const LOCKED_403 = { status: 403, ok: false, body: { error: "Forbidden", reason: "course_locked" } };

describe("受験：ロック中のコース（403 course_locked。#47 P5）", () => {
  it("問題の読み込みが 403 course_locked なら takeLocked（takeFailed にしない）で、一覧を読み直す", async () => {
    const h = takeHarness(true);
    h.render().openQuiz("quiz1");
    h.reqs[0].release(res(LOCKED_403));
    await settle();
    assert.equal(h.st.takeLocked, true, "takeLocked にならない");
    assert.equal(h.st.takeFailed, false, "通信エラーとして扱っている");
    assert.equal(h.st.takeQuiz, null, "問題を表示している");
    assert.equal(h.st.takeLoading, false, "読み込み中のまま");
    assert.equal(h.st.reloads, 1, "一覧を読み直していない");
  });

  for (const [label, r] of [
    ["reason のない 403", { status: 403, ok: false, body: { error: "Forbidden" } }],
    ["別の reason の 403", { status: 403, ok: false, body: { error: "Forbidden", reason: "forbidden_role" } }],
    ["本文を読めない 403", { status: 403, ok: false, json: () => Promise.reject(new SyntaxError("Unexpected token")) }],
    ["reason が course_locked の 500", { status: 500, ok: false, body: { reason: "course_locked" } }],
  ] as Array<[string, Partial<FakeRes> & { body?: unknown }]>) {
    it(`問題の読み込みが ${label} なら、これまでどおり takeFailed`, async () => {
      const h = takeHarness(true);
      h.render().openQuiz("quiz1");
      h.reqs[0].release(res(r));
      await settle();
      assert.equal(h.st.takeFailed, true, "takeFailed にならない");
      assert.equal(h.st.takeLocked, false, "ロックとして扱っている");
      assert.equal(h.st.takeLoading, false, "読み込み中のまま");
    });
  }

  it("一覧に戻ったあとに届いた 403 course_locked は捨てる", async () => {
    const h = takeHarness(true);
    h.render().openQuiz("quiz1");
    h.render().closeQuiz();
    h.reqs[0].release(res(LOCKED_403));
    await settle();
    assert.equal(h.st.takeLocked, false, "閉じたあとの応答でロック表示になった");
  });

  it("開き直す・一覧に戻ると takeLocked を消す", async () => {
    const h = takeHarness(true);
    h.render().openQuiz("quiz1");
    h.reqs[0].release(res(LOCKED_403));
    await settle();
    h.render().closeQuiz();
    assert.equal(h.st.takeLocked, false, "一覧に戻っても takeLocked が残る");
    h.st.takeLocked = true;
    h.render().openQuiz("quiz1");
    assert.equal(h.st.takeLocked, false, "開き直しても takeLocked が残る");
  });

  it("送信が 403 course_locked なら submitLocked（submitFailed にしない）で、回答を残し、再送信しない", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res(LOCKED_403));
    await settle();
    assert.equal(h.st.submitLocked, true, "submitLocked にならない");
    assert.equal(h.st.submitFailed, false, "通信エラーとして扱っている");
    assert.equal(h.st.result, null, "結果を表示している");
    assert.deepEqual(h.st.answers, [1, 2], "回答が消えた");
    assert.equal(h.st.submitting, false, "送信中のまま");
    assert.equal(h.st.submitInFlight, false, "送信中の印が残る");
    assert.equal(h.st.reloads, 1, "一覧を読み直していない");
    h.render().submitQuiz();
    assert.equal(h.reqs.length, 2, "ロック中に再送信した");
  });

  it("送信が reason のない 403 なら、これまでどおり submitFailed で再送信できる", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res({ status: 403, ok: false, body: { error: "Forbidden" } }));
    await settle();
    assert.equal(h.st.submitFailed, true, "submitFailed にならない");
    assert.equal(h.st.submitLocked, false, "ロックとして扱っている");
    h.render().submitQuiz();
    assert.equal(h.reqs.length, 3, "再送信できない");
  });

  it("もう一度受ける・一覧に戻ると submitLocked を消す", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res(LOCKED_403));
    await settle();
    h.render().retakeQuiz();
    assert.equal(h.st.submitLocked, false, "もう一度受けても submitLocked が残る");
    h.st.submitLocked = true;
    h.render().closeQuiz();
    assert.equal(h.st.submitLocked, false, "一覧に戻っても submitLocked が残る");
  });
});

// ───────────── ロック中のコース：追加の観点（tester。#47 P5） ─────────────

describe("受験：ロック中のコース（追加の観点。#47 P5）", () => {
  for (const [label, r] of [
    ["別の reason の 403", { status: 403, ok: false, body: { error: "Forbidden", reason: "forbidden_role" } }],
    ["本文を読めない 403", { status: 403, ok: false, json: () => Promise.reject(new SyntaxError("Unexpected token")) }],
    ["本文が null の 403", { status: 403, ok: false, body: null }],
    ["reason が course_locked の 500", { status: 500, ok: false, body: { error: "x", reason: "course_locked" } }],
    ["reason が course_locked の 200", { status: 200, ok: true, body: { error: "x", reason: "course_locked" } }],
  ] as Array<[string, Partial<FakeRes> & { body?: unknown }]>) {
    it(`送信が ${label} なら submitFailed（submitLocked にしない）で、回答を残して再送信できる`, async () => {
      const h = await openLoaded();
      answerAll(h, [1, 2]);
      h.render().submitQuiz();
      h.reqs[1].release(res(r, `${ORIGIN}/api/quizzes/quiz%2F1/submit`));
      await settle();
      assert.equal(h.st.submitFailed, true, "submitFailed にならない");
      assert.equal(h.st.submitLocked, false, "ロックとして扱っている");
      assert.equal(h.st.result, null, "結果を表示している");
      assert.deepEqual(h.st.answers, [1, 2], "回答が消えた");
      assert.equal(h.st.submitting, false, "送信中のまま");
      h.render().submitQuiz();
      assert.equal(h.reqs.length, 3, "再送信できない");
    });
  }

  it("問題の読み込みが 200 で本文に reason: course_locked があっても、ロックにしない（問題として解釈できず takeFailed）", async () => {
    const h = takeHarness(true);
    h.render().openQuiz("quiz1");
    h.reqs[0].release(res({ status: 200, ok: true, body: { error: "Forbidden", reason: "course_locked" } }));
    await settle();
    assert.equal(h.st.takeLocked, false, "200 をロックとして扱っている");
    assert.equal(h.st.takeFailed, true, "takeFailed にならない");
  });

  it("問題の読み込みが 403 course_locked でも、/login へのリダイレクトなら失効として扱いロックにしない", async () => {
    const h = takeHarness(true);
    h.render().openQuiz("quiz1");
    h.reqs[0].release(res({ ...LOCKED_403, redirected: true }, `${ORIGIN}/login`));
    await settle();
    assert.equal(h.st.takeLocked, false, "リダイレクトをロックとして扱っている");
    assert.equal(h.st.takeFailed, false, "失効を失敗として扱っている");
    assert.equal(h.st.reloads, 0, "失効なのに一覧を読み直した");
  });

  it("別のクイズを開き直したあとに届いた、前のクイズの 403 course_locked は捨てる（新しいクイズの表示は変えない）", async () => {
    const h = takeHarness(true);
    h.render().openQuiz("quizA");
    h.render().openQuiz(QUIZ.id);
    h.reqs[1].release(res({ body: QUIZ }, `${ORIGIN}/api/quizzes/quiz%2F1`));
    await settle();
    h.reqs[0].release(res(LOCKED_403));
    await settle();
    assert.equal(h.st.takeLocked, false, "前のクイズの応答でロック表示になった");
    assert.equal(h.st.takeQuiz?.id, QUIZ.id, "新しいクイズの問題が消えた");
    assert.equal(h.st.takeLoading, false, "読み込み中に戻った");
    assert.equal(h.st.reloads, 0, "捨てた応答で一覧を読み直した");
  });

  it("前のクイズの 403 course_locked が、新しいクイズの読み込み中に届いても、読み込み中のまま（ロックにしない）", async () => {
    const h = takeHarness(true);
    h.render().openQuiz("quizA");
    h.render().openQuiz(QUIZ.id);
    h.reqs[0].release(res(LOCKED_403));
    await settle();
    assert.equal(h.st.takeLocked, false, "前のクイズの応答でロック表示になった");
    assert.equal(h.st.takeLoading, true, "新しいクイズの読み込みが終わったことになった");
  });

  it("送信中は一覧に戻れず、届いた 403 course_locked は submitLocked になる", async () => {
    const h = await openLoaded();
    answerAll(h, [0, 0]);
    h.render().submitQuiz();
    h.render().closeQuiz();
    assert.equal(h.st.activeQuizId, QUIZ.id, "送信中に一覧に戻った");
    h.reqs[1].release(res(LOCKED_403, `${ORIGIN}/api/quizzes/quiz%2F1/submit`));
    await settle();
    assert.equal(h.st.submitLocked, true, "submitLocked にならない");
  });

  it("送信の 403 course_locked のあと、一覧に戻って開き直すと submitLocked も takeLocked も消え、送信できる", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res(LOCKED_403, `${ORIGIN}/api/quizzes/quiz%2F1/submit`));
    await settle();
    h.render().closeQuiz();
    h.render().openQuiz(QUIZ.id);
    assert.equal(h.st.submitLocked, false, "開き直しても submitLocked が残る");
    assert.equal(h.st.takeLocked, false, "開き直しても takeLocked が残る");
    h.reqs[2].release(res({ body: QUIZ }, `${ORIGIN}/api/quizzes/quiz%2F1`));
    await settle();
    answerAll(h, [0, 0]);
    h.render().submitQuiz();
    assert.equal(h.reqs.length, 4, "開き直したあと送信できない");
  });

  it("送信が 403 course_locked のとき、本文は 1 回だけ読む", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    let reads = 0;
    h.reqs[1].release(res({ status: 403, ok: false, json: () => { reads++; return Promise.resolve(LOCKED_403.body); } }));
    await settle();
    assert.equal(reads, 1, `本文を ${reads} 回読んだ`);
    assert.equal(h.st.submitLocked, true, "submitLocked にならない");
  });

  it("送信ボタンは submitLocked の間 disabled（ソース）", () => {
    assert.match(quizPage, /disabled=\{!submitBody \|\| submitting \|\| submitLocked\}/);
  });
});

// ───────────── 実行：受験の公開前の修正（#51） ─────────────

const SUBMIT_URL = `${ORIGIN}/api/quizzes/quiz%2F1/submit`;
const RATE_LIMITED = { status: 429, ok: false, body: { error: "Too many requests", reason: "rate_limited", retryAfterSeconds: 1800 } };
const CHANGED = { status: 409, ok: false, body: { error: "Conflict", reason: "quiz_changed" } };
const QUIZ_V2 = {
  ...QUIZ,
  questionCount: 3,
  questions: [...QUIZ.questions, { id: "q3", question: "問3", options: ["f", "g"] }],
  // 読み直すと新しいトークン（新しい並び）になる
  attemptToken: `v1.${"C".repeat(22)}.${"D".repeat(43)}`,
};

describe("受験：429（間隔・回数の上限。#51）", () => {
  it("回答を残して submitFailed、submitRateLimited に retryAfterSeconds。一覧は読み直さず、自動で再送しない", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res(RATE_LIMITED, SUBMIT_URL));
    await settle();
    assert.equal(h.st.submitFailed, true, "submitFailed にならない");
    assert.deepEqual(h.st.submitRateLimited, { retryAfterSeconds: 1800 });
    assert.deepEqual(h.st.answers, [1, 2], "回答が消えた");
    assert.equal(h.st.result, null);
    assert.equal(h.st.submitting, false);
    assert.equal(h.st.reloads, 0, "一覧を読み直した");
    await settle();
    assert.equal(h.reqs.length, 2, "自動で再送した");
  });

  it("もう一度送信すると submitRateLimited を消し、同じ回答で送る", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res(RATE_LIMITED, SUBMIT_URL));
    await settle();
    h.render().submitQuiz();
    assert.equal(h.st.submitRateLimited, null, "再送しても 429 の印が残る");
    assert.deepEqual(JSON.parse(String(h.reqs[2].init?.body)), { answers: [1, 2], questionIds: ["q1", "q2"], attemptToken: QUIZ.attemptToken });
  });

  it("retryAfterSeconds のない 429 も上限として扱う（目安は null）", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res({ status: 429, ok: false, body: null }, SUBMIT_URL));
    await settle();
    assert.deepEqual(h.st.submitRateLimited, { retryAfterSeconds: null });
  });

  it("500 のあとは submitRateLimited を付けない（通常の送信失敗）", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res({ status: 500, ok: false, body: { error: "Internal server error" } }, SUBMIT_URL));
    await settle();
    assert.equal(h.st.submitFailed, true);
    assert.equal(h.st.submitRateLimited, null);
  });

  it("もう一度受ける・一覧に戻ると submitRateLimited を消す", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res(RATE_LIMITED, SUBMIT_URL));
    await settle();
    h.render().retakeQuiz();
    assert.equal(h.st.submitRateLimited, null, "もう一度受けても残る");
    h.st.submitRateLimited = { retryAfterSeconds: 1 };
    h.render().closeQuiz();
    assert.equal(h.st.submitRateLimited, null, "一覧に戻っても残る");
  });
});

describe("受験：409 quiz_changed（問題の入れ替え。#51）", () => {
  it("回答を消して同じクイズを読み直し、成功したら takeChanged（新しい問題と未回答の配列）", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res(CHANGED, SUBMIT_URL));
    await settle();
    assert.equal(h.reqs.length, 3, "読み直していない");
    assert.equal(h.reqs[2].url, "/api/quizzes/quiz%2F1");
    assert.equal(h.reqs[2].init, undefined);
    assert.deepEqual(h.st.answers, [], "回答が残っている");
    assert.equal(h.st.takeLoading, true);
    assert.equal(h.st.takeChanged, false, "読み直しの成功前に知らせた");
    assert.equal(h.st.submitFailed, false, "送信失敗として扱っている");
    h.reqs[2].release(res({ body: QUIZ_V2 }, `${ORIGIN}/api/quizzes/quiz%2F1`));
    await settle();
    assert.equal(h.st.takeChanged, true, "読み直しの成功を知らせていない");
    assert.equal(h.st.takeQuiz?.questions.length, 3);
    assert.deepEqual(h.st.answers, [null, null, null]);
    assert.equal(h.st.currentQ, 0);
    assert.equal(h.st.submitting, false);
    assert.equal(h.st.submitInFlight, false);
  });

  it("読み直しに失敗したら takeFailed で、takeChanged は出さない", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res(CHANGED, SUBMIT_URL));
    await settle();
    h.reqs[2].release(res({ status: 500, ok: false, body: { error: "Internal server error" } }));
    await settle();
    assert.equal(h.st.takeFailed, true);
    assert.equal(h.st.takeChanged, false, "失敗したのに読み込みましたと知らせる");
  });

  it("読み直しのあと、新しい問題の並びで送る", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res(CHANGED, SUBMIT_URL));
    await settle();
    h.reqs[2].release(res({ body: QUIZ_V2 }));
    await settle();
    answerAll(h, [0, 1, 1]);
    h.render().submitQuiz();
    assert.deepEqual(JSON.parse(String(h.reqs[3].init?.body)), { answers: [0, 1, 1], questionIds: ["q1", "q2", "q3"], attemptToken: QUIZ_V2.attemptToken });
    assert.equal(h.st.takeChanged, false, "送信しても知らせが残る");
  });

  it("読み直しの前に届いていた古い問題の応答は捨てる（読み直しの応答だけを使う）", async () => {
    const h = takeHarness(true);
    h.render().openQuiz(QUIZ.id); // reqs[0]：古い読み込み（まだ届いていない）
    h.render().openQuiz(QUIZ.id); // reqs[1]
    h.reqs[1].release(res({ body: QUIZ }));
    await settle();
    answerAll(h, [1, 2]);
    h.render().submitQuiz(); // reqs[2]
    h.reqs[2].release(res(CHANGED, SUBMIT_URL));
    await settle();
    h.reqs[0].release(res({ body: QUIZ })); // 古い 2 問の応答
    await settle();
    assert.equal(h.st.takeQuiz, null, "古い応答を使った");
    h.reqs[3].release(res({ body: QUIZ_V2 }));
    await settle();
    assert.equal(h.st.takeQuiz?.questions.length, 3);
    assert.equal(h.st.takeChanged, true);
  });

  it("409 quiz_unavailable は quiz_changed にせず、これまでどおり submitFailed", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res({ status: 409, ok: false, body: { error: "Quiz unavailable", reason: "quiz_unavailable" } }, SUBMIT_URL));
    await settle();
    assert.equal(h.st.submitFailed, true);
    assert.equal(h.reqs.length, 2, "読み直した");
    assert.deepEqual(h.st.answers, [1, 2]);
  });

  it("QUIZ_CHANGED_MESSAGE は空でない", () => {
    assert.ok(QUIZ_CHANGED_MESSAGE.length > 0, "文言が空");
  });
});

describe("受験：再送の重複（200 duplicate: true。#51）", () => {
  it("結果を通常どおり表示し（duplicate: true を持つ）、一覧も読み直す", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res({ body: { ...RESULT, duplicate: true } }, SUBMIT_URL));
    await settle();
    assert.deepEqual(h.st.result, { ...RESULT, duplicate: true });
    assert.equal(h.st.reloads, 1, "一覧を読み直していない");
    assert.equal(h.st.submitFailed, false);
  });
});

describe("受験：GET の retryAfterSeconds（事前の案内。#51）", () => {
  it("問題の読み込みで retryAfterSeconds があれば takeRetryAfter に入れ、回答は始められる", async () => {
    const h = takeHarness(true);
    h.render().openQuiz(QUIZ.id);
    h.reqs[0].release(res({ body: { ...QUIZ, retryAfterSeconds: 600 } }));
    await settle();
    assert.equal(h.st.takeRetryAfter, 600);
    assert.deepEqual(h.st.answers, [null, null]);
    answerAll(h, [0, 0]);
    h.render().submitQuiz();
    assert.equal(h.reqs.length, 2, "送信できない");
    assert.equal(h.st.takeRetryAfter, null, "送信してもサーバーの前の案内が残る");
  });

  it("retryAfterSeconds が null・壊れていれば takeRetryAfter は null", async () => {
    for (const v of [null, "600", -1]) {
      const h = takeHarness(true);
      h.render().openQuiz(QUIZ.id);
      h.reqs[0].release(res({ body: { ...QUIZ, retryAfterSeconds: v } }));
      await settle();
      assert.equal(h.st.takeRetryAfter, null, `${String(v)} で案内を出す`);
    }
  });

  it("一覧に戻ると takeRetryAfter・takeChanged を消す", async () => {
    const h = takeHarness(true);
    h.render().openQuiz(QUIZ.id);
    h.reqs[0].release(res({ body: { ...QUIZ, retryAfterSeconds: 600 } }));
    await settle();
    h.st.takeChanged = true;
    h.render().closeQuiz();
    assert.equal(h.st.takeRetryAfter, null);
    assert.equal(h.st.takeChanged, false);
  });
});

// ───────────── テスト担当の追加（#51） ─────────────

describe("受験：古い送信の応答（#51 追加）", () => {
  /** 送信中に別のクイズを開いた（takeSeq が進んだ）状態を作る。画面では送信中は戻れないが、関数の守りを確かめる */
  async function submitThenReopen() {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz(); // reqs[1]
    h.render().openQuiz("other"); // reqs[2]
    return h;
  }

  it("古い 409 quiz_changed では読み直さず、takeChanged も出さない", async () => {
    const h = await submitThenReopen();
    h.reqs[1].release(res(CHANGED, SUBMIT_URL));
    await settle();
    assert.equal(h.reqs.length, 3, "古い応答で読み直した");
    assert.equal(h.st.activeQuizId, "other", "開いているクイズが変わった");
    assert.equal(h.st.takeChanged, false, "古い応答で更新を知らせた");
    assert.equal(h.st.submitInFlight, false, "送信中の印が残った");
  });

  it("古い 429 では submitRateLimited・submitFailed を付けない", async () => {
    const h = await submitThenReopen();
    h.reqs[1].release(res(RATE_LIMITED, SUBMIT_URL));
    await settle();
    assert.equal(h.st.submitRateLimited, null, "古い 429 を表示に使った");
    assert.equal(h.st.submitFailed, false, "古い 429 で送信失敗にした");
  });

  it("古い duplicate の結果は表示しないが、一覧は読み直す", async () => {
    const h = await submitThenReopen();
    h.reqs[1].release(res({ body: { ...RESULT, duplicate: true } }, SUBMIT_URL));
    await settle();
    assert.equal(h.st.result, null, "古い結果を表示した");
    assert.equal(h.st.reloads, 1, "一覧を読み直していない");
  });
});

describe("受験：409 quiz_changed の読み直しの結果（#51 追加）", () => {
  async function changed() {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res(CHANGED, SUBMIT_URL));
    await settle();
    assert.equal(h.reqs.length, 3, "読み直していない");
    return h;
  }

  it("読み直しが 403 course_locked なら takeLocked で、更新の知らせは出さない", async () => {
    const h = await changed();
    h.reqs[2].release(res({ status: 403, ok: false, body: { error: "Forbidden", reason: "course_locked" } }));
    await settle();
    assert.equal(h.st.takeLocked, true, "takeLocked にならない");
    assert.equal(h.st.takeChanged, false, "ロックなのに更新を知らせた");
    assert.equal(h.st.reloads, 1, "一覧を読み直していない");
  });

  it("読み直しが 401（失効）なら読み込み中のままで、更新の知らせは出さない", async () => {
    const h = await changed();
    h.reqs[2].release(res({ status: 401, ok: false, body: { error: "Unauthorized" } }));
    await settle();
    assert.equal(h.st.takeLoading, true, "読み込み中でなくなった");
    assert.equal(h.st.takeChanged, false, "失効なのに更新を知らせた");
    assert.equal(h.st.takeFailed, false, "失効を読み込み失敗にした");
  });

  it("読み直しの応答に retryAfterSeconds があれば、更新の知らせと事前の案内の両方を持つ", async () => {
    const h = await changed();
    h.reqs[2].release(res({ body: { ...QUIZ_V2, retryAfterSeconds: 600 } }));
    await settle();
    assert.equal(h.st.takeChanged, true, "更新を知らせていない");
    assert.equal(h.st.takeRetryAfter, 600, "事前の案内がない");
  });

  it("読み直しの最中に送信を押しても送らない（問題がまだない）", async () => {
    const h = await changed();
    h.render().submitQuiz();
    assert.equal(h.reqs.length, 3, "読み直しの最中に送信した");
  });
});

describe("受験：429 の追加の観点（#51 追加）", () => {
  it("429 の本文が読めなくても上限として扱う（目安は null）", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release({ status: 429, ok: false, redirected: false, url: SUBMIT_URL, json: () => Promise.reject(new SyntaxError("bad json")) });
    await settle();
    assert.deepEqual(h.st.submitRateLimited, { retryAfterSeconds: null });
    assert.equal(h.st.submitFailed, true, "submitFailed にならない");
    assert.deepEqual(h.st.answers, [1, 2], "回答が消えた");
  });

  it("/login へのリダイレクトは失効として扱い、429 の印を付けない（送信中のまま）", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res({ status: 200, redirected: true, body: null }, `${ORIGIN}/login?callbackUrl=%2F`));
    await settle();
    assert.equal(h.st.submitRateLimited, null, "失効に 429 の印を付けた");
    assert.equal(h.st.submitting, true, "送信中でなくなった");
  });

  it("送信中にもう一度押しても 1 回しか送らない（429 の応答待ち）", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.render().submitQuiz();
    assert.equal(h.reqs.length, 2, "二重に送信した");
    h.reqs[1].release(res(RATE_LIMITED, SUBMIT_URL));
    await settle();
    assert.equal(h.reqs.length, 2, "自動で再送した");
  });

  it("429 のあとに送り直して 403 course_locked なら、submitLocked で 429 の印は消える", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res(RATE_LIMITED, SUBMIT_URL));
    await settle();
    h.render().submitQuiz();
    h.reqs[2].release(res({ status: 403, ok: false, body: { error: "Forbidden", reason: "course_locked" } }, SUBMIT_URL));
    await settle();
    assert.equal(h.st.submitLocked, true, "submitLocked にならない");
    assert.equal(h.st.submitRateLimited, null, "429 の印が残った");
  });

  it("429 のあとに送り直して 200 なら結果を出し、429 の印は消える", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res(RATE_LIMITED, SUBMIT_URL));
    await settle();
    h.render().submitQuiz();
    h.reqs[2].release(res({ body: { ...RESULT, duplicate: false } }, SUBMIT_URL));
    await settle();
    assert.deepEqual(h.st.result, { ...RESULT, duplicate: false });
    assert.equal(h.st.submitRateLimited, null, "429 の印が残った");
  });
});

describe("QUIZ_ATTEMPTS_ENABLED が false（受験を止めたとき。#51 追加）", () => {
  it("事前の案内・更新の知らせ・429 の印はどれも付かない（取得・送信しない）", () => {
    const h = takeHarness(false);
    h.render().openQuiz("quiz1");
    h.st.takeQuiz = toQuizTakeView({ ...QUIZ, retryAfterSeconds: 600 });
    h.st.answers = [0, 0];
    h.render().submitQuiz();
    assert.equal(h.reqs.length, 0, "取得・送信した");
    assert.equal(h.st.takeRetryAfter, null);
    assert.equal(h.st.takeChanged, false);
    assert.equal(h.st.submitRateLimited, null);
  });
});

describe("受験：もう一度受ける（問題の読み直し。#51）", () => {
  async function retaken() {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.reqs[1].release(res({ body: RESULT }, SUBMIT_URL));
    await settle();
    h.render().retakeQuiz();
    assert.equal(h.reqs.length, 3, "GET が 1 回走っていない");
    return h;
  }

  it("GET の retryAfterSeconds があれば takeRetryAfter に入る（送信開始で消えた案内が戻る）", async () => {
    const h = await retaken();
    h.reqs[2].release(res({ body: { ...QUIZ, retryAfterSeconds: 45 } }));
    await settle();
    assert.equal(h.st.takeRetryAfter, 45);
    assert.equal(h.st.takeChanged, false, "問題の更新として知らせた");
  });

  it("retryAfterSeconds がなければ takeRetryAfter は null", async () => {
    const h = await retaken();
    h.reqs[2].release(res({ body: QUIZ }));
    await settle();
    assert.equal(h.st.takeRetryAfter, null);
  });

  it("読み直しに失敗したら takeFailed（結果は消える）", async () => {
    const h = await retaken();
    h.reqs[2].release(res({ status: 500, ok: false, body: { error: "Internal server error" } }));
    await settle();
    assert.equal(h.st.takeFailed, true);
    assert.equal(h.st.result, null);
    assert.equal(h.st.takeLoading, false);
  });

  it("読み直しが 403 course_locked なら takeLocked、失効なら読み込み中のまま（openQuiz と同じ）", async () => {
    const h = await retaken();
    h.reqs[2].release(res(LOCKED_403));
    await settle();
    assert.equal(h.st.takeLocked, true);
    const h2 = await retaken();
    h2.reqs[2].release(res({ status: 401, ok: false }));
    await settle();
    assert.equal(h2.st.takeLoading, true);
    assert.equal(h2.st.takeFailed, false);
  });

  it("読み込み中にもう一度押しても GET を増やさない（二重読み込みしない）", async () => {
    const h = await retaken();
    h.render().retakeQuiz();
    h.render().retakeQuiz();
    assert.equal(h.reqs.length, 3, "読み込み中に GET が増えた");
  });

  it("読み直しの前に一覧に戻ったら、届いた応答は捨てる", async () => {
    const h = await retaken();
    h.render().closeQuiz();
    h.reqs[2].release(res({ body: { ...QUIZ, retryAfterSeconds: 45 } }));
    await settle();
    assert.equal(h.st.takeQuiz, null, "閉じたあとの応答を使った");
    assert.equal(h.st.takeRetryAfter, null);
  });

  it("送信中は何もしない", async () => {
    const h = await openLoaded();
    answerAll(h, [1, 2]);
    h.render().submitQuiz();
    h.render().retakeQuiz();
    assert.equal(h.reqs.length, 2, "送信中に読み直した");
  });
});
