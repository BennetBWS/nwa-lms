import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PASSING_PERCENT,
  QUIZ_ATTEMPTS_ENABLED,
  buildQuizCourses,
  buildSubmitBody,
  hasAnswersArray,
  normalizeOptions,
  parseSubmitAnswers,
  quizResultTitle,
  quizStatus,
  quizStatusLabel,
  scoreAttempt,
  summarizeAttempts,
  toAnswerKey,
  toQuestionViews,
  toQuizCourseItems,
  toQuizResultView,
  toQuizTakeView,
  type AnswerKeyRow,
  type QuizAttemptInput,
  type QuizCourseInput,
  type QuizInput,
} from "./student-quizzes";

// #32 確認テストの純粋関数。DB・ネットワークなし。データはすべてダミー。

describe("定数", () => {
  it("受験はまだ公開しない（#8 のあと）", () => {
    assert.equal(QUIZ_ATTEMPTS_ENABLED, false);
  });
  it("合格の基準は 70%", () => {
    assert.equal(PASSING_PERCENT, 70);
  });
});

// ───────────── normalizeOptions ─────────────

describe("normalizeOptions", () => {
  it("文字列の配列（2 件以上）はそのまま（新しい配列）", () => {
    const src = ["a", "b", "c"];
    const out = normalizeOptions(src);
    assert.deepEqual(out, ["a", "b", "c"]);
    assert.notEqual(out, src);
  });
  it("空文字の選択肢も文字列として残す", () => {
    assert.deepEqual(normalizeOptions(["", "b"]), ["", "b"]);
  });
  for (const [label, v] of [
    ["null", null],
    ["undefined", undefined],
    ["文字列", "a,b"],
    ["オブジェクト", { 0: "a", 1: "b" }],
    ["空配列", []],
    ["1 件", ["a"]],
    ["数値が混ざる", ["a", 1]],
    ["null が混ざる", ["a", null]],
    ["入れ子の配列", ["a", ["b"]]],
    ["オブジェクトが混ざる", ["a", { text: "b" }]],
  ] as Array<[string, unknown]>) {
    it(`${label} は null`, () => {
      assert.equal(normalizeOptions(v), null);
    });
  }
});

describe("toQuestionViews", () => {
  it("id・question・options だけを返し、並びは受け取った順", () => {
    const rows = [
      { id: "q2", question: "問2", options: ["x", "y"], correctIndex: 1 },
      { id: "q1", question: "問1", options: ["a", "b", "c"], correctIndex: 0 },
    ];
    const out = toQuestionViews(rows);
    assert.deepEqual(out, [
      { id: "q2", question: "問2", options: ["x", "y"] },
      { id: "q1", question: "問1", options: ["a", "b", "c"] },
    ]);
    assert.doesNotMatch(JSON.stringify(out), /correctIndex/);
  });
  it("0 件は null", () => {
    assert.equal(toQuestionViews([]), null);
  });
  it("1 問でも options が壊れていれば null", () => {
    assert.equal(toQuestionViews([{ id: "q1", question: "問1", options: ["a", "b"] }, { id: "q2", question: "問2", options: ["a"] }]), null);
  });
});

describe("toAnswerKey", () => {
  it("選択肢数と正解の位置を並びのまま返す", () => {
    assert.deepEqual(
      toAnswerKey([
        { options: ["a", "b", "c"], correctIndex: 2 },
        { options: ["a", "b"], correctIndex: 0 },
      ]),
      { optionCounts: [3, 2], correctIndexes: [2, 0] }
    );
  });
  it("0 件・options が壊れている・correctIndex が範囲外や整数でないなら null", () => {
    assert.equal(toAnswerKey([]), null);
    assert.equal(toAnswerKey([{ options: "ab", correctIndex: 0 }]), null);
    assert.equal(toAnswerKey([{ options: ["a", "b"], correctIndex: 2 }]), null);
    assert.equal(toAnswerKey([{ options: ["a", "b"], correctIndex: -1 }]), null);
    assert.equal(toAnswerKey([{ options: ["a", "b"], correctIndex: 0.5 }]), null);
  });
});

