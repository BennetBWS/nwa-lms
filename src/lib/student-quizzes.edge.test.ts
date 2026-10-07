import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PASSING_PERCENT,
  buildQuizCourses,
  buildSubmitBody,
  parseSubmitAnswers,
  scoreAttempt,
  toAnswerKey,
  toQuizResultView,
  type QuizCourseInput,
  type QuizInput,
} from "./student-quizzes";

// #32 student-quizzes の補強（student-quizzes.test.ts の続き）。境界を総当たりで確かめる。データはすべてダミー。

/** 正解率の四捨五入（0.5 は切り上げ）を整数だけで計算した値 */
const exactRound = (correct: number, total: number) => Math.floor((200 * correct + total) / (2 * total));

describe("scoreAttempt：総当たり（1〜200 問、正解数 0〜全問）", () => {
  it("合否は四捨五入前の正解率が 70% 以上かどうか（整数で比べた値と一致）", () => {
    for (let total = 1; total <= 200; total++) {
      const key = Array.from({ length: total }, () => 0);
      for (let correct = 0; correct <= total; correct++) {
        const answers = key.map((_, i) => (i < correct ? 0 : 1));
        const r = scoreAttempt(answers, key);
        assert.equal(r.correct, correct);
        assert.equal(r.total, total);
        assert.equal(r.passed, correct * 100 >= PASSING_PERCENT * total, `${correct}/${total}`);
        assert.equal(r.results.length, total);
        assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100);
        // 合格なら点数は 70 以上（四捨五入で下がらない）
        if (r.passed) assert.ok(r.score >= PASSING_PERCENT, `${correct}/${total}`);
      }
    }
  });

  it("70% の直前・ちょうど・直後（3/5=60、7/10=70、14/20=70、13/20=65、69/100、70/100）", () => {
    const run = (correct: number, total: number) => {
      const key = Array.from({ length: total }, () => 1);
      return scoreAttempt(key.map((_, i) => (i < correct ? 1 : 0)), key);
    };
    assert.deepEqual([run(3, 5).score, run(3, 5).passed], [60, false]);
    assert.deepEqual([run(7, 10).score, run(7, 10).passed], [70, true]);
    assert.deepEqual([run(14, 20).score, run(14, 20).passed], [70, true]);
    assert.deepEqual([run(13, 20).score, run(13, 20).passed], [65, false]);
    assert.deepEqual([run(69, 100).score, run(69, 100).passed], [69, false]);
    assert.deepEqual([run(70, 100).score, run(70, 100).passed], [70, true]);
  });

  it(
    "点数は正解率の四捨五入（ちょうど .5 は切り上げ。例：23/40 = 57.5% は 58 点）",
    { todo: "不具合：Math.round((correct / total) * 100) の浮動小数の誤差で 23/40 → 57 点、57/200 → 28 点になる（合否には影響なし）" },
    () => {
      for (let total = 1; total <= 200; total++) {
        const key = Array.from({ length: total }, () => 0);
        for (let correct = 0; correct <= total; correct++) {
          const r = scoreAttempt(key.map((_, i) => (i < correct ? 0 : 1)), key);
          assert.equal(r.score, exactRound(correct, total), `${correct}/${total}`);
        }
      }
    }
  );
});

describe("parseSubmitAnswers：境界", () => {
  const counts = [2, 3];

  it("-0 は 0 として受け付ける（JSON では区別できない）", () => {
    const r = parseSubmitAnswers({ answers: [-0, 2] }, counts);
    assert.ok(r.ok);
    assert.equal(JSON.stringify(r.ok && r.value), "[0,2]");
  });

  for (const [label, answers] of [
    ["穴あきの配列", [, 1]],
    ["Infinity", [0, Infinity]],
    ["-Infinity", [0, -Infinity]],
    ["NaN", [NaN, 0]],
    ["BigInt", [BigInt(0), 1]],
    ["Number オブジェクト", [new Number(0), 1]],
    ["最大を超える整数", [0, Number.MAX_SAFE_INTEGER]],
    ["選択肢数ちょうど（範囲外）", [2, 0]],
  ] as Array<[string, unknown[]]>) {
    it(`${label} は invalid_answers`, () => {
      assert.deepEqual(parseSubmitAnswers({ answers }, counts), { ok: false, reason: "invalid_answers" });
    });
  }

  it("長さ 1,000 万の配列も長さの比較だけで断る（中身を見ない）", () => {
    const answers = new Array(10_000_000);
    const started = Date.now();
    assert.deepEqual(parseSubmitAnswers({ answers }, counts), { ok: false, reason: "invalid_answers" });
    assert.ok(Date.now() - started < 200);
  });

  it("配列の外側の値（Array のサブクラス・凍結された配列）でも中身だけを見る", () => {
    class Sub extends Array<number> {}
    const sub = Sub.from([1, 2]);
    assert.deepEqual(parseSubmitAnswers({ answers: sub }, counts), { ok: true, value: [1, 2] });
    assert.deepEqual(parseSubmitAnswers({ answers: Object.freeze([0, 0]) }, counts), { ok: true, value: [0, 0] });
  });

  it("返す配列は body の配列と別物（あとで body を書き換えても影響しない）", () => {
    const body = { answers: [1, 2] };
    const r = parseSubmitAnswers(body, counts);
    body.answers[0] = 99;
    assert.deepEqual(r, { ok: true, value: [1, 2] });
  });
});

