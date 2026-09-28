import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { checkCredentials, checkResetToken, isDeactivated } from "./account-access";

// #7: deactivated accounts cannot sign in or reset their password.
// Dummy password; low bcrypt cost to keep the test fast.

const PASSWORD = "dummy-password-7";
const hash = bcrypt.hashSync(PASSWORD, 4);
const active = { id: "u_active", password: hash, deactivatedAt: null };
const deactivated = { id: "u_off", password: hash, deactivatedAt: new Date("2026-09-01T00:00:00Z") };

describe("isDeactivated", () => {
  it("is true only when deactivatedAt is set", () => {
    assert.equal(isDeactivated({ deactivatedAt: null }), false);
    assert.equal(isDeactivated({ deactivatedAt: new Date() }), true);
  });
});

describe("checkCredentials", () => {
  it("active user with the right password is accepted", async () => {
    assert.equal(await checkCredentials(active, PASSWORD, bcrypt.compare), active);
  });

  it("deactivated user with the right password is rejected like a wrong password", async () => {
    assert.equal(await checkCredentials(deactivated, PASSWORD, bcrypt.compare), null);
    assert.equal(await checkCredentials(active, "wrong-password", bcrypt.compare), null);
  });

  it("the password is still compared for a deactivated user (same path as a wrong password)", async () => {
    let compared = 0;
    const compare = async (p: string, h: string) => {
      compared++;
      return bcrypt.compare(p, h);
    };
    assert.equal(await checkCredentials(deactivated, PASSWORD, compare), null);
    assert.equal(compared, 1);
  });

  it("unknown user is rejected", async () => {
    assert.equal(await checkCredentials(null, PASSWORD, bcrypt.compare), null);
  });
});

describe("checkResetToken", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  const future = new Date(now.getTime() + 30 * 60 * 1000);
  const past = new Date(now.getTime() - 1000);

  it("valid token of an active user: returns the same record", () => {
    const record = { userId: "stu_1", used: false, expiresAt: future, user: { deactivatedAt: null } };
    const check = checkResetToken(record, now);
    assert.deepEqual(check, { valid: true, record });
    assert.ok(check.valid);
    assert.equal(check.record, record, "the passed record itself (not a copy)");
    assert.equal(check.record.userId, "stu_1");
  });

  it("deactivated user: Invalid token, even when the token is also used or expired", () => {
    const user = { deactivatedAt: new Date("2026-09-01T00:00:00Z") };
    for (const record of [
      { used: false, expiresAt: future, user },
      { used: true, expiresAt: future, user },
      { used: false, expiresAt: past, user },
    ]) {
      assert.deepEqual(checkResetToken(record, now), { valid: false, reason: "Invalid token" });
    }
  });

  it("unknown token (or missing user): Invalid token", () => {
    assert.deepEqual(checkResetToken(null, now), { valid: false, reason: "Invalid token" });
    assert.deepEqual(checkResetToken({ used: false, expiresAt: future, user: null }, now), {
      valid: false,
      reason: "Invalid token",
    });
  });

  it("keeps the existing used / expired answers for active users", () => {
    const user = { deactivatedAt: null };
    assert.deepEqual(checkResetToken({ used: true, expiresAt: future, user }, now), {
      valid: false,
      reason: "Token already used",
    });
    assert.deepEqual(checkResetToken({ used: false, expiresAt: past, user }, now), {
      valid: false,
      reason: "Token expired",
    });
  });

  it("expiry boundary: expiresAt === now is expired, 1ms later is still valid", () => {
    const user = { deactivatedAt: null };
    assert.deepEqual(checkResetToken({ used: false, expiresAt: new Date(now.getTime()), user }, now), {
      valid: false,
      reason: "Token expired",
    });
    const justBefore = { used: false, expiresAt: new Date(now.getTime() + 1), user };
    assert.deepEqual(checkResetToken(justBefore, now), { valid: true, record: justBefore });
  });
});
