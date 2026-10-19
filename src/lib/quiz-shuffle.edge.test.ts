import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  SHUFFLE_KEY_INFO,
  TOKEN_KEY_INFO,
  deriveQuizKeys,
  issueAttemptToken,
  optionPermutation,
  toOriginalAnswers,
  verifyAttemptToken,
} from "./quiz-shuffle";
import { QuizKeyUnavailableError, quizKeys } from "./quiz-shuffle-key";
import { isAttemptTokenFormat } from "./student-quizzes";

// #51 選択肢のシャッフルの補強（quiz-shuffle.test.ts の続き。テスト担当が追加）。
// - 統計テストの臨界値そのものの妥当性（カイ二乗分布の上側確率を数値計算で確かめる）と、検出力（偏った並べ替えなら落ちる）
// - 設計どおりの手順か（設計メモの式を別に実装した参照実装と突き合わせる）
// - 棄却法が働いていること（HMAC の出力を差し替え、棄却される値を強制的に出す）
// - 元の並びが推定できないこと（どの選択肢も表示位置が一様、続けて GET したときの相関がない）
// - トークンの 1 文字変更の総当たり、base64url の別表記、問題文だけの変更（検知しない仕様）
// - 鍵（AUTH_SECRET）が空白だけのとき
// 鍵はダミーの文字列から作る。nonce は決まった列なので、毎回同じ結果になる（たまたま落ちない）。

const DUMMY_SECRET = "dummy-auth-secret-for-shuffle-edge-tests";
const KEYS = deriveQuizKeys(DUMMY_SECRET);
const BASE = { userId: "stu_1", quizId: "quiz_1", questionId: "q_1" };

/** i を 16 バイトに符号化した決まった nonce（base64url 22 字） */
function fixedNonce(i: number): string {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(i, 12);
  return b.toString("base64url");
}

function chiSquare(counts: number[], expected: number): number {
  return counts.reduce((s, c) => s + ((c - expected) ** 2) / expected, 0);
}

