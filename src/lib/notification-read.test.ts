import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BADGE_MAX, MARK_READ_MAX_IDS, formatBadgeCount, parseMarkReadBody } from "./notification-read";

// #62 未読件数バッジと既読化 API の純粋関数。DB・ネットワーク・DOM なし。データはすべてダミー。

const ids = (n: number, prefix = "n") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("parseMarkReadBody：body", () => {
  it("オブジェクトでなければ invalid_body", () => {
    for (const body of [null, undefined, "x", 1, true, [], [["n1"]]]) {
      assert.deepEqual(parseMarkReadBody(body), { ok: false, reason: "invalid_body" }, JSON.stringify(body) ?? String(body));
    }
  });

  it("ids 以外の項目（userId など）は無視し、結果に含めない", () => {
    const res = parseMarkReadBody({ ids: ["n1"], userId: "stu_other", all: true });
    assert.deepEqual(res, { ok: true, value: { ids: ["n1"] } });
  });
});

describe("parseMarkReadBody：ids", () => {
  it("ids がない・配列でなければ invalid_ids", () => {
    for (const v of [undefined, null, "n1", 1, { 0: "n1" }]) {
      assert.deepEqual(parseMarkReadBody({ ids: v }), { ok: false, reason: "invalid_ids" }, String(v));
    }
    assert.deepEqual(parseMarkReadBody({}), { ok: false, reason: "invalid_ids" });
  });

  it("0 件は invalid_ids", () => {
    assert.deepEqual(parseMarkReadBody({ ids: [] }), { ok: false, reason: "invalid_ids" });
  });

  it("1 件と 50 件は通る", () => {
    assert.deepEqual(parseMarkReadBody({ ids: ["n1"] }), { ok: true, value: { ids: ["n1"] } });
    assert.equal(MARK_READ_MAX_IDS, 50);
    assert.deepEqual(parseMarkReadBody({ ids: ids(50) }), { ok: true, value: { ids: ids(50) } });
  });

  it("51 件は invalid_ids", () => {
    assert.deepEqual(parseMarkReadBody({ ids: ids(51) }), { ok: false, reason: "invalid_ids" });
  });

  it("重複は最初に出た順で 1 つにまとめる", () => {
    assert.deepEqual(parseMarkReadBody({ ids: ["n2", "n1", "n2", "n1", "n3"] }), { ok: true, value: { ids: ["n2", "n1", "n3"] } });
  });

  it("重複を除いて 50 件以下なら、元の配列が 51 件以上でも通る", () => {
    const res = parseMarkReadBody({ ids: [...ids(50), "n0", "n1"] });
    assert.deepEqual(res, { ok: true, value: { ids: ids(50) } });
  });

  it("要素が string でなければ invalid_ids", () => {
    for (const bad of [1, null, undefined, {}, ["n1"], true]) {
      assert.deepEqual(parseMarkReadBody({ ids: ["n1", bad] }), { ok: false, reason: "invalid_ids" }, String(bad));
    }
  });

  it("空文字は invalid_ids", () => {
    assert.deepEqual(parseMarkReadBody({ ids: ["n1", ""] }), { ok: false, reason: "invalid_ids" });
  });

  it("64 文字は通り、65 文字は invalid_ids", () => {
    assert.deepEqual(parseMarkReadBody({ ids: ["a".repeat(64)] }), { ok: true, value: { ids: ["a".repeat(64)] } });
    assert.deepEqual(parseMarkReadBody({ ids: ["a".repeat(65)] }), { ok: false, reason: "invalid_ids" });
  });
});

describe("formatBadgeCount", () => {
  it("0・負数は null", () => {
    assert.equal(formatBadgeCount(0), null);
    assert.equal(formatBadgeCount(-0), null);
    assert.equal(formatBadgeCount(-1), null);
    assert.equal(formatBadgeCount(-10), null);
  });

  it("数値でない・NaN・無限大・小数は null", () => {
    for (const v of [NaN, Infinity, -Infinity, 1.5, "1", "10", null, undefined, {}, [], true, BigInt(1)]) {
      assert.equal(formatBadgeCount(v), null, typeof v === "bigint" ? "bigint" : String(v));
    }
  });

  it("1〜9 はそのままの数字", () => {
    assert.equal(BADGE_MAX, 9);
    for (let i = 1; i <= 9; i++) assert.equal(formatBadgeCount(i), String(i));
  });

  it("10 以上は 9+", () => {
    for (const v of [10, 11, 50, 51, 99, 100, 1000]) assert.equal(formatBadgeCount(v), "9+", String(v));
  });
});