// ───────────── parseSubmitAnswers ─────────────

describe("parseSubmitAnswers", () => {
  const counts = [4, 2, 3];

  it("長さが問題数と同じで、各要素が範囲内の整数なら ok（新しい配列）", () => {
    const answers = [3, 0, 2];
    const r = parseSubmitAnswers({ answers }, counts);
    assert.ok("value" in r);
    assert.deepEqual(r.value, [3, 0, 2]);
    assert.notEqual(r.value, answers);
  });

  it("body の userId などほかの項目は value に入らない", () => {
    const r = parseSubmitAnswers({ answers: [0, 0, 0], userId: "someone_else", score: 100 }, counts);
    assert.ok("value" in r);
    assert.deepEqual(r.value, [0, 0, 0]);
  });

  it("1 問だけでも動く", () => {
    const r = parseSubmitAnswers({ answers: [1] }, [2]);
    assert.ok("value" in r);
    assert.deepEqual(r.value, [1]);
  });

  for (const [label, body] of [
    ["body が null", null],
    ["body が配列", [[0, 0, 0]]],
    ["body が文字列", "[0,0,0]"],
    ["answers なし", {}],
    ["answers が文字列", { answers: "0,0,0" }],
    ["answers がオブジェクト", { answers: { 0: 0, 1: 0, 2: 0 } }],
    ["短い", { answers: [0, 0] }],
    ["長い", { answers: [0, 0, 0, 0] }],
    ["空", { answers: [] }],
    ["巨大な配列", { answers: new Array(100_000).fill(0) }],
    ["範囲外（選択肢数ちょうど）", { answers: [4, 0, 0] }],
    ["範囲外（2 問目は 2 択）", { answers: [0, 2, 0] }],
    ["負の数", { answers: [0, -1, 0] }],
    ["小数", { answers: [0, 0.5, 0] }],
    ["文字列の数字", { answers: [0, "1", 0] }],
    ["null", { answers: [0, null, 0] }],
    ["NaN", { answers: [0, Number.NaN, 0] }],
    ["Infinity", { answers: [0, Number.POSITIVE_INFINITY, 0] }],
    ["true", { answers: [0, true, 0] }],
    ["穴あき配列", { answers: [0, , 0] }],
  ] as Array<[string, unknown]>) {
    it(`${label} は invalid_answers`, () => {
      assert.deepEqual(parseSubmitAnswers(body, counts), { ok: false, reason: "invalid_answers" });
    });
  }

  it("問題数 0 は常に失敗", () => {
    assert.deepEqual(parseSubmitAnswers({ answers: [] }, []), { ok: false, reason: "invalid_answers" });
  });
});

describe("hasAnswersArray", () => {
  it("{ answers: 配列 } だけ true", () => {
    assert.equal(hasAnswersArray({ answers: [] }), true);
    assert.equal(hasAnswersArray({ answers: "x" }), false);
    assert.equal(hasAnswersArray([]), false);
    assert.equal(hasAnswersArray(null), false);
  });
});

// ───────────── scoreAttempt ─────────────

describe("scoreAttempt", () => {
  it("正解数・点数（四捨五入）・問題ごとの正誤", () => {
    assert.deepEqual(scoreAttempt([0, 1, 2], [0, 0, 2]), {
      correct: 2,
      total: 3,
      score: 67,
      passed: false,
      results: [true, false, true],
    });
  });

  it("70% ちょうど（7/10）は合格", () => {
    const r = scoreAttempt([0, 0, 0, 0, 0, 0, 0, 1, 1, 1], new Array(10).fill(0));
    assert.equal(r.score, 70);
    assert.equal(r.passed, true);
  });

  it("四捨五入で 70 になっても、元の正解率が 70% 未満なら不合格（139/200 = 69.5%）", () => {
    const correctIndexes = new Array(200).fill(0);
    const answers = correctIndexes.map((_, i) => (i < 139 ? 0 : 1));
    const r = scoreAttempt(answers, correctIndexes);
    assert.equal(r.score, 70);
    assert.equal(r.passed, false);
  });

  it("2/3（66.7%）は不合格、3/4（75%）は合格", () => {
    assert.equal(scoreAttempt([0, 0, 1], [0, 0, 0]).passed, false);
    assert.equal(scoreAttempt([0, 0, 0, 1], [0, 0, 0, 0]).passed, true);
  });

  it("1 問：正解なら 100 点で合格、不正解なら 0 点で不合格", () => {
    assert.deepEqual(scoreAttempt([1], [1]), { correct: 1, total: 1, score: 100, passed: true, results: [true] });
    assert.deepEqual(scoreAttempt([0], [1]), { correct: 0, total: 1, score: 0, passed: false, results: [false] });
  });

  it("問題 0 件は 0 点で不合格", () => {
    assert.deepEqual(scoreAttempt([], []), { correct: 0, total: 0, score: 0, passed: false, results: [] });
  });
});

