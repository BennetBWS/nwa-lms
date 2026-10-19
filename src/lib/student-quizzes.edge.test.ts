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

/** 形だけが正しいダミーの受験のトークン（#51 選択肢のシャッフル） */
const TOKEN = `v1.${"A".repeat(22)}.${"B".repeat(43)}`;

/** 正解率の切り捨て（#51）を、BigInt の整数の割り算で計算した値（実装と別の方法で求める） */
const exactFloor = (correct: number, total: number) => Number((BigInt(100) * BigInt(correct)) / BigInt(total));

describe("scoreAttempt：総当たり（1〜200 問、正解数 0〜全問）", () => {
  it("合否は丸める前の正解率が 70% 以上かどうかで、点数（切り捨て）が 70 以上かどうかと必ず一致する", () => {
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
        // 点数と合否は必ず一致する（切り捨て。#51）：70 点以上なら合格、69 点以下なら不合格
        assert.equal(r.score >= PASSING_PERCENT, r.passed, `${correct}/${total}: 点数 ${r.score} と合否 ${r.passed} が食い違う`);
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

  it("点数は正解率の切り捨て（例：23/40 = 57.5% は 57 点、2/3 は 66 点）", () => {
    for (let total = 1; total <= 200; total++) {
      const key = Array.from({ length: total }, () => 0);
      for (let correct = 0; correct <= total; correct++) {
        const r = scoreAttempt(key.map((_, i) => (i < correct ? 0 : 1)), key);
        assert.equal(r.score, exactFloor(correct, total), `${correct}/${total}`);
      }
    }
  });

  it("浮動小数で誤差が出やすい例も切り捨て（23/40 は 57 点、57/200 は 28 点、29/100 は 29 点、7/10 は 70 点）", () => {
    const run = (correct: number, total: number) => {
      const key = Array.from({ length: total }, () => 0);
      return scoreAttempt(key.map((_, i) => (i < correct ? 0 : 1)), key);
    };
    assert.equal(run(23, 40).score, 57);
    assert.equal(run(57, 200).score, 28);
    // 29 * 100 / 100 や 0.7 * 100 は浮動小数では 28.999… / 69.999… になりうる。整数で計算していれば正確
    assert.equal(run(29, 100).score, 29);
    assert.equal(run(7, 10).score, 70);
  });
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
      assert.equal(buildSubmitBody(answers as Array<number | null>, answers.map((_, i) => `q${i}`), TOKEN), null);
    });
  }

  it("body は answers と questionIds と attemptToken だけ（正解・点数を送らない。#51）", () => {
    assert.deepEqual(Object.keys(buildSubmitBody([0, 1], ["q1", "q2"], TOKEN)!), ["answers", "questionIds", "attemptToken"]);
  });

  for (const [label, ids] of [
    ["回答より少ない", ["q1"]],
    ["回答より多い", ["q1", "q2", "q3"]],
    ["空文字を含む", ["q1", ""]],
    ["数値を含む", ["q1", 2]],
    ["配列でない", "q1,q2"],
  ] as Array<[string, unknown]>) {
    it(`問題の id が${label}なら null（送信しない。#51）`, () => {
      assert.equal(buildSubmitBody([0, 1], ids as string[], TOKEN), null);
    });
  }

  it("返す questionIds は受け取った配列と別物", () => {
    const ids = ["q1", "q2"];
    const body = buildSubmitBody([0, 1], ids, TOKEN)!;
    ids[0] = "x";
    assert.deepEqual(body.questionIds, ["q1", "q2"]);
  });
});

describe("toQuizResultView：境界", () => {
  const ok = { score: 50, passed: false, total: 2, correct: 1, results: [true, false] };

  for (const [label, duplicate, want] of [
    ["duplicate: true", true, true],
    ["duplicate: false", false, false],
    ["duplicate なし", undefined, false],
    ["duplicate が文字列", "true", false],
    ["duplicate が 1", 1, false],
    ["duplicate が null", null, false],
  ] as Array<[string, unknown, boolean]>) {
    it(`${label} は duplicate ${want}（#51。真偽値の true だけを重複とみなす）`, () => {
      const data: Record<string, unknown> = { ...ok };
      if (duplicate !== undefined) data.duplicate = duplicate;
      assert.equal(toQuizResultView(data, 2)?.duplicate, want);
    });
  }

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
