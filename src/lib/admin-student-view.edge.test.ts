import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STUDENT_TAB,
  INVITE_BAD_REQUEST_MESSAGE,
  INVITE_DEACTIVATED_UI_MESSAGE,
  STUDENT_TABS,
  confirmMessage,
  countStudentsByTab,
  formatDeactivatedDate,
  inviteErrorView,
  statusActionErrorMessage,
  studentsForTab,
  type AdminStudentRow,
  type StudentTab,
} from "./admin-student-view";
import { studentStatusOf } from "./student-status";
import { INVITE_DEACTIVATED_MESSAGE, INVITE_EXISTS_MESSAGE, inviteConflictFor } from "./student-invite";

// #7 管理画面の受講生表：境界値と、API（PR1）との形の対応。データはすべてダミー。

const active = (id: string, name: string): AdminStudentRow => ({ id, name, status: "active", deactivatedAt: null });
const deactivated = (id: string, name: string, at = "2026-09-01T00:00:00.000Z"): AdminStudentRow => ({
  id,
  name,
  status: "deactivated",
  deactivatedAt: at,
});

const TABS: StudentTab[] = ["active", "deactivated", "all"];

// 英字（サーバーの英語メッセージ）が混ざっていないこと
const NO_ASCII_WORDS = /[A-Za-z]{2,}/;

describe("STUDENT_TABS / DEFAULT_STUDENT_TAB", () => {
  it("タブは 有効・無効・すべて の順で、既定は有効", () => {
    assert.deepEqual(
      STUDENT_TABS.map((t) => t.key),
      ["active", "deactivated", "all"]
    );
    assert.deepEqual(
      STUDENT_TABS.map((t) => t.label),
      ["有効", "無効", "すべて"]
    );
    assert.equal(DEFAULT_STUDENT_TAB, "active");
  });
});

describe("countStudentsByTab（境界）", () => {
  it("全員有効", () => {
    assert.deepEqual(countStudentsByTab([active("a", "あ"), active("b", "い")]), { active: 2, deactivated: 0, all: 2 });
  });

  it("全員無効", () => {
    assert.deepEqual(countStudentsByTab([deactivated("a", "あ"), deactivated("b", "い")]), {
      active: 0,
      deactivated: 2,
      all: 2,
    });
  });

  it("件数は各タブの表示行数と一致する（既知の status のみ）", () => {
    const list = [active("a", "う"), deactivated("b", "あ"), active("c", "い"), deactivated("d", "え"), active("e", "お")];
    const counts = countStudentsByTab(list);
    for (const tab of TABS) {
      assert.equal(studentsForTab(list, tab).length, counts[tab], `tab=${tab}`);
    }
  });
});

describe("未知の status（件数と表示の一致）", () => {
  // 型の上では active / deactivated だけだが、API の応答は実行時に検査されないため未知の値もありうる
  const unknown = (id: string, name: string, status: unknown): AdminStudentRow =>
    ({ id, name, status, deactivatedAt: null }) as unknown as AdminStudentRow;

  it("deactivated 以外の値は有効として数え、有効タブに表示する", () => {
    const list = [
      unknown("u1", "う", "suspended"),
      unknown("u2", "い", ""),
      unknown("u3", "え", "DEACTIVATED"),
      unknown("u4", "お", undefined),
      unknown("u5", "か", null),
      active("a1", "あ"),
      deactivated("d1", "き"),
    ];
    const counts = countStudentsByTab(list);
    assert.deepEqual(counts, { active: 6, deactivated: 1, all: 7 });
    for (const tab of TABS) {
      assert.equal(studentsForTab(list, tab).length, counts[tab], `tab=${tab}`);
    }
    assert.deepEqual(studentsForTab(list, "active").map((s) => s.id), ["a1", "u2", "u1", "u3", "u4", "u5"]);
    assert.deepEqual(studentsForTab(list, "deactivated").map((s) => s.id), ["d1"]);
  });

  it("有効タブと無効タブの行を合わせると、すべてタブの行と過不足なく一致する", () => {
    const list = [unknown("u1", "あ", "pending"), deactivated("d1", "い"), active("a1", "う")];
    const split = [...studentsForTab(list, "active"), ...studentsForTab(list, "deactivated")].map((s) => s.id);
    assert.deepEqual(split, studentsForTab(list, "all").map((s) => s.id));
  });
});

