import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BADGE_MAX,
  MARK_READ_MAX_IDS,
  formatBadgeCount,
  parseMarkReadBody,
  readMarkReadResponse,
  readUnreadCountResponse,
  toUnreadCount,
  unreadBadgeLabel,
  unreadIdsToMark,
} from "./notification-read";

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
    const invisible = ["\u200B", "\u3000", "\u00A0", "\uFEFF", "\u200B\u200B"];
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

  it("同じ id が 10 万個でも 1 件にまとまる", () => {
    const res = parseMarkReadBody({ ids: Array(100_000).fill("n1") });
    assert.deepEqual(res, { ok: true, value: { ids: ["n1"] } });
  });

  it("別々の id が 10 万個なら invalid_ids", () => {
    const res = parseMarkReadBody({ ids: ids(100_000) });
    assert.deepEqual(res, { ok: false, reason: "invalid_ids" });
  });

  it("末尾だけ不正な要素があっても invalid_ids（上限に達するまでの要素は全部検査する）", () => {
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

describe("toUnreadCount", () => {
  it("0 以上の安全な整数だけを返す", () => {
    for (const v of [0, 1, 9, 10, 51, Number.MAX_SAFE_INTEGER]) assert.equal(toUnreadCount(v), v, String(v));
  });

  it("負数・小数・NaN・Infinity・安全でない整数・数値でないものは null", () => {
    for (const v of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "3", null, undefined, true, {}, [], new Number(3), BigInt(3)]) {
      assert.equal(toUnreadCount(v), null, String(v));
    }
  });
});

describe("readUnreadCountResponse", () => {
  it("{ count } の件数を返す（0 も件数として返す）", () => {
    assert.equal(readUnreadCountResponse({ count: 0 }), 0);
    assert.equal(readUnreadCountResponse({ count: 12 }), 12);
  });

  it("形が違う応答は null（エラー応答・配列・数値だけ・不正な count）", () => {
    for (const body of [null, undefined, 3, "3", [], [3], { error: "Unauthorized" }, { count: "3" }, { count: -1 }, { count: 1.5 }, { unreadCount: 3 }]) {
      assert.equal(readUnreadCountResponse(body), null, JSON.stringify(body) ?? String(body));
    }
  });
});

describe("readMarkReadResponse", () => {
  it("{ updated, unreadCount } の unreadCount を返す", () => {
    assert.equal(readMarkReadResponse({ updated: 2, unreadCount: 0 }), 0);
    assert.equal(readMarkReadResponse({ updated: 50, unreadCount: 7 }), 7);
  });

  it("unreadCount がない・不正なら null（updated や count は使わない）", () => {
    for (const body of [null, undefined, [], { updated: 2 }, { count: 0 }, { error: "Invalid request", reason: "invalid_ids" }, { unreadCount: "0" }, { unreadCount: -1 }, { unreadCount: NaN }]) {
      assert.equal(readMarkReadResponse(body), null, JSON.stringify(body) ?? String(body));
    }
  });
});

describe("unreadIdsToMark", () => {
  it("unread が true の行の id だけを順に集める", () => {
    const items = [
      { id: "a", unread: true },
      { id: "b", unread: false },
      { id: "c", unread: true },
    ];
    assert.deepEqual(unreadIdsToMark(items), ["a", "c"]);
  });

  it("未読がなければ空配列（API を呼ばない判定に使う）", () => {
    assert.deepEqual(unreadIdsToMark([{ id: "a", unread: false }]), []);
    assert.deepEqual(unreadIdsToMark([]), []);
  });

  it("配列でなければ空配列", () => {
    for (const v of [null, undefined, "a", 1, { id: "a", unread: true }]) {
      assert.deepEqual(unreadIdsToMark(v as never), [], String(v));
    }
  });

  it("unread が true でない（真と評価される値を含む）・要素がオブジェクトでなければ飛ばす", () => {
    const items = [
      { id: "a", unread: 1 },
      { id: "b", unread: "true" },
      { id: "c" },
      null,
      "d",
      ["e"],
      { id: "f", unread: true },
    ];
    assert.deepEqual(unreadIdsToMark(items as never), ["f"]);
  });

  it("空文字・65 文字・文字列でない id は飛ばし、64 文字は使う", () => {
    const long64 = "x".repeat(64);
    const items = [
      { id: "", unread: true },
      { id: "y".repeat(65), unread: true },
      { id: 1, unread: true },
      { id: null, unread: true },
      { id: long64, unread: true },
    ];
    assert.deepEqual(unreadIdsToMark(items), [long64]);
  });

  it("重複は最初の 1 つだけ", () => {
    const items = [
      { id: "a", unread: true },
      { id: "a", unread: true },
      { id: "b", unread: true },
    ];
    assert.deepEqual(unreadIdsToMark(items), ["a", "b"]);
  });

  it(`最大 ${MARK_READ_MAX_IDS} 件（API の上限）で打ち切り、結果は parseMarkReadBody を通る`, () => {
    const items = ids(MARK_READ_MAX_IDS + 5).map((id) => ({ id, unread: true }));
    const got = unreadIdsToMark(items);
    assert.equal(got.length, MARK_READ_MAX_IDS);
    assert.deepEqual(got, ids(MARK_READ_MAX_IDS));
    assert.deepEqual(parseMarkReadBody({ ids: got }), { ok: true, value: { ids: got } });
  });
});

describe("unreadBadgeLabel", () => {
  it("バッジを出すときは実際の件数を読む（9+ でも件数そのまま）", () => {
    assert.equal(unreadBadgeLabel(1), "未読 1 件");
    assert.equal(unreadBadgeLabel(BADGE_MAX), `未読 ${BADGE_MAX} 件`);
    assert.equal(unreadBadgeLabel(12), "未読 12 件");
  });

  it("バッジを出さないとき（0・負数・不正）は null", () => {
    for (const v of [0, -1, 1.5, NaN, null, undefined, "3"]) assert.equal(unreadBadgeLabel(v), null, String(v));
  });
});
