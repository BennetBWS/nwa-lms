import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  QUIZ_RATE_LIMITS,
  QUIZ_WINDOW_MS,
  decideQuizAttempt,
  quizRetryAfterSeconds,
  quizWindowStart,
  type RecentAttempt,
} from "./quiz-rate-limit";
import type { QuizType } from "./student-quizzes";

// #51 確認テストの受験の間隔・回数・重複の判定（DB・時計なし。現在時刻は引数）

const NOW = new Date("2026-10-15T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const A = [0, 1, 2];
const B = [1, 1, 2];
const att = (answers: unknown, msAgo: number): RecentAttempt => ({ answers, createdAt: ago(msAgo) });

describe("定数（Tec 決定 2026-10-15 Q1 a）", () => {
  it("ミニテストは 60 秒・24 時間に 10 回、修了テストは 30 分・24 時間に 3 回", () => {
    assert.deepEqual({ ...QUIZ_RATE_LIMITS.MINI }, { intervalMs: 60 * SEC, dailyLimit: 10 });
    assert.deepEqual({ ...QUIZ_RATE_LIMITS.FINAL }, { intervalMs: 30 * MIN, dailyLimit: 3 });
    assert.equal(QUIZ_WINDOW_MS, 24 * HOUR);
  });

  it("定数は書き換えられない", () => {
    assert.ok(Object.isFrozen(QUIZ_RATE_LIMITS), "QUIZ_RATE_LIMITS が凍結されていない");
    assert.ok(Object.isFrozen(QUIZ_RATE_LIMITS.MINI) && Object.isFrozen(QUIZ_RATE_LIMITS.FINAL), "種類ごとの値が凍結されていない");
  });

  it("quizWindowStart は now の 24 時間前", () => {
    assert.equal(quizWindowStart(NOW).toISOString(), "2026-10-14T12:00:00.000Z");
  });
});

for (const type of ["MINI", "FINAL"] as QuizType[]) {
  const { intervalMs, dailyLimit } = QUIZ_RATE_LIMITS[type];
  /** 間隔を空けて受けた n 件（直近は ago(start)） */
  const spaced = (n: number, start: number, step = intervalMs + MIN) =>
    Array.from({ length: n }, (_, i) => att([i % 2, 9, i], start + i * step));

  describe(`decideQuizAttempt（${type}）：通る場合`, () => {
    it("受験記録がなければ ok", () => {
      assert.deepEqual(decideQuizAttempt([], A, type, NOW), { kind: "ok" });
    });

    it("直前の受験からちょうど間隔ぶんなら ok（違う回答）", () => {
      assert.deepEqual(decideQuizAttempt([att(B, intervalMs)], A, type, NOW), { kind: "ok" });
    });

    it("直前の受験から間隔 + 1 ms なら ok", () => {
      assert.deepEqual(decideQuizAttempt([att(B, intervalMs + 1)], A, type, NOW), { kind: "ok" });
    });

    it(`24 時間以内に ${dailyLimit - 1} 回なら ok`, () => {
      assert.deepEqual(decideQuizAttempt(spaced(dailyLimit - 1, intervalMs), A, type, NOW), { kind: "ok" });
    });

    it("ちょうど 24 時間前の受験は数えない（期間は now - 24 時間より後）", () => {
      const recent = [att(B, 24 * HOUR), ...spaced(dailyLimit - 1, intervalMs, MIN)];
      assert.deepEqual(decideQuizAttempt(recent, A, type, NOW), { kind: "ok" });
    });

    it("日時が不正な記録は無視する", () => {
      assert.deepEqual(decideQuizAttempt([{ answers: A, createdAt: new Date(Number.NaN) }], A, type, NOW), { kind: "ok" });
    });
  });

  describe(`decideQuizAttempt（${type}）：間隔`, () => {
    it("直前の受験から間隔 - 1 ms なら 429（残り 1 ms は 1 秒に切り上げ）", () => {
      assert.deepEqual(decideQuizAttempt([att(B, intervalMs - 1)], A, type, NOW), { kind: "rate_limited", retryAfterSeconds: 1 });
    });

    it("直後なら 429 で、retryAfterSeconds は間隔ちょうど", () => {
      assert.deepEqual(decideQuizAttempt([att(B, 0)], A, type, NOW), { kind: "rate_limited", retryAfterSeconds: intervalMs / SEC });
    });

    it("直前の受験の日時が未来（時計のずれ）でも、retryAfterSeconds は間隔を超えない", () => {
      assert.deepEqual(decideQuizAttempt([att(B, -HOUR)], A, type, NOW), { kind: "rate_limited", retryAfterSeconds: intervalMs / SEC });
    });

    it("並び順に関係なく、いちばん新しい受験で判定する", () => {
      const recent = [att(B, 5 * HOUR), att(B, 10 * SEC)];
      const d = decideQuizAttempt(recent, A, type, NOW);
      assert.deepEqual(d, { kind: "rate_limited", retryAfterSeconds: (intervalMs - 10 * SEC) / SEC });
    });
  });

  describe(`decideQuizAttempt（${type}）：24 時間の回数`, () => {
    it(`24 時間以内に ${dailyLimit} 回なら 429。retryAfterSeconds は最も古い 1 件が期間から出るまで`, () => {
      const recent = spaced(dailyLimit, 2 * intervalMs);
      const oldest = 2 * intervalMs + (dailyLimit - 1) * (intervalMs + MIN);
      const d = decideQuizAttempt(recent, A, type, NOW);
      assert.deepEqual(d, { kind: "rate_limited", retryAfterSeconds: Math.ceil((24 * HOUR - oldest) / SEC) });
    });

    it(`上限を超えて（${dailyLimit + 2} 件）渡されても、新しい方から ${dailyLimit} 件目で待ち時間を出す`, () => {
      const recent = spaced(dailyLimit + 2, 2 * intervalMs);
      const nth = 2 * intervalMs + (dailyLimit - 1) * (intervalMs + MIN);
      const d = decideQuizAttempt(recent, A, type, NOW);
      assert.deepEqual(d, { kind: "rate_limited", retryAfterSeconds: Math.ceil((24 * HOUR - nth) / SEC) });
    });

    it("間隔と回数の両方にかかるなら、長い方の待ち時間", () => {
      const recent = [att(B, 0), ...spaced(dailyLimit - 1, intervalMs + MIN)];
      const d = decideQuizAttempt(recent, A, type, NOW);
      assert.equal(d.kind, "rate_limited");
      const oldest = intervalMs + MIN + (dailyLimit - 2) * (intervalMs + MIN);
      const want = Math.max(intervalMs, 24 * HOUR - oldest) / SEC;
      assert.equal((d as { retryAfterSeconds: number }).retryAfterSeconds, Math.ceil(want));
    });

    it("未来の日時の記録が混ざっていても、retryAfterSeconds は 24 時間を超えない", () => {
      const recent = Array.from({ length: dailyLimit }, (_, i) => att([i], -(i + 1) * HOUR));
      const d = decideQuizAttempt(recent, A, type, NOW);
      assert.equal(d.kind, "rate_limited");
      const s = (d as { retryAfterSeconds: number }).retryAfterSeconds;
      assert.ok(s >= 1 && s <= 24 * HOUR / SEC, `retryAfterSeconds が範囲外: ${s}`);
    });

    it("retryAfterSeconds は、どの経過でも 1 秒以上・24 時間以下の整数", () => {
      for (let i = 0; i < 300; i++) {
        const msAgo = (i * 7919) % (25 * HOUR);
        const recent = [att(B, msAgo), ...spaced(dailyLimit - 1, msAgo + 1)];
        const d = decideQuizAttempt(recent, A, type, NOW);
        if (d.kind !== "rate_limited") continue;
        const s = d.retryAfterSeconds;
        assert.ok(Number.isInteger(s) && s >= 1 && s <= 24 * HOUR / SEC, `msAgo ${msAgo}: retryAfterSeconds が範囲外 ${s}`);
      }
    });
  });

  describe(`decideQuizAttempt（${type}）：重複`, () => {
    it("直前と同じ回答で、間隔の内側なら duplicate", () => {
      assert.deepEqual(decideQuizAttempt([att([...A], 1)], A, type, NOW), { kind: "duplicate" });
      assert.deepEqual(decideQuizAttempt([att([...A], intervalMs - 1)], A, type, NOW), { kind: "duplicate" });
    });

    it("同じ回答でも、ちょうど間隔ぶんたっていれば新しい受験（ok）", () => {
      assert.deepEqual(decideQuizAttempt([att([...A], intervalMs)], A, type, NOW), { kind: "ok" });
    });

    it("回答が違えば 429（重複ではない）", () => {
      assert.equal(decideQuizAttempt([att(B, 1)], A, type, NOW).kind, "rate_limited");
    });

    it("長さが違う・要素の型が違う回答は重複にしない", () => {
      assert.equal(decideQuizAttempt([att([0, 1], 1)], A, type, NOW).kind, "rate_limited");
      assert.equal(decideQuizAttempt([att([0, 1, 2, 3], 1)], A, type, NOW).kind, "rate_limited");
      assert.equal(decideQuizAttempt([att(["0", "1", "2"], 1)], A, type, NOW).kind, "rate_limited");
    });

    for (const [label, broken] of [
      ["null", null],
      ["文字列", "0,1,2"],
      ["オブジェクト", { 0: 0, 1: 1, 2: 2, length: 3 }],
      ["数値", 12],
    ] as Array<[string, unknown]>) {
      it(`保存された answers が壊れている（${label}）なら重複にしない`, () => {
        assert.equal(decideQuizAttempt([att(broken, 1)], A, type, NOW).kind, "rate_limited");
      });
    }

    it("比べるのは直近 1 件だけ（2 件前と同じ回答でも重複にしない）", () => {
      const recent = [att(B, 2 * SEC), att([...A], 3 * SEC)];
      assert.equal(decideQuizAttempt(recent, A, type, NOW).kind, "rate_limited");
    });

    it(`重複は回数の上限より先に判定する（${dailyLimit} 回受けたあとの再送も duplicate）`, () => {
      const recent = [att([...A], 1), ...spaced(dailyLimit - 1, intervalMs)];
      assert.deepEqual(decideQuizAttempt(recent, A, type, NOW), { kind: "duplicate" });
    });

    it("直前の受験の日時が未来（時計のずれ）で同じ回答なら duplicate", () => {
      assert.deepEqual(decideQuizAttempt([att([...A], -HOUR)], A, type, NOW), { kind: "duplicate" });
    });
  });

  describe(`quizRetryAfterSeconds（${type}。GET の事前の案内）`, () => {
    it("受験記録がなければ null", () => {
      assert.equal(quizRetryAfterSeconds([], type, NOW), null);
    });

    it("間隔の外で回数も残っていれば null", () => {
      assert.equal(quizRetryAfterSeconds(spaced(dailyLimit - 1, intervalMs), type, NOW), null);
    });

    it("間隔の内側なら残りの秒数（decideQuizAttempt の 429 と同じ値）", () => {
      const recent = [att(B, 10 * SEC)];
      const d = decideQuizAttempt(recent, A, type, NOW);
      assert.equal(quizRetryAfterSeconds(recent, type, NOW), (d as { retryAfterSeconds: number }).retryAfterSeconds);
    });

    it("回数の上限なら、最も古い 1 件が期間から出るまで（answers がなくても判定できる）", () => {
      const recent = spaced(dailyLimit, 2 * intervalMs).map((a) => ({ createdAt: a.createdAt }));
      const oldest = 2 * intervalMs + (dailyLimit - 1) * (intervalMs + MIN);
      assert.equal(quizRetryAfterSeconds(recent, type, NOW), Math.ceil((24 * HOUR - oldest) / SEC));
    });
  });
}

describe("MINI と FINAL で値が分かれる", () => {
  it("2 分前の受験：ミニテストは ok、修了テストは 429", () => {
    assert.deepEqual(decideQuizAttempt([att(B, 2 * MIN)], A, "MINI", NOW), { kind: "ok" });
    assert.deepEqual(decideQuizAttempt([att(B, 2 * MIN)], A, "FINAL", NOW), { kind: "rate_limited", retryAfterSeconds: 28 * 60 });
  });

  it("2 分前に同じ回答：ミニテストは新しい受験、修了テストは重複", () => {
    assert.deepEqual(decideQuizAttempt([att([...A], 2 * MIN)], A, "MINI", NOW), { kind: "ok" });
    assert.deepEqual(decideQuizAttempt([att([...A], 2 * MIN)], A, "FINAL", NOW), { kind: "duplicate" });
  });

  it("1 時間おきに 3 回：ミニテストは ok、修了テストは 429", () => {
    const recent = [att(B, HOUR), att(B, 2 * HOUR), att(B, 3 * HOUR)];
    assert.deepEqual(decideQuizAttempt(recent, A, "MINI", NOW), { kind: "ok" });
    assert.deepEqual(decideQuizAttempt(recent, A, "FINAL", NOW), { kind: "rate_limited", retryAfterSeconds: 21 * 60 * 60 });
  });

  it("想定外の種類は、厳しい方（修了テスト）の制限を使う", () => {
    for (const t of ["OTHER", "constructor", "__proto__"]) {
      assert.deepEqual(
        decideQuizAttempt([att(B, 2 * MIN)], A, t as QuizType, NOW),
        { kind: "rate_limited", retryAfterSeconds: 28 * 60 },
        `${t} の制限が修了テストと違う`
      );
    }
  });
});

describe("入力を書き換えない", () => {
  it("recent の並び・answers をそのまま残す", () => {
    const recent = [att(B, 5 * HOUR), att([...A], 1)];
    const copy = recent.map((r) => ({ ...r }));
    const answers = [...A];
    decideQuizAttempt(recent, answers, "FINAL", NOW);
    quizRetryAfterSeconds(recent, "FINAL", NOW);
    assert.deepEqual(recent, copy, "recent が書き換えられた");
    assert.deepEqual(answers, A, "answers が書き換えられた");
  });
});