describe("studentsForTab（境界）", () => {
  it("空配列はどのタブでも空", () => {
    for (const tab of TABS) assert.deepEqual(studentsForTab([], tab), []);
  });

  it("全員有効なら無効タブは空、全員無効なら有効タブは空", () => {
    const allActive = [active("a", "い"), active("b", "あ")];
    assert.deepEqual(studentsForTab(allActive, "deactivated"), []);
    assert.deepEqual(studentsForTab(allActive, "all").map((s) => s.id), ["b", "a"]);

    const allDeactivated = [deactivated("a", "い"), deactivated("b", "あ")];
    assert.deepEqual(studentsForTab(allDeactivated, "active"), []);
    assert.deepEqual(studentsForTab(allDeactivated, "all").map((s) => s.id), ["b", "a"]);
  });

  it("同名は入力順を保ち、行が欠けたり重複したりしない", () => {
    const list = [active("x2", "やまだ"), active("x1", "やまだ"), deactivated("x3", "やまだ"), active("x0", "あおき")];
    assert.deepEqual(studentsForTab(list, "all").map((s) => s.id), ["x0", "x2", "x1", "x3"]);
    assert.deepEqual(studentsForTab(list, "active").map((s) => s.id), ["x0", "x2", "x1"]);
    const ids = studentsForTab(list, "all").map((s) => s.id);
    assert.equal(new Set(ids).size, list.length);
  });

  it("すべてタブ：無効の名前が先の五十音でも有効が先", () => {
    const list = [deactivated("d", "あ"), active("a", "ん")];
    assert.deepEqual(studentsForTab(list, "all").map((s) => s.id), ["a", "d"]);
  });

  it("毎回新しい配列を返す（呼び出し側で並べ替えても元の配列に影響しない）", () => {
    const list = [active("a", "あ")];
    const out = studentsForTab(list, "all");
    assert.notEqual(out, list);
    out.push(active("z", "ん"));
    assert.equal(list.length, 1);
  });
});

describe("formatDeactivatedDate（境界）", () => {
  it("UTC 14:59:59.999 は同日、UTC 15:00 は日本時間で翌日", () => {
    assert.equal(formatDeactivatedDate("2026-09-01T14:59:59.999Z"), "2026/09/01");
    assert.equal(formatDeactivatedDate("2026-09-01T15:00:00.000Z"), "2026/09/02");
  });

  it("月末・年末・うるう日をまたぐ", () => {
    assert.equal(formatDeactivatedDate("2026-09-30T15:00:00.000Z"), "2026/10/01");
    assert.equal(formatDeactivatedDate("2026-12-31T15:00:00.000Z"), "2027/01/01");
    assert.equal(formatDeactivatedDate("2028-02-28T15:00:00.000Z"), "2028/02/29");
    assert.equal(formatDeactivatedDate("2028-02-29T15:00:00.000Z"), "2028/03/01");
  });

  it("オフセット付きの ISO 文字列も日本時間で整形する", () => {
    assert.equal(formatDeactivatedDate("2026-09-01T23:30:00-05:00"), "2026/09/02");
  });

  it("空文字・不正な文字列は空文字", () => {
    for (const v of ["", "   ", "Invalid Date", "2026-13-45T00:00:00Z", "abc"]) {
      assert.equal(formatDeactivatedDate(v), "", JSON.stringify(v));
    }
  });

  it("出力は YYYY/MM/DD の形だけ（時刻を含まない）", () => {
    assert.match(formatDeactivatedDate("2026-01-02T03:04:05.000Z"), /^\d{4}\/\d{2}\/\d{2}$/);
  });

  it("実行環境のタイムゾーン（TZ）に左右されない", () => {
    // 既定は Asia/Tokyo 固定。明示した UTC との差で確認する
    assert.equal(formatDeactivatedDate("2026-09-01T15:00:00.000Z", "UTC"), "2026/09/01");
    assert.equal(formatDeactivatedDate("2026-09-01T15:00:00.000Z"), "2026/09/02");
  });
});

describe("statusActionErrorMessage（境界）", () => {
  it("未知の HTTP ステータスはサーバーエラーの文言", () => {
    const server = statusActionErrorMessage(500);
    for (const code of [0, 200, 400, 401, 409, 422, 429, 503, 599, Number.NaN]) {
      assert.equal(statusActionErrorMessage(code), server, `status=${code}`);
    }
  });

  it("401 は 403 と別扱い（サーバーエラー扱い）である", () => {
    // 現在の API は未ログインも 403 を返すため、401 は来ない前提
    assert.notEqual(statusActionErrorMessage(401), statusActionErrorMessage(403));
  });

  it("どの文言にもサーバーの英語メッセージが含まれない", () => {
    for (const code of [null, 400, 401, 403, 404, 409, 500, 502]) {
      const m = statusActionErrorMessage(code);
      assert.doesNotMatch(m, NO_ASCII_WORDS, `status=${code}`);
      assert.ok(!m.includes("Forbidden") && !m.includes("not found") && !m.includes("Internal"));
    }
  });
});

