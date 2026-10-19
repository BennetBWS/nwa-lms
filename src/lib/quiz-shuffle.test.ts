import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHUFFLE_KEY_INFO,
  TOKEN_KEY_INFO,
  deriveQuizKeys,
  issueAttemptToken,
  newNonce,
  optionPermutation,
  shuffleQuestionViews,
  toOriginalAnswers,
  verifyAttemptToken,
} from "./quiz-shuffle";
import { QuizKeyUnavailableError, quizKeys } from "./quiz-shuffle-key";
import { ATTEMPT_TOKEN_PATTERN, isAttemptTokenFormat } from "./student-quizzes";

// #51 追加修正：選択肢のシャッフル（quiz-shuffle.ts）と鍵（quiz-shuffle-key.ts）。
// 鍵はダミーの文字列から作る（本物の AUTH_SECRET は使わない）。
// 統計テストは決まった nonce の列（i を符号化したもの）で回すので、毎回同じ結果になり、たまたま落ちることはない。

const DUMMY_SECRET = "dummy-auth-secret-for-tests-only";
const KEYS = deriveQuizKeys(DUMMY_SECRET);

/** i を 16 バイトに符号化した決まった nonce（base64url 22 字） */
function fixedNonce(i: number): string {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(i, 12);
  return b.toString("base64url");
}

const BASE = { userId: "stu_1", quizId: "quiz_1", questionId: "q_1" };

function permKey(p: number[]): string {
  return p.join(",");
}