// ───────────── summarizeAttempts ─────────────

describe("summarizeAttempts", () => {
  const d = (s: string) => new Date(s);

  it("未受験は 0 回・null", () => {
    assert.deepEqual(summarizeAttempts([]), { attemptCount: 0, bestScore: null, passed: null, lastAttemptAt: null });
  });

  it("回数・最高点・最後の日時。1 回でも合格なら passed", () => {
    assert.deepEqual(
      summarizeAttempts([
        { score: 60, passed: false, createdAt: d("2026-10-01T00:00:00.000Z") },
        { score: 80, passed: true, createdAt: d("2026-10-02T00:00:00.000Z") },
        { score: 40, passed: false, createdAt: d("2026-10-03T00:00:00.000Z") },
      ]),
      { attemptCount: 3, bestScore: 80, passed: true, lastAttemptAt: "2026-10-03T00:00:00.000Z" }
    );
  });

  it("合否は記録の passed を使う（点数 70 でも passed が false なら不合格のまま）", () => {
    const s = summarizeAttempts([{ score: 70, passed: false, createdAt: d("2026-10-01T00:00:00.000Z") }]);
    assert.equal(s.passed, false);
    assert.equal(s.bestScore, 70);
  });
});

// ───────────── buildQuizCourses ─────────────

function course(id: string, order: number, lessonIds: string[]): QuizCourseInput {
  return { id, name: `コース${id}`, order, icon: "html", color: "#000000", sections: [{ lessons: lessonIds.map((x) => ({ id: x })) }] };
}

/** 受験できる問題（2 択・正解は 0）を n 件 */
function validQuestions(n: number): AnswerKeyRow[] {
  return Array.from({ length: n }, () => ({ options: ["x", "y"], correctIndex: 0 }));
}

function finalQuiz(id: string, courseId: string | null, questionCount = 3, title = `修了${id}`): QuizInput {
  return { id, title, type: "FINAL", courseId, lessonId: null, lesson: null, questions: validQuestions(questionCount) };
}

function miniQuiz(
  id: string,
  lesson: { id: string; order: number; section: { id: string; order: number; courseId: string } } | null,
  questionCount = 2,
  title = `ミニ${id}`
): QuizInput {
  return {
    id,
    title,
    type: "MINI",
    courseId: null,
    lessonId: lesson?.id ?? null,
    lesson: lesson ? { ...lesson, title: `レッスン${lesson.id}` } : null,
    questions: validQuestions(questionCount),
  };
}

const NONE = new Set<string>();

