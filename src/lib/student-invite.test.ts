import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INVITE_DEACTIVATED_MESSAGE,
  INVITE_EXISTS_MESSAGE,
  inviteConflictFor,
  isUniqueConstraintError,
} from "./student-invite";

// #7: invite with an email that already exists answers 409 instead of 500.

describe("inviteConflictFor", () => {
  it("no existing account: no conflict", () => {
    assert.equal(inviteConflictFor(null), null);
  });

  it("active student: EXISTS", () => {
    assert.deepEqual(inviteConflictFor({ id: "s1", role: "STUDENT", deactivatedAt: null }), {
      error: INVITE_EXISTS_MESSAGE,
      code: "EXISTS",
    });
  });

  it("deactivated student: DEACTIVATED with the id for reactivation", () => {
    assert.deepEqual(
      inviteConflictFor({ id: "s2", role: "STUDENT", deactivatedAt: new Date("2026-09-01T00:00:00Z") }),
      { error: INVITE_DEACTIVATED_MESSAGE, code: "DEACTIVATED", userId: "s2" }
    );
  });

  it("instructor (active or not): EXISTS without an id", () => {
    for (const deactivatedAt of [null, new Date()]) {
      const body = inviteConflictFor({ id: "i1", role: "INSTRUCTOR", deactivatedAt });
      assert.deepEqual(body, { error: INVITE_EXISTS_MESSAGE, code: "EXISTS" });
    }
  });
});

describe("isUniqueConstraintError", () => {
  it("detects P2002 only", () => {
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    assert.equal(isUniqueConstraintError(p2002), true);
    for (const e of [
      Object.assign(new Error("x"), { code: "P2025" }),
      new Error("P2002"),
      "P2002",
      null,
      undefined,
      { code: 2002 },
    ]) {
      assert.equal(isUniqueConstraintError(e), false);
    }
  });
});