describe("toAnswerKey：correctIndex の型", () => {
  const row = (correctIndex: unknown) => [{ options: ["a", "b"], correctIndex: correctIndex as number }];
  for (const [label, v] of [
    ["文字列の数字", "0"],
    ["-1", -1],
    ["小数", 0.5],
    ["NaN", NaN],
    ["null", null],
    ["true", true],
    ["選択肢数ちょうど", 2],
  ] as Array<[string, unknown]>) {
    it(`${label} は null（受験できない）`, () => {
      assert.equal(toAnswerKey(row(v)), null);
    });
  }

  it("-0 は 0 として扱う", () => {
    const key = toAnswerKey(row(-0));
    assert.equal(JSON.stringify(key), JSON.stringify({ optionCounts: [2], correctIndexes: [0] }));
    assert.deepEqual(scoreAttempt([0], key!.correctIndexes).results, [true]);
  });

  it("2 問目だけが壊れていても全体が null", () => {
    assert.equal(toAnswerKey([{ options: ["a", "b"], correctIndex: 0 }, { options: ["a", "b"], correctIndex: 2 }]), null);
  });
});

describe("buildSubmitBody：境界", () => {
  for (const [label, answers] of [
    ["穴あき", [, 1]],
    ["NaN", [NaN]],
    ["小数", [0.5]],
    ["負の数", [-1]],
    ["文字列", ["0"]],
  ] as Array<[string, unknown[]]>) {
    it(`${label} は null（送信しない）`, () => {
      assert.equal(buildSubmitBody(answers as Array<number | null>), null);
    });
  }

  it("body は answers だけ（正解・点数を送らない）", () => {
    assert.deepEqual(Object.keys(buildSubmitBody([0, 1])!), ["answers"]);
  });
});

describe("toQuizResultView：境界", () => {
  const ok = { score: 50, passed: false, total: 2, correct: 1, results: [true, false] };
  for (const [label, data] of [
    ["点数が 101", { ...ok, score: 101 }],
    ["点数が小数", { ...ok, score: 50.5 }],
    ["点数が文字列", { ...ok, score: "50" }],
    ["passed が文字列", { ...ok, passed: "false" }],
    ["results に null", { ...ok, results: [true, null] }],
    ["correct が負", { ...ok, correct: -1 }],
  ] as Array<[string, unknown]>) {
    it(`${label} は null`, () => {
      assert.equal(toQuizResultView(data, 2), null);
    });
  }

  it("返す results は応答の配列と別物", () => {
    const data = { ...ok, results: [true, false] };
    const v = toQuizResultView(data, 2)!;
    data.results[0] = false;
    assert.deepEqual(v.results, [true, false]);
  });
});

describe("buildQuizCourses：境界", () => {
  const courses: QuizCourseInput[] = [
    { id: "c1", name: "STEP1", order: 1, icon: "it", color: "#000", sections: [{ lessons: [{ id: "l1" }] }] },
    { id: "c2", name: "STEP2", order: 2, icon: "html", color: "#111", sections: [{ lessons: [{ id: "l2" }] }] },
  ];
  const good = [{ options: ["a", "b"], correctIndex: 0 }];
  const quiz = (p: Partial<QuizInput> & { id: string }): QuizInput => ({
    title: p.id,
    type: "FINAL",
    courseId: "c1",
    lessonId: null,
    lesson: null,
    questions: good,
    ...p,
  });

  it("種類が MINI / FINAL 以外のクイズは除く", () => {
    const out = buildQuizCourses(courses, new Set(), [quiz({ id: "x", type: "OTHER" as unknown as "FINAL" })], []);
    assert.deepEqual(out, []);
  });

  it("courseId を持つ MINI でもレッスンがなければ除く（courseId では振り分けない）", () => {
    const out = buildQuizCourses(courses, new Set(), [quiz({ id: "m", type: "MINI", courseId: "c1", lesson: null })], []);
    assert.deepEqual(out, []);
  });

  it("FINAL にレッスンがあっても courseId のコースへ（レッスンのコースではない）", () => {
    const out = buildQuizCourses(
      courses,
      new Set(["l1"]),
      [quiz({ id: "f", courseId: "c2", lessonId: "l1", lesson: { id: "l1", title: "L1", order: 1, section: { id: "s1", order: 1, courseId: "c1" } } })],
      []
    );
    assert.deepEqual(out.map((c) => c.id), ["c2"]);
  });

  it("出力の項目に questions・options・correctIndex がない（クイズの各項目）", () => {
    const out = buildQuizCourses(courses, new Set(), [quiz({ id: "f" })], [{ quizId: "f", score: 50, passed: false, createdAt: new Date(0) }]);
    const keys = Object.keys(out[0].finalQuizzes[0]).sort();
    assert.deepEqual(keys, ["attemptCount", "bestScore", "id", "lastAttemptAt", "lessonId", "lessonTitle", "passed", "questionCount", "title", "type"]);
    assert.doesNotMatch(JSON.stringify(out), /correctIndex|options|"answers"/);
  });

  it("最高点の受験が不合格でも、別の回で合格していれば passed は true（最高点と合否は別に数える）", () => {
    const out = buildQuizCourses(courses, new Set(), [quiz({ id: "f" })], [
      { quizId: "f", score: 90, passed: false, createdAt: new Date(1000) },
      { quizId: "f", score: 70, passed: true, createdAt: new Date(2000) },
    ]);
    const f = out[0].finalQuizzes[0];
    assert.deepEqual([f.attemptCount, f.bestScore, f.passed, f.lastAttemptAt], [2, 90, true, new Date(2000).toISOString()]);
  });
});