function factorial(n: number): number {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

// ───────────── カイ二乗分布の上側確率（臨界値の確認用） ─────────────

/** ln Γ(x)（Lanczos 近似、g = 7） */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const xx = x - 1;
  let a = c[0];
  const t = xx + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 正則化された上側不完全ガンマ関数 Q(a, x)（級数と連分数。Numerical Recipes の方法） */
function gammaQ(a: number, x: number): number {
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n < 10_000; n++) {
      del *= x / (a + n);
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10_000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** 自由度 df のカイ二乗分布で、値が x 以上になる確率 */
const chiSquareSurvival = (df: number, x: number) => gammaQ(df / 2, x / 2);

describe("統計テストの臨界値の妥当性（p = 0.001）", () => {
  it("計算方法の確認：自由度 2 の上側確率は exp(-x/2)、自由度 1 の 3.841 は 0.05", () => {
    for (const x of [0.5, 2, 13.816, 30]) {
      assert.ok(Math.abs(chiSquareSurvival(2, x) - Math.exp(-x / 2)) < 1e-12, `自由度 2、x=${x} の上側確率が合わない`);
    }
    assert.ok(Math.abs(chiSquareSurvival(1, 3.841459) - 0.05) < 1e-6, "自由度 1 の 3.841 が 0.05 にならない");
  });

  // quiz-shuffle.test.ts（CHI2_CRITICAL_0_001 と 2 問の独立の 37.697）と quizzes-route.test.ts（16.266）で使っている値
  for (const [df, crit] of [
    [1, 10.828],
    [2, 13.816],
    [3, 16.266],
    [4, 18.467],
    [5, 20.515],
    [15, 37.697],
    [23, 49.728],
    [119, 172.5],
  ] as Array<[number, number]>) {
    it(`自由度 ${df} の臨界値 ${crit} の上側確率はほぼ 0.001（甘すぎず、厳しすぎない）`, () => {
      const p = chiSquareSurvival(df, crit);
      assert.ok(p > 0.0009 && p < 0.0011, `自由度 ${df}、臨界値 ${crit} の上側確率が ${p}（0.001 から離れている）`);
    });
  }
});

// ───────────── 参照実装（設計メモの式をそのまま書いたもの） ─────────────

function refKeys(secret: string) {
  const derive = (info: string) => Buffer.from(crypto.hkdfSync("sha256", secret, "nwa-lms", info, 32));
  return { shuffleKey: derive("nwa-lms quiz option shuffle v1"), tokenKey: derive("nwa-lms quiz attempt token v1") };
}

function refPermutation(key: Buffer, userId: string, quizId: string, questionId: string, nonce: string, n: number): number[] {
  const seed = crypto.createHmac("sha256", key).update(JSON.stringify(["v1", userId, quizId, questionId, nonce, n])).digest();
  const values: number[] = [];
  let counter = 0;
  const next = () => {
    if (values.length === 0) {
      const c = Buffer.alloc(4);
      c.writeUInt32BE(counter++);
      const block = crypto.createHmac("sha256", key).update(Buffer.concat([seed, c])).digest();
      for (let k = 0; k < 32; k += 4) values.push(block.readUInt32BE(k));
    }
    return values.shift()!;
  };
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i >= 1; i--) {
    const range = i + 1;
    const limit = 2 ** 32 - (2 ** 32 % range);
    let x = next();
    while (x >= limit) x = next();
    const j = x % range;
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

function refToken(secret: string, userId: string, quizId: string, nonce: string, questions: Array<{ id: string; options: string[] }>) {
  const { tokenKey } = refKeys(secret);
  const digest = crypto.createHmac("sha256", tokenKey).update(JSON.stringify(questions.map((q) => [q.id, q.options]))).digest("base64url");
  const mac = crypto.createHmac("sha256", tokenKey).update(JSON.stringify(["v1", userId, quizId, nonce, digest])).digest("base64url");
  return `v1.${nonce}.${mac}`;
}

describe("設計どおりの手順か（参照実装と一致する）", () => {
  it("鍵：HKDF-SHA256、salt = nwa-lms、info は用途ごと、32 バイト", () => {
    const ref = refKeys(DUMMY_SECRET);
    assert.ok(KEYS.shuffleKey.equals(ref.shuffleKey), "shuffleKey が設計の式と違う");
    assert.ok(KEYS.tokenKey.equals(ref.tokenKey), "tokenKey が設計の式と違う");
    assert.equal(SHUFFLE_KEY_INFO, "nwa-lms quiz option shuffle v1");
    assert.equal(TOKEN_KEY_INFO, "nwa-lms quiz attempt token v1");
  });

  it("並べ替え：n = 1〜8、記号を含む id でも、参照実装と同じ順列", () => {
    const ids = [BASE, { userId: 'u"1', quizId: "q\\1", questionId: "問,1" }, { userId: "a", quizId: "b", questionId: "c" }];
    for (const id of ids) {
      for (let n = 1; n <= 8; n++) {
        for (let i = 0; i < 300; i++) {
          const nonce = fixedNonce(i);
          assert.deepEqual(
            optionPermutation(KEYS.shuffleKey, { ...id, nonce, n }),
            refPermutation(KEYS.shuffleKey, id.userId, id.quizId, id.questionId, nonce, n),
            `n=${n} i=${i} ${JSON.stringify(id)}`
          );
        }
      }
    }
  });

  it("トークン：v1.<nonce>.<HMAC(k_token, [v1, userId, quizId, nonce, digest])>（digest はトークンに入れない）", () => {
    const qs = [{ id: "q1", options: ["a", "b", "c"] }, { id: "q2", options: ["x", "y"] }];
    for (let i = 0; i < 50; i++) {
      const nonce = fixedNonce(i);
      assert.equal(issueAttemptToken(KEYS, { userId: "stu_1", quizId: "quiz_1", questions: qs }, nonce), refToken(DUMMY_SECRET, "stu_1", "quiz_1", nonce, qs));
    }
  });

  it("userId と quizId を入れ替えても、連結のあいまいさで同じ並べ替え・トークンにならない", () => {
    const qs = [{ id: "q1", options: ["a", "b"] }];
    const t = issueAttemptToken(KEYS, { userId: "ab", quizId: "c", questions: qs }, fixedNonce(1));
    assert.equal(verifyAttemptToken(KEYS, t, { userId: "a", quizId: "bc", questions: qs }), null, "userId と quizId の境目をずらしても通った");
    assert.equal(verifyAttemptToken(KEYS, t, { userId: "c", quizId: "ab", questions: qs }), null, "userId と quizId を入れ替えても通った");
    let same = 0;
    for (let i = 0; i < 1000; i++) {
      const a = optionPermutation(KEYS.shuffleKey, { userId: "ab", quizId: "c", questionId: "q", nonce: fixedNonce(i), n: 4 }).join();
      const b = optionPermutation(KEYS.shuffleKey, { userId: "a", quizId: "bc", questionId: "q", nonce: fixedNonce(i), n: 4 }).join();
      if (a === b) same++;
    }
    // 独立なら一致は約 1/24（約 42 回）
    assert.ok(same < 100, `境目をずらした入力で並べ替えが一致しすぎる（${same}/1000）`);
  });
});

// ───────────── 棄却法 ─────────────

/**
 * crypto.createHmac を差し替え、digest の出力を決まった列にする。update に渡されたデータを記録する。
 * 1 個目は種、2 個目以降は乱数のブロック（uint32 × 8）
 */
function withFakeHmac(blocks: number[][], fn: (updates: Buffer[]) => void) {
  const queue = [Buffer.alloc(32, 0x5a), ...blocks.map((vs) => {
    const b = Buffer.alloc(32);
    vs.forEach((v, k) => b.writeUInt32BE(v, k * 4));
    return b;
  })];
  const updates: Buffer[] = [];
  const m = mock.method(crypto, "createHmac", () => {
    const h = {
      update(data: string | Buffer) {
        updates.push(Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, "utf8"));
        return h;
      },
      digest() {
        const next = queue.shift();
        assert.ok(next, "用意したブロックより多く HMAC を呼んだ");
        return Buffer.from(next);
      },
    };
    return h;
  });
  try {
    fn(updates);
  } finally {
    m.mock.restore();
  }
}

const MAX = 0xffffffff;
const perm = (n: number) => optionPermutation(KEYS.shuffleKey, { ...BASE, nonce: fixedNonce(0), n });

describe("棄却法：剰余の偏りを除く（HMAC の出力を差し替えて確かめる）", () => {
  it("前提：差し替えが効いている（同じブロックなら同じ順列、差し替えをやめれば元に戻る）", () => {
    const real = perm(4);
    let a: number[] = [];
    let b: number[] = [];
    withFakeHmac([[3, 2, 1, 0, 0, 0, 0, 0]], () => (a = perm(4)));
    withFakeHmac([[3, 2, 1, 0, 0, 0, 0, 0]], () => (b = perm(4)));
    assert.deepEqual(a, b);
    assert.deepEqual(perm(4), real);
  });

  it("n = 3：2^32 - 1（3 で割った余りの偏りの範囲）は捨てて引き直す", () => {
    // i = 2（range 3、limit = 2^32 - 1）：MAX は捨てる → 5 % 3 = 2（入れ替えなし）。i = 1：7 % 2 = 1（入れ替えなし）
    withFakeHmac([[MAX, 5, 7, 0, 0, 0, 0, 0]], () => {
      assert.deepEqual(perm(3), [0, 1, 2], "MAX を捨てずに使った（使えば MAX % 3 = 0 で [2, 1, 0] になる）");
    });
  });

  it("n = 3：limit - 1（2^32 - 2）は捨てずに使う（境界）", () => {
    // 0xFFFFFFFE % 3 = 2 → 入れ替えなし。次の 0 % 2 = 0 → perm[1] と perm[0] を入れ替え
    withFakeHmac([[MAX - 1, 0, 9, 9, 9, 9, 9, 9]], () => {
      assert.deepEqual(perm(3), [1, 0, 2]);
    });
  });

  it("n = 6：2^32 % 6 = 4 なので、上の 4 つ（2^32 - 4 以上）を捨て、2^32 - 5 は使う", () => {
    withFakeHmac([[MAX, MAX - 1, MAX - 2, MAX - 3, MAX - 4, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]], () => {
      const p = perm(6);
      // i = 5：MAX - 4 = 4294967291、% 6 = 5 → 入れ替えなし。i = 4..1 は 0 → perm[i] と perm[0] を入れ替え
      const expected = [0, 1, 2, 3, 4, 5];
      for (const [i, j] of [[5, 4294967291 % 6], [4, 0], [3, 0], [2, 0], [1, 0]]) [expected[i], expected[j]] = [expected[j], expected[i]];
      assert.deepEqual(p, expected);
    });
  });

  it("range が 2 のべき（2・4・8）では何も捨てない（MAX もそのまま使う）", () => {
    // n = 2：i = 1、range 2、limit = 2^32 → MAX % 2 = 1（入れ替えなし）
    withFakeHmac([[MAX, 0, 0, 0, 0, 0, 0, 0]], () => assert.deepEqual(perm(2), [0, 1]));
    // n = 2 で 0 なら入れ替える
    withFakeHmac([[0, 0, 0, 0, 0, 0, 0, 0]], () => assert.deepEqual(perm(2), [1, 0]));
  });

  it("1 ブロック（8 個）がすべて捨てられたら、counter = 1 の次のブロックを使う（種 || uint32be(counter)）", () => {
    withFakeHmac([new Array(8).fill(MAX), [5, 7, 0, 0, 0, 0, 0, 0]], (updates) => {
      assert.deepEqual(perm(3), [0, 1, 2]);
      assert.equal(updates.length, 3, "HMAC の呼び出しが 種・ブロック 0・ブロック 1 の 3 回でない");
      assert.deepEqual(JSON.parse(updates[0].toString("utf8")), ["v1", BASE.userId, BASE.quizId, BASE.questionId, fixedNonce(0), 3]);
      const seed = Buffer.alloc(32, 0x5a);
      assert.ok(updates[1].equals(Buffer.concat([seed, Buffer.from([0, 0, 0, 0])])), "ブロック 0 が 種 || 00000000 でない");
      assert.ok(updates[2].equals(Buffer.concat([seed, Buffer.from([0, 0, 0, 1])])), "ブロック 1 が 種 || 00000001 でない");
    });
  });

  it("n = 1 は乱数を使わない（種の HMAC だけ）", () => {
    withFakeHmac([], (updates) => {
      assert.deepEqual(perm(1), [0]);
      assert.equal(updates.length, 1);
    });
  });
});

// ───────────── 元の並びが推定できない ─────────────

describe("元の並びが推定できない（決まった nonce の列、カイ二乗 p = 0.001）", () => {
  // 自由度 n - 1 の臨界値
  const CRIT: Record<number, number> = { 1: 10.828, 2: 13.816, 3: 16.266, 4: 18.467 };

  for (const n of [2, 3, 4, 5]) {
    it(`n=${n}：どの元の選択肢も、表示位置が一様（ある選択肢がいつも同じ位置に出ない）`, () => {
      const trials = 6000 * n;
      const counts = Array.from({ length: n }, () => new Array<number>(n).fill(0));
      for (let i = 0; i < trials; i++) {
        const p = optionPermutation(KEYS.shuffleKey, { ...BASE, nonce: fixedNonce(i), n });
        p.forEach((orig, shown) => counts[orig][shown]++);
      }
      counts.forEach((c, orig) => {
        const chi = chiSquare(c, trials / n);
        assert.ok(chi < CRIT[n - 1], `n=${n} の元の位置 ${orig} の表示位置が一様でない（${c.join(",")}、χ²=${chi.toFixed(2)}）`);
      });
      // 表示位置 0 に出る元の選択肢も一様
      const atZero = counts.map((c) => c[0]);
      const chi0 = chiSquare(atZero, trials / n);
      assert.ok(chi0 < CRIT[n - 1], `n=${n} の表示位置 0 に出る元の選択肢が一様でない（${atZero.join(",")}）`);
    });
  }

  it("続けて GET した（隣り合う nonce の）2 回の、元の位置 0 の表示位置の組が一様（前回の並びから次が分からない）", () => {
    const trials = 16_000;
    const counts = new Array<number>(16).fill(0);
    let prev = optionPermutation(KEYS.shuffleKey, { ...BASE, nonce: fixedNonce(0), n: 4 }).indexOf(0);
    for (let i = 1; i <= trials; i++) {
      const cur = optionPermutation(KEYS.shuffleKey, { ...BASE, nonce: fixedNonce(i), n: 4 }).indexOf(0);
      counts[prev * 4 + cur]++;
      prev = cur;
    }
    const chi = chiSquare(counts, trials / 16);
    assert.ok(chi < 37.697, `隣り合う GET の並べ替えに相関がある（χ²=${chi.toFixed(2)}）`);
  });

  it("同じ受験の 5 問のどの 2 問の組でも、元の位置 0 の表示位置は独立", () => {
    const trials = 16_000;
    const qids = ["zq1", "zq2", "zq3", "zq4", "zq5"];
    const pos = Array.from({ length: trials }, (_, i) =>
      qids.map((questionId) => optionPermutation(KEYS.shuffleKey, { ...BASE, questionId, nonce: fixedNonce(i), n: 4 }).indexOf(0))
    );
    for (let a = 0; a < qids.length; a++) {
      for (let b = a + 1; b < qids.length; b++) {
        const counts = new Array<number>(16).fill(0);
        for (const p of pos) counts[p[a] * 4 + p[b]]++;
        const chi = chiSquare(counts, trials / 16);
        assert.ok(chi < 37.697, `${qids[a]} と ${qids[b]} の並べ替えが独立でない（χ²=${chi.toFixed(2)}）`);
      }
    }
  });

  it("ユーザーが違えば、同じ nonce でも並べ替えは独立（組の 16 区分が一様）", () => {
    const trials = 16_000;
    const counts = new Array<number>(16).fill(0);
    for (let i = 0; i < trials; i++) {
      const a = optionPermutation(KEYS.shuffleKey, { ...BASE, userId: "stu_a", nonce: fixedNonce(i), n: 4 }).indexOf(0);
      const b = optionPermutation(KEYS.shuffleKey, { ...BASE, userId: "stu_b", nonce: fixedNonce(i), n: 4 }).indexOf(0);
      counts[a * 4 + b]++;
    }
    const chi = chiSquare(counts, trials / 16);
    assert.ok(chi < 37.697, `ユーザーの違う並べ替えが独立でない（χ²=${chi.toFixed(2)}）`);
  });
});

describe("統計テストの検出力（偏った並べ替えなら同じ試行回数で落ちる）", () => {
  /** 決まった乱数列（テスト側の HMAC）で回す、よくある誤った並べ替え */
  const stream = (i: number) => {
    let k = 0;
    return () => crypto.createHmac("sha256", "power-check").update(`${i}:${k++}`).digest().readUInt32BE(0);
  };
  const naive = (n: number, next: () => number) => {
    // 誤り：j を 0..n-1 全体から選ぶ（n^n 通りが n! に均等に割れない）
    const p = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i >= 0; i--) {
      const j = next() % n;
      [p[i], p[j]] = [p[j], p[i]];
    }
    return p;
  };

  for (const n of [3, 4]) {
    it(`n=${n}：j を全体から選ぶ誤った並べ替えは、quiz-shuffle.test.ts と同じ回数・臨界値で一様でないと分かる`, () => {
      const trials = n === 4 ? 24_000 : 12_000;
      const perms = factorial(n);
      const counts = new Map<string, number>();
      for (let i = 0; i < trials; i++) {
        const k = naive(n, stream(i)).join();
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const chi = chiSquare(Array.from(counts.values()), trials / perms);
      const crit = n === 4 ? 49.728 : 20.515;
      assert.ok(chi > crit, `誤った並べ替えを見分けられない（χ²=${chi.toFixed(2)}、臨界値 ${crit}）`);
    });
  }
});

// ───────────── トークン ─────────────

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

describe("トークン：改ざんの総当たりと別表記", () => {
  const questions = [
    { id: "q1", options: ["a0", "a1", "a2", "a3"] },
    { id: "q2", options: ["b0", "b1"] },
  ];
  const ctx = { userId: "stu_1", quizId: "quiz_1", questions };
  const nonce = fixedNonce(42);
  const token = issueAttemptToken(KEYS, ctx, nonce);

  it("nonce・MAC のどの 1 文字を、どの文字に変えても通らない（形は正しいまま）", () => {
    let tried = 0;
    for (let at = 3; at < token.length; at++) {
      if (token[at] === ".") continue;
      for (const ch of ALPHABET) {
        if (ch === token[at]) continue;
        const t = token.slice(0, at) + ch + token.slice(at + 1);
        assert.ok(isAttemptTokenFormat(t), `形が崩れた（位置 ${at}）`);
        assert.equal(verifyAttemptToken(KEYS, t, ctx), null, `位置 ${at} を ${ch} に変えたトークンが通った`);
        tried++;
      }
    }
    assert.equal(tried, (22 + 43) * 63);
  });

  it("base64url の別表記（末尾の使われないビットだけを変えた、同じバイト列になる文字列）でも通らない", () => {
    const [, n, mac] = token.split(".");
    const flipLow = (s: string) => s.slice(0, -1) + ALPHABET[ALPHABET.indexOf(s[s.length - 1]) ^ 1];
    const altNonce = flipLow(n);
    const altMac = flipLow(mac);
    // 別表記であることの確認（Node の base64url は使われないビットを無視する）
    assert.ok(Buffer.from(altNonce, "base64url").equals(Buffer.from(n, "base64url")), "nonce の別表記が同じバイト列にならない");
    assert.ok(Buffer.from(altMac, "base64url").equals(Buffer.from(mac, "base64url")), "MAC の別表記が同じバイト列にならない");
    assert.notEqual(altNonce, n);
    assert.notEqual(altMac, mac);
    assert.equal(verifyAttemptToken(KEYS, `v1.${altNonce}.${mac}`, ctx), null, "nonce の別表記で通った");
    assert.equal(verifyAttemptToken(KEYS, `v1.${n}.${altMac}`, ctx), null, "MAC の別表記で通った");
  });

  it("標準の base64（+ /）・パディング（=）・大文字の V1 は形で弾く", () => {
    const [, n, mac] = token.split(".");
    for (const bad of [
      `v1.${n.slice(0, -1)}+.${mac}`,
      `v1.${n}.${mac.slice(0, -1)}/`,
      `v1.${n}==.${mac}`,
      `v1.${n}.${mac}=`,
      `V1.${n}.${mac}`,
      `v1.${n}..${mac}`,
      `v1.${n}.${mac}.`,
      `v1.${n}.${mac}\u0000`,
      `v1.${n}.${mac}\u200b`,
      `\ufeffv1.${n}.${mac}`,
    ]) {
      assert.ok(!isAttemptTokenFormat(bad), `形として通った: ${JSON.stringify(bad)}`);
      assert.equal(verifyAttemptToken(KEYS, bad, ctx), null, JSON.stringify(bad));
    }
  });

  it("選択肢の削除・文の前後の空白・同じ文の重複でも通らない。問題の順の入れ替えも通らない", () => {
    for (const [label, qs] of [
      ["選択肢の削除", [{ id: "q1", options: ["a0", "a1", "a2"] }, questions[1]]],
      ["文の末尾に空白", [{ id: "q1", options: ["a0", "a1", "a2", "a3 "] }, questions[1]]],
      ["文の重複", [{ id: "q1", options: ["a0", "a1", "a2", "a2"] }, questions[1]]],
      ["問題の順", [questions[1], questions[0]]],
      ["選択肢を別の問題へ移す", [{ id: "q1", options: ["a0", "a1", "a2"] }, { id: "q2", options: ["a3", "b0", "b1"] }]],
    ] as Array<[string, typeof questions]>) {
      assert.equal(verifyAttemptToken(KEYS, token, { ...ctx, questions: qs }), null, label);
    }
  });

  it("問題文は MAC に入らない（問題文だけの変更は検知しない仕様）。DigestQuestion に余分な項目があっても結果は同じ", () => {
    const withText = questions.map((q, i) => ({ ...q, question: `変更後の問題文${i}` }));
    assert.equal(verifyAttemptToken(KEYS, token, { ...ctx, questions: withText }), nonce);
  });

  it("有効期限はない（時刻を進めても同じトークンが通る）", () => {
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 365 * 24 * 3_600_000;
      assert.equal(verifyAttemptToken(KEYS, token, ctx), nonce);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("toOriginalAnswers：整数でない表示位置", () => {
  it("1.5・NaN・Infinity・文字列は例外（parseSubmitAnswers を通らなかった値を元の位置に戻さない）", () => {
    const qs = [{ id: "q1", optionCount: 4 }];
    const ctx = { userId: "stu_1", quizId: "quiz_1", nonce: fixedNonce(1) };
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, "1" as unknown as number, 4]) {
      assert.throws(() => toOriginalAnswers(KEYS.shuffleKey, ctx, qs, [bad]), `${String(bad)} で例外にならない`);
    }
  });
});

// ───────────── 鍵 ─────────────

describe("quizKeys：空白だけの AUTH_SECRET", () => {
  // 依頼の観点 5「AUTH_SECRET 未設定・空・空白だけで 500」。空白だけの値からも鍵を作らない
  it(
    "空白・タブ・改行・全角空白だけなら QuizKeyUnavailableError",
    () => {
      for (const s of [" ", "   ", "\t", "\n", "\u3000", " \t\n"]) {
        assert.throws(() => quizKeys({ AUTH_SECRET: s }), QuizKeyUnavailableError, `${JSON.stringify(s)} から鍵を作った`);
      }
    }
  );

  it("例外のメッセージ・スタックに環境変数の値を含まない", () => {
    const secretLike = "dummy-secret-value-should-not-appear";
    for (const env of [{}, { AUTH_SECRET: "" }, { NEXTAUTH_SECRET: secretLike }, { AUTH_SECRET: undefined, OTHER: secretLike }]) {
      try {
        quizKeys(env);
        assert.fail("例外にならない");
      } catch (e) {
        assert.ok(e instanceof QuizKeyUnavailableError, "QuizKeyUnavailableError でない");
        assert.ok(!String(e.stack).includes(secretLike), "スタックに値が出た");
        assert.ok(!e.message.includes("AUTH_SECRET="), "メッセージに値の形が出た");
      }
    }
  });
});

describe("import の境界（補強）", () => {
  const root = join(__dirname, "..", "..");
  const specs = (rel: string) =>
    Array.from(readFileSync(join(root, rel), "utf8").matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g), (m) => m[1]);

  it("quiz-shuffle.ts が import するのは node:crypto と ./student-quizzes だけ（prisma・auth を持ち込まない）", () => {
    assert.deepEqual(specs("src/lib/quiz-shuffle.ts").sort(), ["./student-quizzes", "node:crypto"]);
  });

  it("quiz-shuffle-key.ts が import するのは ./quiz-shuffle だけ", () => {
    assert.deepEqual(specs("src/lib/quiz-shuffle-key.ts"), ["./quiz-shuffle"]);
  });

  it("鍵（quiz-shuffle-key）を使うのは GET の route と quiz-submit だけ。submit の route は使わない", () => {
    for (const rel of ["src/app/api/quizzes/[quizId]/route.ts", "src/lib/quiz-submit.ts"]) {
      assert.ok(specs(rel).includes("@/lib/quiz-shuffle-key"), `${rel} が quiz-shuffle-key を import していない`);
    }
    for (const rel of ["src/app/api/quizzes/[quizId]/submit/route.ts", "src/app/api/quizzes/route.ts", "src/app/page.tsx", "src/lib/student-quizzes.ts"]) {
      assert.ok(!specs(rel).some((s) => /quiz-shuffle/.test(s)), `${rel} が quiz-shuffle を import している`);
    }
  });

  it("page.tsx と student-quizzes.ts は crypto（globalThis.crypto を含む）も Math.random も使わない", () => {
    for (const rel of ["src/app/page.tsx", "src/lib/student-quizzes.ts"]) {
      const src = readFileSync(join(root, rel), "utf8");
      assert.doesNotMatch(src, /\bcrypto\.|createHmac|hkdf|Math\.random/, `${rel} が乱数・暗号を使っている`);
    }
  });

  it("process.env.AUTH_SECRET を読むのは quiz-shuffle-key.ts だけ（src の中、テストを除く）", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) files.push(p);
      }
    };
    walk(join(root, "src"));
    const readers = files
      .filter((f) => /AUTH_SECRET/.test(readFileSync(f, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")))
      .map((f) => f.slice(root.length + 1));
    assert.deepEqual(readers, ["src/lib/quiz-shuffle-key.ts"]);
  });
});
