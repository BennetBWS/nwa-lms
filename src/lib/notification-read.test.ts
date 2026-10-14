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

// ───────────── 追加（tester、#62）：境界・特殊な文字列・大きな配列 ─────────────

describe("parseMarkReadBody：特殊な body", () => {
  it("JSON.parse した __proto__ キーの ids は継承されず、invalid_ids", () => {
    const body = JSON.parse('{"__proto__":{"ids":["evil"]}}');
    assert.deepEqual(parseMarkReadBody(body), { ok: false, reason: "invalid_ids" });
  });

  it("プロトタイプのないオブジェクトでも ids を読める", () => {
    const body = Object.assign(Object.create(null), { ids: ["n1"] });
    assert.deepEqual(parseMarkReadBody(body), { ok: true, value: { ids: ["n1"] } });
  });

  it("all: true だけでは既読にしない（invalid_ids）", () => {
    assert.deepEqual(parseMarkReadBody({ all: true }), { ok: false, reason: "invalid_ids" });
    assert.deepEqual(parseMarkReadBody({ all: true, userId: "stu_other" }), { ok: false, reason: "invalid_ids" });
  });

  it("疎配列の穴（undefined）は invalid_ids", () => {
    // eslint-disable-next-line no-sparse-arrays
    assert.deepEqual(parseMarkReadBody({ ids: [, "n1"] }), { ok: false, reason: "invalid_ids" });
  });
});

describe("parseMarkReadBody：特殊な id の文字列", () => {
  it("__proto__・constructor・toString などの文字列も、ただの id として扱う", () => {
    const special = ["__proto__", "constructor", "toString", "hasOwnProperty", "prototype"];
    assert.deepEqual(parseMarkReadBody({ ids: [...special, "__proto__"] }), { ok: true, value: { ids: special } });
  });

  it("見えない文字だけの id も、空でなく 64 文字以内なら通る（現状の仕様。DB では一致しないだけ）", () => {
    const invisible = ["​", "　", " ", "﻿", "​​"];
    assert.deepEqual(parseMarkReadBody({ ids: invisible }), { ok: true, value: { ids: invisible } });
  });

  it("長さは UTF-16 の単位で数える（あ 64 文字は通り、サロゲートペア 33 個 = 66 単位は invalid_ids）", () => {
    assert.deepEqual(parseMarkReadBody({ ids: ["あ".repeat(64)] }), { ok: true, value: { ids: ["あ".repeat(64)] } });
    assert.deepEqual(parseMarkReadBody({ ids: ["😀".repeat(32)] }), { ok: true, value: { ids: ["😀".repeat(32)] } });
    assert.deepEqual(parseMarkReadBody({ ids: ["😀".repeat(33)] }), { ok: false, reason: "invalid_ids" });
  });

  it("前後の空白は除かない（\" n1\" と \"n1\" は別の id）", () => {
    assert.deepEqual(parseMarkReadBody({ ids: ["n1", " n1", "n1 "] }), { ok: true, value: { ids: ["n1", " n1", "n1 "] } });
  });
});

describe("parseMarkReadBody：件数の境界と大きな配列", () => {
  it("重複を除いて 51 件になれば、元の配列が何件でも invalid_ids", () => {
    assert.deepEqual(parseMarkReadBody({ ids: [...ids(51), ...ids(51)] }), { ok: false, reason: "invalid_ids" });
  });

  it("重複を除いて 50 件・元の配列が 100 件は通る", () => {
    assert.deepEqual(parseMarkReadBody({ ids: [...ids(50), ...ids(50)] }), { ok: true, value: { ids: ids(50) } });
  });

  it("同じ id が 10 万個でも 1 件にまとまり、1 秒以内に終わる", () => {
    const t = performance.now();
    const res = parseMarkReadBody({ ids: Array(100_000).fill("n1") });
    const ms = performance.now() - t;
    assert.deepEqual(res, { ok: true, value: { ids: ["n1"] } });
    assert.ok(ms < 1000, `10 万件の処理に ${ms.toFixed(1)}ms かかった`);
  });

  it("別々の id が 10 万個なら invalid_ids で、1 秒以内に終わる", () => {
    const t = performance.now();
    const res = parseMarkReadBody({ ids: ids(100_000) });
    const ms = performance.now() - t;
    assert.deepEqual(res, { ok: false, reason: "invalid_ids" });
    assert.ok(ms < 1000, `10 万件の処理に ${ms.toFixed(1)}ms かかった`);
  });

  it("末尾だけ不正な要素があっても invalid_ids（全要素を検査する）", () => {
    assert.deepEqual(parseMarkReadBody({ ids: [...Array(1000).fill("n1"), 1] }), { ok: false, reason: "invalid_ids" });
  });
});

describe("formatBadgeCount：追加の境界", () => {
  it("非常に大きな整数は 9+", () => {
    for (const v of [Number.MAX_SAFE_INTEGER, 1e21, Number.MAX_VALUE]) assert.equal(formatBadgeCount(v), "9+", String(v));
  });

  it("9.0 は 9、0 と 1 の間・9 と 10 の間の小数は null", () => {
    assert.equal(formatBadgeCount(9.0), "9");
    for (const v of [Number.MIN_VALUE, 0.5, 0.9999, 9.5, 9.999]) assert.equal(formatBadgeCount(v), null, String(v));
  });

  it("Number オブジェクト・bigint の 10n は null", () => {
    assert.equal(formatBadgeCount(new Number(3)), null);
    assert.equal(formatBadgeCount(BigInt(10)), null);
  });
});

describe("parseMarkReadBody：上限を超えた時点で止める", () => {
  it("重複を除いて 51 件目が出たら、残りの要素を見ずに invalid_ids を返す", () => {
    const ids: unknown[] = Array.from({ length: MARK_READ_MAX_IDS + 1 }, (_, i) => `n${i}`);
    let touched = false;
    const rest = new Array(10).fill("x");
    const arr = [...ids, ...rest];
    // 52 件目以降を読んだら印を付ける
    Object.defineProperty(arr, MARK_READ_MAX_IDS + 1, {
      get() {
        touched = true;
        return "late";
      },
    });
    assert.deepEqual(parseMarkReadBody({ ids: arr }), { ok: false, reason: "invalid_ids" });
    assert.equal(touched, false, "上限を超えたあとも要素を読んでいる");
  });
});
