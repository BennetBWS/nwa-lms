import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  STUDENT_SESSION,
  createFakeDb,
  installFakeAuth,
  installFakePrisma,
  seed,
  type FakeDb,
  type FakeSession,
} from "./student-routes.test-helpers";

// #11: password changes bump User.sessionVersion (signs out every device), and
// reset-password consumes its token with a conditional update.
// No DB (in-memory fake on globalThis.prisma), no network, NextAuth stubbed.
// All data are dummies (example.com).

let db: FakeDb;
let session: FakeSession;
let changePassword: (req: Request) => Promise<Response>;
let reset: (req: Request) => Promise<Response>;
let logs: string[];

const HOUR = 3600_000;
const CURRENT_PASSWORD = "dummy-current-11";
const NEW_PASSWORD = "dummy-new-password-11";

const changeReq = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/user/change-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const resetReq = (token: string, newPassword = NEW_PASSWORD) =>
  new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });

const user = (id: string) => db.users.find((u) => u.id === id)!;

before(async () => {
  db = createFakeDb();
  installFakePrisma(db);
  installFakeAuth(() => session);
  ({ POST: changePassword } = await import("../../src/app/api/user/change-password/route"));
  ({ POST: reset } = await import("../../src/app/api/auth/reset-password/route"));
});

beforeEach(() => {
  for (const k of ["users", "resets", "progress", "quizAttempts", "comments", "assignments", "notifications", "calls"] as const) {
    db[k].length = 0;
  }
  db.beforeTransaction = undefined;
  seed(db);
  user("stu_active").password = bcrypt.hashSync(CURRENT_PASSWORD, 4);
  const future = new Date(Date.now() + HOUR);
  const past = new Date(Date.now() - 1000);
  db.resets.push(
    { id: "r1", userId: "stu_active", token: "tok-active", expiresAt: future, used: false },
    { id: "r2", userId: "stu_active", token: "tok-active-used", expiresAt: future, used: true },
    { id: "r3", userId: "stu_active", token: "tok-active-expired", expiresAt: past, used: false }
  );
  session = STUDENT_SESSION;
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    mock.method(console, level, (...args: unknown[]) => logs.push(args.map(String).join(" ")));
  }
  mock.method(globalThis, "fetch", async () => {
    throw new Error("network access is not allowed in tests");
  });
});

afterEach(() => {
  mock.restoreAll();
});

describe("POST /api/user/change-password", () => {
  it("success: password updated and sessionVersion +1 in the same update", async () => {
    const before = { ...user("stu_active") };
    const res = await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    const after = user("stu_active");
    assert.equal(after.sessionVersion, before.sessionVersion + 1);
    assert.notEqual(after.password, before.password);
    assert.ok(await bcrypt.compare(NEW_PASSWORD, after.password));
    const updates = db.calls.filter((c) => c.method === "user.update");
    assert.equal(updates.length, 1);
    assert.deepEqual((updates[0].args[0] as { data: { sessionVersion: unknown } }).data.sessionVersion, { increment: 1 });
    assert.deepEqual(logs, []);
  });

  it("new password shorter than 8 characters (or not a string): 400, nothing updated", async () => {
    for (const newPassword of ["short", "1234567", "", undefined, 12345678]) {
      const res = await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword }));
      assert.equal(res.status, 400, String(newPassword));
      assert.deepEqual(await res.json(), { error: "Password must be at least 8 characters" });
    }
    assert.equal(user("stu_active").sessionVersion, 3);
    assert.ok(!db.calls.some((c) => c.method === "user.update"));
  });

  it("exactly 8 characters is accepted", async () => {
    const res = await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword: "12345678" }));
    assert.equal(res.status, 200);
    assert.equal(user("stu_active").sessionVersion, 4);
  });

  it("wrong current password: 400 (unchanged), sessionVersion unchanged", async () => {
    const res = await changePassword(changeReq({ currentPassword: "wrong-dummy-11", newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Current password is incorrect" });
    assert.equal(user("stu_active").sessionVersion, 3);
  });

  it("no session: 401 (unchanged)", async () => {
    session = null;
    const res = await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 401);
  });
});

