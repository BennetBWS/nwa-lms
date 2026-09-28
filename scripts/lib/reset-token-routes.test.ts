import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { deactivateStudent, reactivateStudent, type StudentStatusDb } from "../../src/lib/student-status";
import {
  createFakeDb,
  installFakePrisma,
  seed,
  type FakeDb,
} from "./student-routes.test-helpers";

// #7: tokens of a deactivated user are answered exactly like an unknown token by
// GET /api/auth/verify-reset-token and POST /api/auth/reset-password.
// No DB (in-memory fake on globalThis.prisma), no network. All data are dummies.

let db: FakeDb;
let verify: (req: Request) => Promise<Response>;
let reset: (req: Request) => Promise<Response>;
let logs: string[];

const HOUR = 3600_000;
const NEW_PASSWORD = "dummy-new-password-7";

const verifyReq = (token: string) =>
  new Request(`http://localhost/api/auth/verify-reset-token?token=${encodeURIComponent(token)}`);
const resetReq = (token: string, newPassword = NEW_PASSWORD) =>
  new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });

async function snapshot(res: Response) {
  return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
}

before(async () => {
  db = createFakeDb();
  installFakePrisma(db);
  ({ GET: verify } = await import("../../src/app/api/auth/verify-reset-token/route"));
  ({ POST: reset } = await import("../../src/app/api/auth/reset-password/route"));
});

beforeEach(() => {
  for (const k of ["users", "resets", "progress", "quizAttempts", "comments", "assignments", "notifications", "calls"] as const) {
    db[k].length = 0;
  }
  seed(db);
  const future = new Date(Date.now() + HOUR);
  const past = new Date(Date.now() - 1000);
  db.resets.push(
    { id: "r1", userId: "stu_active", token: "tok-active", expiresAt: future, used: false },
    { id: "r2", userId: "stu_active", token: "tok-active-used", expiresAt: future, used: true },
    { id: "r3", userId: "stu_active", token: "tok-active-expired", expiresAt: past, used: false },
    // stu_off is deactivated (seed). Tokens issued before deactivation.
    { id: "r4", userId: "stu_off", token: "tok-off", expiresAt: future, used: false },
    { id: "r5", userId: "stu_off", token: "tok-off-used", expiresAt: future, used: true },
    { id: "r6", userId: "stu_off", token: "tok-off-expired", expiresAt: past, used: false }
  );
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    mock.method(console, level, (...args: unknown[]) => logs.push(args.map(String).join(" ")));
  }
  mock.method(globalThis, "fetch", async () => {
    throw new Error("network access is not allowed in tests");
  });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

describe("GET /api/auth/verify-reset-token", () => {
  it("active user's valid token: valid", async () => {
    assert.deepEqual(await (await verify(verifyReq("tok-active"))).json(), { valid: true });
  });

  it("deactivated user's token (unused / used / expired): identical to an unknown token", async () => {
    const unknown = await snapshot(await verify(verifyReq("tok-unknown")));
    assert.deepEqual(JSON.parse(unknown.body), { valid: false, reason: "Invalid token" });
    for (const t of ["tok-off", "tok-off-used", "tok-off-expired"]) {
      assert.deepEqual(await snapshot(await verify(verifyReq(t))), unknown, t);
    }
  });

  it("active user's used / expired tokens keep their existing answers", async () => {
    assert.deepEqual(await (await verify(verifyReq("tok-active-used"))).json(), {
      valid: false,
      reason: "Token already used",
    });
    assert.deepEqual(await (await verify(verifyReq("tok-active-expired"))).json(), {
      valid: false,
      reason: "Token expired",
    });
  });

  it("expiresAt === now: Token expired (same boundary as reset-password)", async () => {
    const NOW = Date.parse("2026-09-28T00:00:00.000Z");
    db.resets.find((r) => r.id === "r1")!.expiresAt = new Date(NOW);
    mock.timers.enable({ apis: ["Date"], now: NOW });
    assert.deepEqual(await (await verify(verifyReq("tok-active"))).json(), {
      valid: false,
      reason: "Token expired",
    });
  });

  it("the lookup includes the user's deactivatedAt only", async () => {
    await verify(verifyReq("tok-off"));
    const call = db.calls.find((c) => c.method === "passwordReset.findUnique");
    assert.deepEqual(call!.args[0], {
      where: { token: "tok-off" },
      include: { user: { select: { deactivatedAt: true } } },
    });
  });
});

describe("POST /api/auth/reset-password", () => {
  it("deactivated user's token (unused / used / expired): identical to an unknown token; password unchanged", async () => {
    const pw = db.users.find((u) => u.id === "stu_off")!.password;
    const unknown = await snapshot(await reset(resetReq("tok-unknown")));
    assert.equal(unknown.status, 400);
    assert.deepEqual(JSON.parse(unknown.body), { error: "Invalid token" });
    for (const t of ["tok-off", "tok-off-used", "tok-off-expired"]) {
      assert.deepEqual(await snapshot(await reset(resetReq(t))), unknown, t);
    }
    assert.equal(db.users.find((u) => u.id === "stu_off")!.password, pw);
    assert.equal(db.resets.find((r) => r.id === "r4")!.used, false, "token is not consumed");
    assert.ok(!db.calls.some((c) => c.method === "user.update" || c.method === "$transaction"));
    assert.deepEqual(logs, []);
  });

  it("active user's valid token: password updated and the token consumed (unchanged behavior)", async () => {
    const before = db.users.find((u) => u.id === "stu_active")!.password;
    const res = await reset(resetReq("tok-active"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    const after = db.users.find((u) => u.id === "stu_active")!.password;
    assert.notEqual(after, before);
    assert.ok(!after.includes(NEW_PASSWORD), "stored hashed");
    assert.equal(db.resets.find((r) => r.id === "r1")!.used, true);
  });

  it("active user's used / expired tokens keep their existing answers", async () => {
    assert.deepEqual(await (await reset(resetReq("tok-active-used"))).json(), { error: "Token already used" });
    assert.deepEqual(await (await reset(resetReq("tok-active-expired"))).json(), { error: "Token expired" });
  });

  it("input validation still runs first (400)", async () => {
    assert.equal((await reset(resetReq("tok-off", "short"))).status, 400);
    assert.deepEqual(await (await reset(resetReq("", NEW_PASSWORD))).json(), {
      error: "Token and new password are required",
    });
  });
});

describe("token issued before deactivation (end to end with deactivateStudent)", () => {
  it("after deactivation: verify and reset answer Invalid token (not 'Token already used')", async () => {
    const r = await deactivateStudent(db.client as unknown as StudentStatusDb, "stu_active");
    assert.equal(r.kind, "ok");
    // deactivateStudent marks the token used, but Invalid token takes precedence.
    assert.equal(db.resets.find((x) => x.id === "r1")!.used, true);

    const unknownVerify = await snapshot(await verify(verifyReq("tok-unknown")));
    assert.deepEqual(await snapshot(await verify(verifyReq("tok-active"))), unknownVerify);
    const unknownReset = await snapshot(await reset(resetReq("tok-unknown")));
    assert.deepEqual(await snapshot(await reset(resetReq("tok-active"))), unknownReset);
  });

  it("after reactivation, the old token stays unusable (invalidated at deactivation)", async () => {
    const client = db.client as unknown as StudentStatusDb;
    await deactivateStudent(client, "stu_active");
    await reactivateStudent(client, "stu_active");
    assert.deepEqual(await (await verify(verifyReq("tok-active"))).json(), {
      valid: false,
      reason: "Token already used",
    });
    assert.equal((await reset(resetReq("tok-active"))).status, 400);
  });
});