describe("inviteErrorView（境界・API との対応）", () => {
  it("API の 409 DEACTIVATED 本文 → 固定文言と userId（サーバー文言や id は文言に入らない）", () => {
    const body = inviteConflictFor({ id: "stu_dummy_1", role: "STUDENT", deactivatedAt: new Date("2026-09-01T00:00:00Z") });
    const view = inviteErrorView(409, JSON.parse(JSON.stringify(body)));
    assert.deepEqual(view, { message: INVITE_DEACTIVATED_UI_MESSAGE, deactivatedUserId: "stu_dummy_1" });
    assert.ok(!view!.message.includes("stu_dummy_1"));
    assert.ok(!view!.message.includes(INVITE_DEACTIVATED_MESSAGE));
    assert.doesNotMatch(view!.message, NO_ASCII_WORDS);
  });

  it("API の 409 EXISTS 本文 → API の日本語文言のまま、再有効化ボタンなし", () => {
    for (const existing of [
      { id: "stu_dummy_2", role: "STUDENT", deactivatedAt: null },
      { id: "ins_dummy_1", role: "INSTRUCTOR", deactivatedAt: null },
      { id: "ins_dummy_2", role: "INSTRUCTOR", deactivatedAt: new Date("2026-09-01T00:00:00Z") },
    ]) {
      const view = inviteErrorView(409, JSON.parse(JSON.stringify(inviteConflictFor(existing))));
      assert.deepEqual(view, { message: INVITE_EXISTS_MESSAGE, deactivatedUserId: null }, existing.role);
      assert.ok(!view!.message.includes(existing.id));
    }
  });

  it("409 DEACTIVATED で userId が文字列でない・空なら再有効化の対象なし", () => {
    for (const userId of [123, "", null, undefined, { id: "x" }]) {
      assert.deepEqual(inviteErrorView(409, { code: "DEACTIVATED", userId }), {
        message: INVITE_DEACTIVATED_UI_MESSAGE,
        deactivatedUserId: null,
      });
    }
  });

  it("API の実際の 400 / 403 / 500 本文（英語）は出さず、日本語の固定文言にする", () => {
    const cases: Array<[number, unknown, string]> = [
      [400, { error: "Bad Request" }, INVITE_BAD_REQUEST_MESSAGE],
      [403, { error: "Forbidden" }, statusActionErrorMessage(403)],
      [500, { error: "Internal server error" }, statusActionErrorMessage(500)],
    ];
    for (const [code, body, expected] of cases) {
      const view = inviteErrorView(code, body);
      assert.deepEqual(view, { message: expected, deactivatedUserId: null }, `status=${code}`);
      assert.doesNotMatch(view!.message, NO_ASCII_WORDS, `status=${code}`);
    }
  });

  it("通信エラー（null）は通信エラーの文言", () => {
    assert.deepEqual(inviteErrorView(null, null), {
      message: statusActionErrorMessage(null),
      deactivatedUserId: null,
    });
  });

  it("未知のステータス・本文が読めない・404 はサーバーエラーの固定文言（英語の本文も出さない）", () => {
    for (const code of [401, 404, 418, 502, 503, 504, 0, 302]) {
      for (const body of [null, { error: "Gateway Timeout" }, "<html>", {}]) {
        const view = inviteErrorView(code, body);
        assert.deepEqual(view, { message: statusActionErrorMessage(500), deactivatedUserId: null }, `status=${code}`);
      }
    }
  });

  it("409 でも code が DEACTIVATED / EXISTS 以外、または EXISTS の error が空・文字列以外なら固定文言", () => {
    for (const body of [
      { error: "Conflict" },
      { error: "Conflict", code: "OTHER" },
      { code: "EXISTS" },
      { code: "EXISTS", error: "" },
      { code: "EXISTS", error: 409 },
      null,
      "Conflict",
      [],
    ]) {
      assert.deepEqual(
        inviteErrorView(409, body),
        { message: statusActionErrorMessage(500), deactivatedUserId: null },
        JSON.stringify(body)
      );
    }
  });

  it("409 以外で code が DEACTIVATED / EXISTS でも API 文言や再有効化は出さない", () => {
    assert.deepEqual(inviteErrorView(500, { error: "Internal server error", code: "EXISTS" }), {
      message: statusActionErrorMessage(500),
      deactivatedUserId: null,
    });
    assert.deepEqual(inviteErrorView(400, { error: "x", code: "DEACTIVATED", userId: "stu_dummy_9" }), {
      message: INVITE_BAD_REQUEST_MESSAGE,
      deactivatedUserId: null,
    });
  });

  it("2xx はエラーにならない（成功時の本文はパスワード入り、本文が読めなくても）", () => {
    assert.equal(
      inviteErrorView(201, { id: "stu_dummy_3", email: "dummy@example.com", name: "だみー", password: "dummy-pass" }),
      null
    );
    assert.equal(inviteErrorView(200, null), null);
    assert.equal(inviteErrorView(201, { error: "ignored" }), null);
  });

  it("固定文言はすべて日本語", () => {
    for (const code of [null, 400, 403, 404, 409, 500]) {
      assert.doesNotMatch(inviteErrorView(code, { error: "English text" })!.message, NO_ASCII_WORDS, `status=${code}`);
    }
  });
});