describe("POST /api/auth/reset-password (#11)", () => {
  it("success: password updated, token consumed and sessionVersion +1", async () => {
    const before = { ...user("stu_active") };
    const res = await reset(resetReq("tok-active"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    const after = user("stu_active");
    assert.equal(after.sessionVersion, before.sessionVersion + 1);
    assert.ok(await bcrypt.compare(NEW_PASSWORD, after.password));
    assert.equal(db.resets.find((r) => r.id === "r1")!.used, true);

    const consume = db.calls.find((c) => c.method === "passwordReset.updateMany");
    const where = (consume!.args[0] as { where: Record<string, unknown> }).where;
    assert.equal(where.token, "tok-active");
    assert.equal(where.used, false);
    assert.deepEqual(where.user, { deactivatedAt: null });
    assert.ok((where.expiresAt as { gt: unknown }).gt instanceof Date);
    assert.ok(!db.calls.some((c) => c.method === "passwordReset.update"), "no unconditional token update");
    assert.deepEqual(logs, []);
  });

  it("the same token a second time: 'Token already used', nothing changed", async () => {
    assert.equal((await reset(resetReq("tok-active"))).status, 200);
    const snapshot = { ...user("stu_active") };
    const res = await reset(resetReq("tok-active", "another-dummy-11"));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Token already used" });
    assert.deepEqual(user("stu_active"), snapshot);
  });

  it("token consumed by another request after the check: 'Token already used', password not updated", async () => {
    const snapshot = { ...user("stu_active") };
    db.beforeTransaction = () => {
      db.resets.find((r) => r.id === "r1")!.used = true;
    };
    const res = await reset(resetReq("tok-active"));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Token already used" });
    assert.deepEqual(user("stu_active"), snapshot);
    assert.ok(!db.calls.some((c) => c.method === "user.update"));
  });

  it("user deactivated after the check: 'Invalid token', password not updated", async () => {
    const snapshot = { ...user("stu_active") };
    const deactivatedAt = new Date();
    db.beforeTransaction = () => {
      user("stu_active").deactivatedAt = deactivatedAt;
    };
    const res = await reset(resetReq("tok-active"));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid token" });
    assert.deepEqual(user("stu_active"), { ...snapshot, deactivatedAt });
    assert.equal(db.resets.find((r) => r.id === "r1")!.used, false, "token not consumed");
    assert.ok(!db.calls.some((c) => c.method === "user.update"));
  });

  it("token expired after the check: 'Token expired', password not updated", async () => {
    const snapshot = { ...user("stu_active") };
    db.beforeTransaction = () => {
      db.resets.find((r) => r.id === "r1")!.expiresAt = new Date(Date.now() - 1000);
    };
    const res = await reset(resetReq("tok-active"));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Token expired" });
    assert.deepEqual(user("stu_active"), snapshot);
  });

  it("two concurrent requests with the same token: exactly one succeeds, sessionVersion +1 once", async () => {
    const results = await Promise.all([reset(resetReq("tok-active", "dummy-a-11-pass")), reset(resetReq("tok-active", "dummy-b-11-pass"))]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 400]);
    const failed = results.find((r) => r.status === 400)!;
    assert.deepEqual(await failed.json(), { error: "Token already used" });
    assert.equal(user("stu_active").sessionVersion, 4);
    assert.equal(db.calls.filter((c) => c.method === "user.update").length, 1);
    // Both passed the first check; the conditional update decided the winner.
    assert.equal(db.calls.filter((c) => c.method === "passwordReset.updateMany").length, 2);
  });

  it("existing answers are unchanged (used / expired / unknown)", async () => {
    for (const [t, error] of [
      ["tok-active-used", "Token already used"],
      ["tok-active-expired", "Token expired"],
      ["tok-unknown", "Invalid token"],
    ] as const) {
      const res = await reset(resetReq(t));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error });
    }
    assert.equal(user("stu_active").sessionVersion, 3);
    assert.ok(!db.calls.some((c) => c.method === "$transaction"));
  });
});