describe("buildQuizCourses：振り分け", () => {
  it("修了テストは quiz.courseId、ミニテストは lesson.section.courseId のコースへ", () => {
    const out = buildQuizCourses(
      [course("c1", 1, ["l1"]), course("c2", 2, ["l2"])],
      NONE,
      [
        finalQuiz("f2", "c2"),
        // MINI に courseId があっても使わない
        { ...miniQuiz("m1", { id: "l1", order: 1, section: { id: "s1", order: 1, courseId: "c1" } }), courseId: "c2" },
        finalQuiz("f1", "c1"),
      ],
      []
    );
    assert.deepEqual(
      out.map((c) => [c.id, c.finalQuizzes.map((q) => q.id), c.miniQuizzes.map((q) => q.id)]),
      [
        ["c1", ["f1"], ["m1"]],
        ["c2", ["f2"], []],
      ]
    );
  });

  it("FINAL に lesson があっても lessonId / lessonTitle は null、MINI はレッスンの id とタイトル", () => {
    const out = buildQuizCourses(
      [course("c1", 1, ["l1"])],
      NONE,
      [
        { ...finalQuiz("f1", "c1"), lessonId: "l1", lesson: { id: "l1", title: "レッスンl1", order: 1, section: { id: "s1", order: 1, courseId: "c1" } } },
        miniQuiz("m1", { id: "l1", order: 1, section: { id: "s1", order: 1, courseId: "c1" } }),
      ],
      []
    );
    assert.equal(out[0].finalQuizzes[0].lessonId, null);
    assert.equal(out[0].finalQuizzes[0].lessonTitle, null);
    assert.equal(out[0].miniQuizzes[0].lessonId, "l1");
    assert.equal(out[0].miniQuizzes[0].lessonTitle, "レッスンl1");
  });

  it("問題 0 件のクイズ、コースに属さないクイズ（courseId なし・存在しないコース・レッスンなしの MINI）は除く", () => {
    const out = buildQuizCourses(
      [course("c1", 1, ["l1"])],
      NONE,
      [
        finalQuiz("empty", "c1", 0),
        finalQuiz("orphan", null),
        finalQuiz("ghost", "c_missing"),
        miniQuiz("nolesson", null),
        miniQuiz("ghostmini", { id: "lx", order: 1, section: { id: "sx", order: 1, courseId: "c_missing" } }),
        finalQuiz("ok", "c1"),
      ],
      []
    );
    assert.deepEqual(out.map((c) => c.finalQuizzes.map((q) => q.id)), [["ok"]]);
    assert.deepEqual(out[0].miniQuizzes, []);
  });

  it("受験できない問題（options が壊れている・correctIndex が範囲外）を 1 つでも含むクイズは除く", () => {
    const withQuestions = (q: QuizInput, questions: AnswerKeyRow[]): QuizInput => ({ ...q, questions });
    const mini = miniQuiz("m_ok", { id: "l1", order: 1, section: { id: "s1", order: 1, courseId: "c1" } });
    const out = buildQuizCourses(
      [course("c1", 1, ["l1"])],
      NONE,
      [
        withQuestions(finalQuiz("one_option", "c1"), [...validQuestions(2), { options: ["only"], correctIndex: 0 }]),
        withQuestions(finalQuiz("not_array", "c1"), [{ options: "x,y", correctIndex: 0 }]),
        withQuestions(finalQuiz("non_string", "c1"), [{ options: ["x", 1], correctIndex: 0 }]),
        withQuestions(finalQuiz("null_options", "c1"), [{ options: null, correctIndex: 0 }]),
        withQuestions(finalQuiz("key_too_big", "c1"), [{ options: ["x", "y"], correctIndex: 2 }, ...validQuestions(1)]),
        withQuestions(finalQuiz("key_negative", "c1"), [{ options: ["x", "y"], correctIndex: -1 }]),
        withQuestions({ ...mini, id: "m_broken" }, [{ options: ["x"], correctIndex: 0 }]),
        mini,
        finalQuiz("ok", "c1"),
      ],
      []
    );
    assert.deepEqual(out.map((c) => [c.finalQuizzes.map((q) => q.id), c.miniQuizzes.map((q) => q.id)]), [[["ok"], ["m_ok"]]]);
  });

  it("壊れたクイズしかないコースは返さない。壊れたクイズの受験記録は数えない", () => {
    const broken: QuizInput = { ...finalQuiz("broken", "c1"), questions: [{ options: ["only"], correctIndex: 0 }] };
    assert.deepEqual(buildQuizCourses([course("c1", 1, [])], NONE, [broken], [{ quizId: "broken", score: 100, passed: true, createdAt: new Date("2026-10-01T00:00:00.000Z") }]), []);
  });

  it("questionCount は問題の件数で、応答に選択肢・正解は出さない", () => {
    const out = buildQuizCourses([course("c1", 1, [])], NONE, [finalQuiz("f1", "c1", 4)], []);
    assert.equal(out[0].finalQuizzes[0].questionCount, 4);
    assert.doesNotMatch(JSON.stringify(out), /correctIndex|options|questions"/);
  });

  it("クイズのないコースは返さない。全部なければ空配列", () => {
    assert.deepEqual(buildQuizCourses([course("c1", 1, ["l1"])], NONE, [], []), []);
    assert.deepEqual(buildQuizCourses([course("c1", 1, ["l1"])], NONE, [finalQuiz("empty", "c1", 0)], []), []);
    const out = buildQuizCourses([course("c1", 1, []), course("c2", 2, [])], NONE, [finalQuiz("f2", "c2")], []);
    assert.deepEqual(out.map((c) => c.id), ["c2"]);
  });

  it("コースの並びは受け取った順で、応答の項目は id / name / order / icon / color / locked / finalQuizzes / miniQuizzes", () => {
    const out = buildQuizCourses([course("b", 2, []), course("a", 1, [])], NONE, [finalQuiz("fa", "a"), finalQuiz("fb", "b")], []);
    assert.deepEqual(out.map((c) => c.id), ["b", "a"]);
    assert.deepEqual(Object.keys(out[0]).sort(), ["color", "finalQuizzes", "icon", "id", "locked", "miniQuizzes", "name", "order"]);
    assert.deepEqual(Object.keys(out[0].finalQuizzes[0]).sort(), [
      "attemptCount",
      "bestScore",
      "id",
      "lastAttemptAt",
      "lessonId",
      "lessonTitle",
      "passed",
      "questionCount",
      "title",
      "type",
    ]);
  });
});

describe("buildQuizCourses：並び順", () => {
  it("ミニテストはセクション順 → レッスン順（同じなら id）→ タイトル・id", () => {
    const s1 = { id: "s1", order: 1, courseId: "c1" };
    const s2 = { id: "s2", order: 2, courseId: "c1" };
    const out = buildQuizCourses(
      [course("c1", 1, [])],
      NONE,
      [
        miniQuiz("m_s2_l1", { id: "l9", order: 1, section: s2 }),
        miniQuiz("m_s1_l2", { id: "l2", order: 2, section: s1 }),
        miniQuiz("m_s1_l1b", { id: "l1b", order: 1, section: s1 }),
        miniQuiz("m_s1_l1a", { id: "l1a", order: 1, section: s1 }),
        miniQuiz("m_same_z", { id: "l2", order: 2, section: s1 }, 2, "Z"),
        miniQuiz("m_same_a", { id: "l2", order: 2, section: s1 }, 2, "A"),
      ],
      []
    );
    assert.deepEqual(out[0].miniQuizzes.map((q) => q.id), ["m_s1_l1a", "m_s1_l1b", "m_same_a", "m_same_z", "m_s1_l2", "m_s2_l1"]);
  });

  it("同じ order のセクションは id 順", () => {
    const out = buildQuizCourses(
      [course("c1", 1, [])],
      NONE,
      [
        miniQuiz("mb", { id: "l1", order: 1, section: { id: "sb", order: 1, courseId: "c1" } }),
        miniQuiz("ma", { id: "l2", order: 1, section: { id: "sa", order: 1, courseId: "c1" } }),
      ],
      []
    );
    assert.deepEqual(out[0].miniQuizzes.map((q) => q.id), ["ma", "mb"]);
  });

  it("修了テストはタイトル順、同じなら id 順", () => {
    const out = buildQuizCourses(
      [course("c1", 1, [])],
      NONE,
      [finalQuiz("f3", "c1", 3, "B"), finalQuiz("f2", "c1", 3, "A"), finalQuiz("f1", "c1", 3, "B")],
      []
    );
    assert.deepEqual(out[0].finalQuizzes.map((q) => q.id), ["f2", "f1", "f3"]);
  });
});

describe("buildQuizCourses：ロック（course-lock と同じ規則）", () => {
  const courses = [course("c1", 1, ["a1", "a2"]), course("c2", 2, ["b1"]), course("c3", 3, ["x1"]), course("c4", 4, ["d1"])];
  const quizzes = [finalQuiz("f1", "c1"), finalQuiz("f2", "c2"), finalQuiz("f4", "c4")];

  it("何も完了していなければ最初のコースだけ開く", () => {
    const out = buildQuizCourses(courses, NONE, quizzes, []);
    assert.deepEqual(out.map((c) => [c.id, c.locked]), [["c1", false], ["c2", true], ["c4", true]]);
  });

  it("前のコースを全部終えれば開く。クイズのないコース（c3）も前のコースとして数える", () => {
    const out = buildQuizCourses(courses, new Set(["a1", "a2", "b1"]), quizzes, []);
    // c3 は未完了なので c4 はロック
    assert.deepEqual(out.map((c) => [c.id, c.locked]), [["c1", false], ["c2", false], ["c4", true]]);
    const done = buildQuizCourses(courses, new Set(["a1", "a2", "b1", "x1"]), quizzes, []);
    assert.deepEqual(done.map((c) => [c.id, c.locked]), [["c1", false], ["c2", false], ["c4", false]]);
  });

  it("前のコースが途中でも、自分のコースに 1 件でも完了があれば開く", () => {
    const out = buildQuizCourses(courses, new Set(["a1", "b1"]), quizzes, []);
    assert.equal(out.find((c) => c.id === "c2")?.locked, false);
  });

  it("前のコースにレッスンがない場合はロック", () => {
    const out = buildQuizCourses([course("c1", 1, []), course("c2", 2, ["b1"])], NONE, [finalQuiz("f2", "c2")], []);
    assert.equal(out[0].locked, true);
  });
});

describe("buildQuizCourses：受験記録", () => {
  const at = (s: string) => new Date(s);
  const attempt = (quizId: string, score: number, passed: boolean, iso: string): QuizAttemptInput => ({ quizId, score, passed, createdAt: at(iso) });

  it("クイズごとに回数・最高点・合否・最後の日時。未受験は 0 / null", () => {
    const out = buildQuizCourses(
      [course("c1", 1, [])],
      NONE,
      [finalQuiz("f1", "c1"), finalQuiz("f2", "c1")],
      [attempt("f1", 50, false, "2026-10-01T00:00:00.000Z"), attempt("f1", 90, true, "2026-10-02T00:00:00.000Z")]
    );
    const [f1, f2] = out[0].finalQuizzes;
    assert.deepEqual(
      { attemptCount: f1.attemptCount, bestScore: f1.bestScore, passed: f1.passed, lastAttemptAt: f1.lastAttemptAt },
      { attemptCount: 2, bestScore: 90, passed: true, lastAttemptAt: "2026-10-02T00:00:00.000Z" }
    );
    assert.deepEqual(
      { attemptCount: f2.attemptCount, bestScore: f2.bestScore, passed: f2.passed, lastAttemptAt: f2.lastAttemptAt },
      { attemptCount: 0, bestScore: null, passed: null, lastAttemptAt: null }
    );
  });

  it("前提：渡された受験記録はすべて数える（他人の記録を除くのは route の where userId）", () => {
    // attempts に userId はない。route が自分の分だけを読むので、ここに他人の記録が来ないことが前提
    const out = buildQuizCourses([course("c1", 1, [])], NONE, [finalQuiz("f1", "c1")], [
      attempt("f1", 10, false, "2026-10-01T00:00:00.000Z"),
      attempt("f1", 20, false, "2026-10-01T00:00:00.000Z"),
    ]);
    assert.equal(out[0].finalQuizzes[0].attemptCount, 2);
  });

  it("除いたクイズ・存在しないクイズの受験記録は数に入らない", () => {
    const out = buildQuizCourses([course("c1", 1, [])], NONE, [finalQuiz("f1", "c1"), finalQuiz("empty", "c1", 0)], [
      attempt("empty", 100, true, "2026-10-01T00:00:00.000Z"),
      attempt("unknown", 100, true, "2026-10-01T00:00:00.000Z"),
    ]);
    assert.deepEqual(out[0].finalQuizzes.map((q) => [q.id, q.attemptCount]), [["f1", 0]]);
  });
});

// ───────────── 画面側 ─────────────

describe("quizStatus / quizStatusLabel", () => {
  it("合格／不合格／未受験", () => {
    assert.equal(quizStatus({ attemptCount: 2, passed: true }), "passed");
    assert.equal(quizStatus({ attemptCount: 1, passed: false }), "failed");
    assert.equal(quizStatus({ attemptCount: 0, passed: null }), "untaken");
    assert.equal(quizStatusLabel("passed"), "合格");
    assert.equal(quizStatusLabel("failed"), "不合格");
    assert.equal(quizStatusLabel("untaken"), "未受験");
  });
  it("受験回数が不正なら未受験、passed が true 以外なら不合格", () => {
    assert.equal(quizStatus({ attemptCount: "2", passed: true }), "untaken");
    assert.equal(quizStatus({ attemptCount: -1, passed: true }), "untaken");
    assert.equal(quizStatus({ passed: true }), "untaken");
    assert.equal(quizStatus({ attemptCount: 1, passed: "true" }), "failed");
  });
});

describe("toQuizCourseItems", () => {
  const quiz = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `テスト${id}`,
    type: "FINAL",
    lessonId: null,
    lessonTitle: null,
    questionCount: 5,
    attemptCount: 1,
    bestScore: 80,
    passed: true,
    lastAttemptAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  });
  const courseRow = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `コース${id}`,
    order: 1,
    icon: "html",
    color: "#EF4444",
    locked: false,
    finalQuizzes: [quiz(`f_${id}`)],
    miniQuizzes: [],
    ...extra,
  });

  for (const [label, v] of [
    ["null", null],
    ["配列", []],
    ["courses なし", {}],
    ["courses が文字列", { courses: "x" }],
    ["courses が null", { courses: null }],
  ] as Array<[string, unknown]>) {
    it(`${label} は空`, () => {
      assert.deepEqual(toQuizCourseItems(v), []);
    });
  }

  it("行に変換する（未受験は最高点 null・未受験、ミニテストのレッスン名）", () => {
    const out = toQuizCourseItems({
      courses: [
        courseRow("c1", {
          locked: true,
          miniQuizzes: [quiz("m1", { type: "MINI", lessonId: "l1", lessonTitle: "レッスン1", attemptCount: 0, bestScore: null, passed: null })],
        }),
      ],
    });
    assert.deepEqual(out, [
      {
        id: "c1",
        name: "コースc1",
        icon: "html",
        color: "#EF4444",
        locked: true,
        finalQuizzes: [
          { id: "f_c1", title: "テストf_c1", lessonTitle: null, questionCount: 5, attemptCount: 1, bestScore: 80, status: "passed", statusLabel: "合格" },
        ],
        miniQuizzes: [
          { id: "m1", title: "テストm1", lessonTitle: "レッスン1", questionCount: 5, attemptCount: 0, bestScore: null, status: "untaken", statusLabel: "未受験" },
        ],
      },
    ]);
  });

  it("locked は true のときだけ。文字列の \"true\" はロックしない", () => {
    assert.equal(toQuizCourseItems({ courses: [courseRow("c1", { locked: "true" })] })[0].locked, false);
  });

  it("壊れた要素を飛ばし、重複した id は最初の 1 件を残す。クイズが残らないコースは出さない", () => {
    const out = toQuizCourseItems({
      courses: [
        null,
        "x",
        { ...courseRow("c0"), id: "" },
        { ...courseRow("c9"), name: 1 },
        courseRow("c1", { finalQuizzes: [quiz("q1"), quiz("q1"), null, { ...quiz("q2"), title: null }, { ...quiz("q3"), id: 3 }] }),
        courseRow("c1"),
        courseRow("c2", { finalQuizzes: [quiz("q1")] }),
        courseRow("c3", { finalQuizzes: "x", miniQuizzes: null }),
      ],
    });
    assert.deepEqual(out.map((c) => [c.id, c.finalQuizzes.map((q) => q.id)]), [["c1", ["q1"]]]);
  });

  it("数値の項目が壊れていれば 0 / null。最高点は 0〜100 の整数だけ", () => {
    const out = toQuizCourseItems({
      courses: [courseRow("c1", { finalQuizzes: [quiz("q1", { questionCount: "5", attemptCount: 1.5, bestScore: 101 }), quiz("q2", { bestScore: "80" })] })],
    });
    const [q1, q2] = out[0].finalQuizzes;
    assert.equal(q1.questionCount, 0);
    assert.equal(q1.attemptCount, 0);
    assert.equal(q1.status, "untaken");
    assert.equal(q1.bestScore, null);
    assert.equal(q2.bestScore, null);
    assert.equal(q2.status, "passed");
  });

  it("icon・color が文字列でなければ空文字", () => {
    const out = toQuizCourseItems({ courses: [courseRow("c1", { icon: null, color: 1 })] });
    assert.equal(out[0].icon, "");
    assert.equal(out[0].color, "");
  });
});

