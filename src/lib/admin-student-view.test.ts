import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INVITE_BAD_REQUEST_MESSAGE,
  INVITE_DEACTIVATED_UI_MESSAGE,
  confirmMessage,
  countStudentsByTab,
  formatDeactivatedDate,
  inviteErrorView,
  statusActionErrorMessage,
  studentsForTab,
  type AdminStudentRow,
} from "./admin-student-view";

// #7: admin students table. All data are dummies. Names are kana: the "ja" collation
// does not order kanji by reading.

const rows: AdminStudentRow[] = [
  { id: "s1", name: "さとう", status: "deactivated", deactivatedAt: "2026-09-01T00:00:00.000Z" },
  { id: "s2", name: "あおき", status: "active", deactivatedAt: null },
  { id: "s3", name: "いとう", status: "active", deactivatedAt: null },
  { id: "s4", name: "Alice", status: "deactivated", deactivatedAt: "2026-08-15T12:00:00.000Z" },
];

describe("countStudentsByTab", () => {
  it("counts active, deactivated and all", () => {
    assert.deepEqual(countStudentsByTab(rows), { active: 2, deactivated: 2, all: 4 });
  });

  it("returns zeros for an empty list", () => {
    assert.deepEqual(countStudentsByTab([]), { active: 0, deactivated: 0, all: 0 });
  });
});

describe("studentsForTab", () => {
  it("active tab: only active students, by name", () => {
    assert.deepEqual(studentsForTab(rows, "active").map((s) => s.id), ["s2", "s3"]);
  });

  it("deactivated tab: only deactivated students, by name", () => {
    assert.deepEqual(studentsForTab(rows, "deactivated").map((s) => s.id), ["s4", "s1"]);
  });

  it("all tab: active first, then deactivated, each by name", () => {
    assert.deepEqual(studentsForTab(rows, "all").map((s) => s.id), ["s2", "s3", "s4", "s1"]);
  });

  it("does not mutate the input", () => {
    const before = rows.map((s) => s.id);
    studentsForTab(rows, "all");
    studentsForTab(rows, "active");
    assert.deepEqual(rows.map((s) => s.id), before);
  });

  it("keeps extra fields of the rows", () => {
    const [first] = studentsForTab([{ ...rows[1], progress: 42 }], "active");
    assert.equal(first.progress, 42);
  });
});

describe("formatDeactivatedDate", () => {
  it("formats as YYYY/MM/DD in Japan time", () => {
    // 2026-08-31T20:00Z is 2026-09-01 05:00 in Tokyo.
    assert.equal(formatDeactivatedDate("2026-08-31T20:00:00.000Z"), "2026/09/01");
    assert.equal(formatDeactivatedDate("2026-01-05T00:00:00.000Z"), "2026/01/05");
  });

  it("accepts another time zone", () => {
    assert.equal(formatDeactivatedDate("2026-08-31T20:00:00.000Z", "UTC"), "2026/08/31");
  });

  it("returns an empty string for null or invalid input", () => {
    assert.equal(formatDeactivatedDate(null), "");
    assert.equal(formatDeactivatedDate("not a date"), "");
  });
});

describe("statusActionErrorMessage", () => {
  it("has a fixed Japanese message per case", () => {
    const messages = [403, 404, 500, null].map(statusActionErrorMessage);
    assert.equal(new Set(messages).size, 4);
    for (const m of messages) assert.match(m, /[ぁ-んァ-ン一-龥]/);
  });

  it("treats other statuses like a server error", () => {
    assert.equal(statusActionErrorMessage(502), statusActionErrorMessage(500));
    assert.equal(statusActionErrorMessage(400), statusActionErrorMessage(500));
  });
});

describe("inviteErrorView", () => {
  it("409 DEACTIVATED: fixed message and the student id", () => {
    assert.deepEqual(
      inviteErrorView(409, { error: "server text", code: "DEACTIVATED", userId: "u1" }),
      { message: INVITE_DEACTIVATED_UI_MESSAGE, deactivatedUserId: "u1" }
    );
  });

  it("409 DEACTIVATED without a userId: message only", () => {
    assert.deepEqual(inviteErrorView(409, { error: "x", code: "DEACTIVATED" }), {
      message: INVITE_DEACTIVATED_UI_MESSAGE,
      deactivatedUserId: null,
    });
  });

  it("409 EXISTS: the API text as is", () => {
    assert.deepEqual(inviteErrorView(409, { error: "このメールアドレスは既に登録されています", code: "EXISTS" }), {
      message: "このメールアドレスは既に登録されています",
      deactivatedUserId: null,
    });
  });

  it("other statuses: fixed Japanese messages, never the server text", () => {
    assert.deepEqual(inviteErrorView(400, { error: "Bad Request" }), {
      message: INVITE_BAD_REQUEST_MESSAGE,
      deactivatedUserId: null,
    });
    assert.equal(inviteErrorView(403, { error: "Forbidden" })?.message, statusActionErrorMessage(403));
    assert.equal(inviteErrorView(500, { error: "Internal server error" })?.message, statusActionErrorMessage(500));
    assert.equal(inviteErrorView(null, null)?.message, statusActionErrorMessage(null));
  });

  it("2xx is not an error", () => {
    assert.equal(inviteErrorView(201, { id: "u1", email: "a@example.com", name: "a", password: "p" }), null);
    assert.equal(inviteErrorView(200, null), null);
  });
});

describe("confirmMessage", () => {
  it("includes the name and the key facts", () => {
    const d = confirmMessage("deactivate", "山田");
    assert.ok(d.startsWith("山田 さんを無効化しますか？"));
    assert.match(d, /直ちにログアウト/);
    assert.match(d, /削除されず/);
    const r = confirmMessage("reactivate", "山田");
    assert.ok(r.startsWith("山田 さんを再有効化しますか？"));
    assert.match(r, /パスワードは変わりません/);
    assert.match(r, /再ログインを依頼/);
  });
});
