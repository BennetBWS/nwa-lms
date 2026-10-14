import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMMENT_DAILY_LIMIT,
  COMMENT_DUPLICATE_MS,
  COMMENT_INTERVAL_MS,
  COMMENT_WINDOW_MS,
  commentWindowStart,
  decideCommentRate,
} from "./comment-rate-limit";

// #46 質問の投稿の連投の判定（DB・時計なし。現在時刻は引数）

const NOW = new Date("2026-10-09T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const SEC = 1000;
const HOUR = 60 * 60 * SEC;

describe("定数（Tec 決定 2026-10-09）", () => {
  it("30 秒の間隔、24 時間で 20 件、60 秒以内の同じ本文", () => {
    assert.equal(COMMENT_INTERVAL_MS, 30 * SEC);
    assert.equal(COMMENT_WINDOW_MS, 24 * HOUR);
    assert.equal(COMMENT_DAILY_LIMIT, 20);
    assert.equal(COMMENT_DUPLICATE_MS, 60 * SEC);
  });

  it("commentWindowStart は now の 24 時間前", () => {
    assert.equal(commentWindowStart(NOW).toISOString(), "2026-10-08T12:00:00.000Z");
  });
});

describe("decideCommentRate：通る場合", () => {
  it("投稿がなければ ok", () => {
    assert.deepEqual(decideCommentRate([], "質問", NOW), { kind: "ok" });
  });

  it("直前の投稿からちょうど 30 秒なら ok（別の本文）", () => {
    assert.deepEqual(decideCommentRate([{ content: "前の質問", createdAt: ago(30 * SEC) }], "質問", NOW), { kind: "ok" });
  });

  it("24 時間以内に 19 件なら ok", () => {
    const recent = Array.from({ length: 19 }, (_, i) => ({ content: `q${i}`, createdAt: ago(HOUR + i * SEC) }));
    assert.deepEqual(decideCommentRate(recent, "質問", NOW), { kind: "ok" });
  });

  it("ちょうど 24 時間前の投稿は数えない（期間は now - 24 時間より後）", () => {
    const recent = [
      { content: "old", createdAt: ago(24 * HOUR) },
      ...Array.from({ length: 19 }, (_, i) => ({ content: `q${i}`, createdAt: ago(HOUR + i * SEC) })),
    ];
    assert.deepEqual(decideCommentRate(recent, "質問", NOW), { kind: "ok" });
  });

  it("同じ本文でも、ちょうど 60 秒たっていれば ok", () => {
    assert.deepEqual(decideCommentRate([{ content: "質問", createdAt: ago(60 * SEC) }], "質問", NOW), { kind: "ok" });
  });

  it("同じ本文でも、直前ではない投稿なら重複にしない", () => {
    const recent = [
      { content: "質問", createdAt: ago(50 * SEC) },
      { content: "別の質問", createdAt: ago(40 * SEC) },
    ];
    assert.deepEqual(decideCommentRate(recent, "質問", NOW), { kind: "ok" });
  });

  it("日時が不正な行は無視する", () => {
    const recent = [{ content: "質問", createdAt: new Date(Number.NaN) }];
    assert.deepEqual(decideCommentRate(recent, "質問", NOW), { kind: "ok" });
  });
});

describe("decideCommentRate：間隔（429）", () => {
  it("29.001 秒前なら rate_limited で、残りを切り上げて 1 秒", () => {
    assert.deepEqual(decideCommentRate([{ content: "前", createdAt: ago(29_001) }], "質問", NOW), {
      kind: "rate_limited",
      retryAfterSeconds: 1,
    });
  });

  it("10 秒前なら残り 20 秒", () => {
    assert.deepEqual(decideCommentRate([{ content: "前", createdAt: ago(10 * SEC) }], "質問", NOW), {
      kind: "rate_limited",
      retryAfterSeconds: 20,
    });
  });

  it("並び順に関係なく、いちばん新しい投稿で判定する", () => {
    const recent = [
      { content: "古い", createdAt: ago(HOUR) },
      { content: "新しい", createdAt: ago(5 * SEC) },
    ];
    assert.deepEqual(decideCommentRate(recent, "質問", NOW), { kind: "rate_limited", retryAfterSeconds: 25 });
  });

  it("直前の投稿が未来の日時（時計のずれ）なら、経過 0 秒として 30 秒", () => {
    assert.deepEqual(decideCommentRate([{ content: "前", createdAt: ago(-5 * SEC) }], "質問", NOW), {
      kind: "rate_limited",
      retryAfterSeconds: 30,
    });
  });
});

describe("decideCommentRate：1 日の件数（429）", () => {
  it("24 時間以内に 20 件あれば、新しい方から 20 件目が期間外に出るまでの秒数", () => {
    // 20 件目（いちばん古い）は 23 時間前 → 残り 1 時間
    const recent = Array.from({ length: 20 }, (_, i) => ({ content: `q${i}`, createdAt: ago(23 * HOUR - i * 60 * SEC) }));
    assert.deepEqual(decideCommentRate(recent, "質問", NOW), { kind: "rate_limited", retryAfterSeconds: 3600 });
  });

  it("21 件渡されても、新しい方から 20 件目で判定する", () => {
    const recent = Array.from({ length: 21 }, (_, i) => ({ content: `q${i}`, createdAt: ago(HOUR + i * HOUR) }));
    // 20 件目は 20 時間前 → 残り 4 時間
    assert.deepEqual(decideCommentRate(recent, "質問", NOW), { kind: "rate_limited", retryAfterSeconds: 4 * 3600 });
  });

  it("間隔と件数の両方にかかるときは、長い方の秒数", () => {
    const recent = Array.from({ length: 20 }, (_, i) => ({ content: `q${i}`, createdAt: ago(5 * SEC + i * HOUR) }));
    // 間隔：残り 25 秒。件数：20 件目は 19 時間 + 5 秒前 → 残り 5 時間 - 5 秒
    assert.deepEqual(decideCommentRate(recent, "質問", NOW), { kind: "rate_limited", retryAfterSeconds: 5 * 3600 - 5 });
  });

  it("件数の残りが 1 秒未満でも 1 秒以上を返す", () => {
    const recent = Array.from({ length: 20 }, (_, i) => ({ content: `q${i}`, createdAt: ago(24 * HOUR - 1 - i) }));
    const d = decideCommentRate(recent, "質問", NOW);
    assert.equal(d.kind, "rate_limited", "20 件あるので拒否される");
    assert.ok("retryAfterSeconds" in d && d.retryAfterSeconds >= 1, `retryAfterSeconds が 1 未満: ${JSON.stringify(d)}`);
  });
});

describe("decideCommentRate：重複（409）", () => {
  it("60 秒以内に直前と同じ本文なら duplicate（間隔の制限より優先）", () => {
    assert.deepEqual(decideCommentRate([{ content: "質問", createdAt: ago(5 * SEC) }], "質問", NOW), { kind: "duplicate" });
    assert.deepEqual(decideCommentRate([{ content: "質問", createdAt: ago(59_999) }], "質問", NOW), { kind: "duplicate" });
  });

  it("前後の空白を除いて比較する（中の空白・改行は区別する）", () => {
    assert.deepEqual(decideCommentRate([{ content: "  質問\n", createdAt: ago(40 * SEC) }], "質問", NOW), { kind: "duplicate" });
    assert.deepEqual(decideCommentRate([{ content: "質 問", createdAt: ago(40 * SEC) }], "質問", NOW), { kind: "ok" });
  });

  it("1 日の上限に達していても、重複なら duplicate を返す", () => {
    const recent = Array.from({ length: 20 }, (_, i) => ({ content: i === 0 ? "質問" : `q${i}`, createdAt: ago(40 * SEC + i * HOUR) }));
    assert.deepEqual(decideCommentRate(recent, "質問", NOW), { kind: "duplicate" });
  });
});