describe("toQuizTakeView", () => {
  const ok = {
    id: "quiz1",
    title: "ダミー",
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

  it("id・title・questions だけにする", () => {
    assert.deepEqual(toQuizTakeView(ok), { id: "quiz1", title: "ダミー", questions: ok.questions });
  });

  for (const [label, v] of [
    ["null", null],
    ["配列", []],
    ["id なし", { ...ok, id: undefined }],
    ["id が空", { ...ok, id: "" }],
    ["title が数値", { ...ok, title: 1 }],
    ["questions なし", { ...ok, questions: undefined }],
    ["questions が空", { ...ok, questions: [] }],
    ["問題が null", { ...ok, questions: [null] }],
    ["問題の id が重複", { ...ok, questions: [ok.questions[0], ok.questions[0]] }],
    ["question が数値", { ...ok, questions: [{ ...ok.questions[0], question: 1 }] }],
    ["options が 1 件", { ...ok, questions: [{ ...ok.questions[0], options: ["a"] }] }],
    ["options に数値", { ...ok, questions: [{ ...ok.questions[0], options: ["a", 1] }] }],
  ] as Array<[string, unknown]>) {
    it(`${label} は null`, () => {
      assert.equal(toQuizTakeView(v), null);
    });
  }
});

describe("toQuizResultView", () => {
  const ok = { score: 67, passed: false, total: 3, correct: 2, results: [true, false, true] };

  it("そのまま使う（画面では採点しない）", () => {
    assert.deepEqual(toQuizResultView(ok, 3), ok);
  });

  it("余計な項目は落とす", () => {
    assert.deepEqual(toQuizResultView({ ...ok, correctIndexes: [0, 1, 2] }, 3), ok);
  });

  for (const [label, v, n] of [
    ["null", null, 3],
    ["score が 101", { ...ok, score: 101 }, 3],
    ["score が文字列", { ...ok, score: "67" }, 3],
    ["passed が文字列", { ...ok, passed: "false" }, 3],
    ["total が問題数と違う", ok, 4],
    ["total が 0", { ...ok, total: 0, correct: 0, results: [] }, 0],
    ["correct が total 超", { ...ok, correct: 4 }, 3],
    ["results の長さ違い", { ...ok, results: [true, false] }, 3],
    ["results に文字列", { ...ok, results: [true, "false", true] }, 3],
  ] as Array<[string, unknown, number]>) {
    it(`${label} は null`, () => {
      assert.equal(toQuizResultView(v, n), null);
    });
  }
});

describe("buildSubmitBody / quizResultTitle", () => {
  it("全問回答なら { answers }、未回答・空なら null", () => {
    assert.deepEqual(buildSubmitBody([0, 2, 1]), { answers: [0, 2, 1] });
    assert.equal(buildSubmitBody([0, null, 1]), null);
    assert.equal(buildSubmitBody([]), null);
  });
  it("結果の見出しは文言だけ（絵文字なし）", () => {
    assert.equal(quizResultTitle(true), "合格です");
    assert.equal(quizResultTitle(false), "不合格です");
    for (const t of [quizResultTitle(true), quizResultTitle(false)]) {
      assert.doesNotMatch(t, new RegExp("\\p{Extended_Pictographic}", "u"));
    }
  });
});