function factorial(n: number): number {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

function chiSquare(counts: number[], expected: number): number {
  return counts.reduce((s, c) => s + ((c - expected) ** 2) / expected, 0);
}

// p = 0.001 の臨界値（自由度 → 値）。119 は Wilson–Hilferty の近似
const CHI2_CRITICAL_0_001: Record<number, number> = { 1: 10.828, 2: 13.816, 3: 16.266, 4: 18.467, 5: 20.515, 23: 49.728, 119: 172.5 };

describe("deriveQuizKeys：鍵の導出", () => {
  it("用途ごとの 2 本の鍵は 32 バイトで、互いに違う", () => {
    assert.equal(KEYS.shuffleKey.length, 32);
    assert.equal(KEYS.tokenKey.length, 32);
    assert.ok(!KEYS.shuffleKey.equals(KEYS.tokenKey), "シャッフルとトークンの鍵が同じ");
  });

  it("鍵に secret そのものが入らない", () => {
    const s = Buffer.from(DUMMY_SECRET);
    assert.ok(!KEYS.shuffleKey.includes(s.subarray(0, 8)), "shuffleKey に secret の先頭が入っている");
    assert.ok(!KEYS.tokenKey.includes(s.subarray(0, 8)), "tokenKey に secret の先頭が入っている");
  });

  it("同じ secret なら同じ鍵、別の secret なら別の鍵", () => {
    assert.ok(deriveQuizKeys(DUMMY_SECRET).shuffleKey.equals(KEYS.shuffleKey), "同じ secret で鍵が変わった");
    assert.ok(!deriveQuizKeys(DUMMY_SECRET + "x").shuffleKey.equals(KEYS.shuffleKey), "別の secret で同じ鍵になった");
  });

  it("info は Auth.js の鍵の info と違う文字列", () => {
    assert.notEqual(SHUFFLE_KEY_INFO, TOKEN_KEY_INFO);
    for (const info of [SHUFFLE_KEY_INFO, TOKEN_KEY_INFO]) {
      assert.doesNotMatch(info, /Auth\.js/);
    }
  });

  it("空の secret は例外", () => {
    assert.throws(() => deriveQuizKeys(""));
  });
});

describe("quizKeys：AUTH_SECRET から鍵を作る", () => {
  it("AUTH_SECRET が未設定・空なら QuizKeyUnavailableError で、メッセージに値を含まない", () => {
    for (const env of [{}, { AUTH_SECRET: "" }, { NEXTAUTH_SECRET: DUMMY_SECRET }]) {
      assert.throws(
        () => quizKeys(env),
        (e: unknown) => e instanceof QuizKeyUnavailableError && e.name === "QuizKeyUnavailableError" && !e.message.includes(DUMMY_SECRET)
      );
    }
  });

  it("AUTH_SECRET があれば deriveQuizKeys と同じ鍵", () => {
    const k = quizKeys({ AUTH_SECRET: DUMMY_SECRET });
    assert.ok(k.shuffleKey.equals(KEYS.shuffleKey), "shuffleKey が違う");
    assert.ok(k.tokenKey.equals(KEYS.tokenKey), "tokenKey が違う");
  });

  it("引数を省略すると process.env.AUTH_SECRET を読む", () => {
    const saved = process.env.AUTH_SECRET;
    try {
      delete process.env.AUTH_SECRET;
      assert.throws(() => quizKeys(), QuizKeyUnavailableError);
      process.env.AUTH_SECRET = DUMMY_SECRET;
      assert.ok(quizKeys().tokenKey.equals(KEYS.tokenKey), "process.env の値から作られていない");
    } finally {
      if (saved === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = saved;
    }
  });
});

describe("optionPermutation：正しい並べ替え", () => {
  it("0..n-1 を重複なくすべて含む（n = 1〜8）", () => {
    for (let n = 1; n <= 8; n++) {
      for (let i = 0; i < 200; i++) {
        const p = optionPermutation(KEYS.shuffleKey, { ...BASE, nonce: fixedNonce(i), n });
        assert.deepEqual([...p].sort((a, b) => a - b), Array.from({ length: n }, (_, k) => k), `n=${n} i=${i}`);
      }
    }
  });

  it("同じ入力なら同じ結果", () => {
    for (let i = 0; i < 50; i++) {
      const input = { ...BASE, nonce: fixedNonce(i), n: 4 };
      assert.deepEqual(optionPermutation(KEYS.shuffleKey, input), optionPermutation(KEYS.shuffleKey, input));
    }
  });

  for (const field of ["userId", "quizId", "questionId", "nonce"] as const) {
    it(`${field} を 1 つ変えると並べ替えが変わる（割合で確認）`, () => {
      let changed = 0;
      const trials = 2000;
      for (let i = 0; i < trials; i++) {
        const a = { ...BASE, nonce: fixedNonce(i), n: 4 };
        const b = { ...a, [field]: field === "nonce" ? fixedNonce(i + 1_000_000) : `${a[field]}_x` };
        if (permKey(optionPermutation(KEYS.shuffleKey, a)) !== permKey(optionPermutation(KEYS.shuffleKey, b))) changed++;
      }
      // 独立なら一致する確率は 1/24（約 4%）。変わる割合は約 96%
      assert.ok(changed / trials > 0.9, `${field} を変えても並べ替えが変わらない割合が高い（${changed}/${trials}）`);
    });
  }

  it("鍵が違えば並べ替えが変わる（鍵なしでは再計算できない）", () => {
    const other = deriveQuizKeys("another-dummy-secret");
    let changed = 0;
    for (let i = 0; i < 2000; i++) {
      const input = { ...BASE, nonce: fixedNonce(i), n: 4 };
      if (permKey(optionPermutation(KEYS.shuffleKey, input)) !== permKey(optionPermutation(other.shuffleKey, input))) changed++;
    }
    assert.ok(changed / 2000 > 0.9, `鍵を変えても並べ替えが変わらない割合が高い（${changed}/2000）`);
  });

  it("選択肢の数が 1 未満・整数でなければ例外", () => {
    for (const n of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => optionPermutation(KEYS.shuffleKey, { ...BASE, nonce: fixedNonce(0), n }));
    }
  });
});

describe("optionPermutation：偏りがない（カイ二乗、p = 0.001）", () => {
  for (const n of [2, 3, 4, 5]) {
    it(`n=${n}：並べ替え ${factorial(n)} 通りの度数と、元の位置 0 の表示位置の度数が一様`, () => {
      const perms = factorial(n);
      const trials = n === 4 ? 24_000 : n === 5 ? 24_000 : 12_000;
      const permCounts = new Map<string, number>();
      const posCounts = new Array<number>(n).fill(0);
      for (let i = 0; i < trials; i++) {
        const p = optionPermutation(KEYS.shuffleKey, { ...BASE, nonce: fixedNonce(i), n });
        const k = permKey(p);
        permCounts.set(k, (permCounts.get(k) ?? 0) + 1);
        posCounts[p.indexOf(0)]++;
      }
      assert.equal(permCounts.size, perms, `n=${n} で出ない並べ替えがある`);
      const permChi = chiSquare(Array.from(permCounts.values()), trials / perms);
      const permCrit = CHI2_CRITICAL_0_001[perms - 1];
      assert.ok(permChi < permCrit, `n=${n} の並べ替えの度数が一様でない（χ²=${permChi.toFixed(2)}、臨界値 ${permCrit}）`);
      const posChi = chiSquare(posCounts, trials / n);
      const posCrit = CHI2_CRITICAL_0_001[n - 1];
      assert.ok(posChi < posCrit, `n=${n} の元の位置 0 の表示位置が一様でない（χ²=${posChi.toFixed(2)}、臨界値 ${posCrit}）`);
    });
  }

  it("問題が違えば並べ替えは独立（2 問の組の 16 区分が一様）", () => {
    const trials = 16_000;
    const counts = new Array<number>(16).fill(0);
    for (let i = 0; i < trials; i++) {
      const a = optionPermutation(KEYS.shuffleKey, { ...BASE, questionId: "q_a", nonce: fixedNonce(i), n: 4 });
      const b = optionPermutation(KEYS.shuffleKey, { ...BASE, questionId: "q_b", nonce: fixedNonce(i), n: 4 });
      counts[a.indexOf(0) * 4 + b.indexOf(0)]++;
    }
    const chi = chiSquare(counts, trials / 16);
    // 自由度 15、p = 0.001 の臨界値 37.697
    assert.ok(chi < 37.697, `2 問の正解の位置の組が独立でない（χ²=${chi.toFixed(2)}）`);
  });
});

describe("shuffleQuestionViews・toOriginalAnswers", () => {
  const ctx = { userId: "stu_1", quizId: "quiz_1", nonce: fixedNonce(7) };
  const views = [
    { id: "q1", question: "問1", options: ["a0", "a1", "a2", "a3"] },
    { id: "q2", question: "問2", options: ["b0", "b1"] },
    { id: "q3", question: "問3", options: ["c0", "c1", "c2"] },
  ];

  it("問題の順・id・問題文は変えず、選択肢は同じ文の並べ替え。元の配列は変えない", () => {
    const before = JSON.stringify(views);
    const out = shuffleQuestionViews(KEYS.shuffleKey, ctx, views);
    assert.equal(JSON.stringify(views), before);
    assert.deepEqual(out.map((q) => [q.id, q.question]), views.map((q) => [q.id, q.question]));
    out.forEach((q, i) => assert.deepEqual([...q.options].sort(), [...views[i].options].sort()));
  });

  it("表示された文の位置を送ると、元の位置に戻る（往復）", () => {
    const out = shuffleQuestionViews(KEYS.shuffleKey, ctx, views);
    const qs = views.map((q) => ({ id: q.id, optionCount: q.options.length }));
    for (let o0 = 0; o0 < 4; o0++) {
      for (let o1 = 0; o1 < 2; o1++) {
        for (let o2 = 0; o2 < 3; o2++) {
          const originals = [o0, o1, o2];
          const displayed = originals.map((o, i) => out[i].options.indexOf(views[i].options[o]));
          assert.deepEqual(toOriginalAnswers(KEYS.shuffleKey, ctx, qs, displayed), originals);
        }
      }
    }
  });

  it("長さが違う・範囲外の表示位置は例外", () => {
    const qs = views.map((q) => ({ id: q.id, optionCount: q.options.length }));
    assert.throws(() => toOriginalAnswers(KEYS.shuffleKey, ctx, qs, [0, 0]));
    assert.throws(() => toOriginalAnswers(KEYS.shuffleKey, ctx, qs, [0, 2, 0]));
    assert.throws(() => toOriginalAnswers(KEYS.shuffleKey, ctx, qs, [0, -1, 0]));
  });
});

describe("issueAttemptToken・verifyAttemptToken", () => {
  const questions = [
    { id: "q1", options: ["a0", "a1", "a2", "a3"] },
    { id: "q2", options: ["b0", "b1"] },
  ];
  const ctx = { userId: "stu_1", quizId: "quiz_1", questions };

  it("形は v1.<22 字>.<43 字> で、isAttemptTokenFormat に合う", () => {
    const t = issueAttemptToken(KEYS, ctx);
    assert.match(t, ATTEMPT_TOKEN_PATTERN);
    assert.ok(isAttemptTokenFormat(t), "形が合わない");
  });

  it("nonce は毎回違う（16 バイトの乱数、22 字）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = newNonce();
      assert.equal(n.length, 22);
      seen.add(n);
    }
    assert.equal(seen.size, 200);
    assert.notEqual(issueAttemptToken(KEYS, ctx), issueAttemptToken(KEYS, ctx));
  });

  it("発行したトークンは検証を通り、nonce を返す", () => {
    const nonce = fixedNonce(3);
    assert.equal(verifyAttemptToken(KEYS, issueAttemptToken(KEYS, ctx, nonce), ctx), nonce);
    const t = issueAttemptToken(KEYS, ctx);
    assert.equal(verifyAttemptToken(KEYS, t, ctx), t.split(".")[1]);
  });

  it("トークンに選択肢の文・並べ替え・ダイジェストを含まない（nonce と MAC だけ）", () => {
    const t = issueAttemptToken(KEYS, ctx, fixedNonce(3));
    const parts = t.split(".");
    assert.equal(parts.length, 3);
    assert.equal(parts[1], fixedNonce(3));
    for (const s of ["a0", "b1", "q1", "stu_1", "quiz_1"]) assert.ok(!t.includes(s), `トークンに ${s} が入っている`);
  });

  it("MAC・nonce の 1 文字を変える、別のユーザー・クイズ、選択肢の文の変更・並び替え・問題の増減、別の鍵：すべて null", () => {
    const nonce = fixedNonce(3);
    const t = issueAttemptToken(KEYS, ctx, nonce);
    const flip = (s: string, at: number) => s.slice(0, at) + (s[at] === "A" ? "B" : "A") + s.slice(at + 1);
    const cases: Array<[string, unknown, typeof ctx]> = [
      ["MAC の末尾", flip(t, t.length - 1), ctx],
      ["MAC の先頭", flip(t, 3 + 22 + 1), ctx],
      ["nonce", flip(t, 3), ctx],
      ["別のユーザー", t, { ...ctx, userId: "stu_2" }],
      ["別のクイズ", t, { ...ctx, quizId: "quiz_2" }],
      ["選択肢の文", t, { ...ctx, questions: [{ id: "q1", options: ["a0", "a1", "a2", "a3 改"] }, questions[1]] }],
      ["選択肢の並び", t, { ...ctx, questions: [{ id: "q1", options: ["a1", "a0", "a2", "a3"] }, questions[1]] }],
      ["選択肢の追加", t, { ...ctx, questions: [{ id: "q1", options: ["a0", "a1", "a2", "a3", "a4"] }, questions[1]] }],
      ["問題の削除", t, { ...ctx, questions: [questions[0]] }],
      ["問題の id", t, { ...ctx, questions: [questions[0], { id: "q9", options: ["b0", "b1"] }] }],
    ];
    for (const [label, token, c] of cases) {
      assert.equal(verifyAttemptToken(KEYS, token, c), null, label);
    }
    assert.equal(verifyAttemptToken(deriveQuizKeys("another-dummy-secret"), t, ctx), null, "別の鍵");
  });

  it("形の違うトークン（文字列でない・版が違う・長さが違う・記号）は null", () => {
    const t = issueAttemptToken(KEYS, ctx, fixedNonce(3));
    for (const bad of [undefined, null, 1, {}, "", t.replace(/^v1/, "v2"), t + "A", t.slice(0, -1), t.replace(/\.[^.]*$/, ".=" + "A".repeat(42)), ` ${t}`, `${t}\n`, `${t}​`]) {
      assert.equal(verifyAttemptToken(KEYS, bad, ctx), null, JSON.stringify(bad));
      assert.ok(!isAttemptTokenFormat(bad), `形として通った: ${JSON.stringify(bad)}`);
    }
  });
});

describe("import の境界（node:crypto をクライアントに入れない）", () => {
  const root = join(__dirname, "..", "..");
  const importsOf = (rel: string) => {
    const src = readFileSync(join(root, rel), "utf8");
    return Array.from(src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g), (m) => m[1]);
  };

  for (const rel of ["src/app/page.tsx", "src/lib/student-quizzes.ts"]) {
    it(`${rel} は quiz-shuffle・quiz-shuffle-key・node:crypto を import しない`, () => {
      const specs = importsOf(rel);
      assert.ok(specs.length > 0, `${rel} の import を読めていない`);
      for (const s of specs) {
        assert.doesNotMatch(s, /quiz-shuffle/, `${rel} が ${s} を import している`);
        assert.doesNotMatch(s, /^(node:)?crypto$/, `${rel} が ${s} を import している`);
      }
    });
  }
});