describe("confirmMessage（境界）", () => {
  it("名前以外の受講生情報（id・メール）を受け取らず、英字を含まない", () => {
    for (const action of ["deactivate", "reactivate"] as const) {
      const m = confirmMessage(action, "やまだ");
      assert.doesNotMatch(m, NO_ASCII_WORDS, action);
      assert.ok(!m.includes("@"));
    }
  });

  it("無効化と再有効化で文が異なる", () => {
    assert.notEqual(confirmMessage("deactivate", "やまだ"), confirmMessage("reactivate", "やまだ"));
  });

  it("名前はそのまま埋め込む（記号を含む名前も崩れない）", () => {
    const name = "<b>O'Brien & 山田</b>";
    assert.ok(confirmMessage("deactivate", name).startsWith(`${name} さんを無効化しますか？`));
    assert.ok(confirmMessage("reactivate", name).startsWith(`${name} さんを再有効化しますか？`));
  });
});

describe("PR1 の API 応答との対応", () => {
  it("studentStatusOf（一覧・無効化・再有効化の応答）の形がそのまま一覧の行に使える", () => {
    const off = studentStatusOf({ id: "stu_dummy_4", deactivatedAt: new Date("2026-09-01T15:00:00.000Z") });
    const on = studentStatusOf({ id: "stu_dummy_5", deactivatedAt: null });
    assert.deepEqual(Object.keys(off).sort(), ["deactivatedAt", "id", "status"]);

    const list: AdminStudentRow[] = [
      { name: "い", ...off },
      { name: "あ", ...on },
    ];
    assert.deepEqual(countStudentsByTab(list), { active: 1, deactivated: 1, all: 2 });
    assert.deepEqual(studentsForTab(list, "deactivated").map((s) => s.id), ["stu_dummy_4"]);
    assert.equal(formatDeactivatedDate(off.deactivatedAt), "2026/09/02");
    assert.equal(formatDeactivatedDate(on.deactivatedAt), "");
  });

  it("無効化 → 再有効化の応答を行に反映すると、タブ間を移動する", () => {
    // page.tsx の反映（id が一致する行の status / deactivatedAt を差し替え）と同じ操作
    const apply = (rows: AdminStudentRow[], updated: ReturnType<typeof studentStatusOf>) =>
      rows.map((s) => (s.id === updated.id ? { ...s, status: updated.status, deactivatedAt: updated.deactivatedAt } : s));

    let rows: AdminStudentRow[] = [active("stu_dummy_6", "あ"), active("stu_dummy_7", "い")];
    rows = apply(rows, studentStatusOf({ id: "stu_dummy_6", deactivatedAt: new Date("2026-09-01T00:00:00Z") }));
    assert.deepEqual(studentsForTab(rows, "active").map((s) => s.id), ["stu_dummy_7"]);
    assert.deepEqual(studentsForTab(rows, "deactivated").map((s) => s.id), ["stu_dummy_6"]);

    rows = apply(rows, studentStatusOf({ id: "stu_dummy_6", deactivatedAt: null }));
    assert.deepEqual(studentsForTab(rows, "active").map((s) => s.id), ["stu_dummy_6", "stu_dummy_7"]);
    assert.deepEqual(countStudentsByTab(rows), { active: 2, deactivated: 0, all: 2 });
  });
});
