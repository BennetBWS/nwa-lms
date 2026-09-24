import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  OTHER_EMAIL,
  USER_EMAIL,
  USER_ID,
  captureConsole,
  findLeaks,
  installFakePrisma,
  jsonRequest,
  type FakePrisma,
  type LogEntry,
} from "./forgot-password-route.test-helpers";

// #12: POST /api/auth/forgot-password must never log the reset token, the reset URL,
// the email address or the user ID. This file covers the RESEND_API_KEY-unset path.
// No DB (fake prisma on globalThis) and no network (fetch is replaced with a failing stub).

delete process.env.RESEND_API_KEY;

const WARN_TEXT =
  "[forgot-password] Mail sending is not configured (RESEND_API_KEY not set). Skipped sending the reset email.";

let POST: (req: Request) => Promise<Response>;
let fake: FakePrisma;
let logs: LogEntry[];
let fetchCalls: number;

before(async () => {
  fake = installFakePrisma();
  ({ POST } = await import("../../src/app/api/auth/forgot-password/route"));
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.createdTokens.length = 0;
  fake.failWith = undefined;
  logs = captureConsole();
  fetchCalls = 0;
  mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    throw new Error("network access is not allowed in tests");
  });
});

afterEach(() => {
  mock.restoreAll();
});

describe("POST /api/auth/forgot-password (RESEND_API_KEY unset)", () => {
  it("existing user: returns {success:true} and logs only the fixed warning", async () => {
    const res = await POST(jsonRequest({ email: USER_EMAIL }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });

    // A token was really issued, so there was something to leak.
    assert.equal(fake.createdTokens.length, 1);
    const token = fake.createdTokens[0];

    assert.deepEqual(logs, [{ level: "warn", text: WARN_TEXT }]);
    assert.deepEqual(findLeaks(logs, [token, USER_EMAIL, USER_ID]), []);
    assert.equal(fetchCalls, 0, "no mail request without RESEND_API_KEY");
  });

  it("unknown email: same response as an existing user (no user enumeration), no token issued", async () => {
    const res = await POST(jsonRequest({ email: OTHER_EMAIL }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.equal(fake.createdTokens.length, 0);
    assert.ok(!fake.calls.some((c) => c.method.startsWith("passwordReset.")));
    assert.deepEqual(logs, [], "nothing is logged for an unknown email");
  });

  it("invalidates only the requesting user's unused tokens", async () => {
    await POST(jsonRequest({ email: USER_EMAIL }));

    const upd = fake.calls.find((c) => c.method === "passwordReset.updateMany");
    assert.ok(upd, "updateMany is called");
    assert.deepEqual(upd.args[0], {
      where: { userId: USER_ID, used: false },
      data: { used: true },
    });

    const created = fake.calls.find((c) => c.method === "passwordReset.create");
    const data = (created?.args[0] as { data: { userId: string; token: string; expiresAt: Date } })
      .data;
    assert.equal(data.userId, USER_ID);
    assert.match(data.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const ttl = data.expiresAt.getTime() - Date.now();
    assert.ok(ttl > 59 * 60 * 1000 && ttl <= 60 * 60 * 1000, `expires in ~1h (got ${ttl}ms)`);
  });

  it("issues a different token on each request", async () => {
    await POST(jsonRequest({ email: USER_EMAIL }));
    await POST(jsonRequest({ email: USER_EMAIL }));
    assert.equal(fake.createdTokens.length, 2);
    assert.notEqual(fake.createdTokens[0], fake.createdTokens[1]);
    assert.deepEqual(findLeaks(logs, [...fake.createdTokens, USER_EMAIL, USER_ID]), []);
  });

  it("missing email: 400", async () => {
    const res = await POST(jsonRequest({}));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Email is required" });
    assert.equal(fake.calls.length, 0);
  });

  it("invalid JSON body: 500 with a generic message, log has the error name only", async () => {
    const res = await POST(jsonRequest(`{"email":"${USER_EMAIL}"`));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });

    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, "error");
    assert.equal(logs[0].text, "[forgot-password] Unexpected error: SyntaxError");
    assert.deepEqual(findLeaks(logs, [USER_EMAIL]), []);
  });

  it("Prisma-like error with email/token in message and meta: logs only name and P-code", async () => {
    const leakyToken = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const err = Object.assign(
      new Error(`Unique constraint failed on where: { email: "${USER_EMAIL}", token: "${leakyToken}" }`),
      { name: "PrismaClientKnownRequestError", code: "P2002", meta: { target: [USER_EMAIL] } }
    );
    fake.failWith = err;

    const res = await POST(jsonRequest({ email: USER_EMAIL }));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });

    assert.deepEqual(logs, [
      {
        level: "error",
        text: "[forgot-password] Unexpected error: PrismaClientKnownRequestError (code: P2002)",
      },
    ]);
    assert.deepEqual(findLeaks(logs, [USER_EMAIL, leakyToken]), []);
  });

  it("non-Prisma-format code is not logged", async () => {
    for (const code of [USER_EMAIL, "P2002 token=abc", "ECONNREFUSED", "p2002", 2002]) {
      logs.length = 0;
      fake.failWith = Object.assign(new Error("boom"), { code });
      const res = await POST(jsonRequest({ email: USER_EMAIL }));
      assert.equal(res.status, 500);
      assert.deepEqual(
        logs.map((l) => l.text),
        ["[forgot-password] Unexpected error: Error"],
        `code ${String(code)} must not appear in the log`
      );
    }
  });

  it("thrown non-Error value: logs its type only", async () => {
    fake.failWith = `lookup failed for ${USER_EMAIL}`;
    const res = await POST(jsonRequest({ email: USER_EMAIL }));
    assert.equal(res.status, 500);
    assert.deepEqual(
      logs.map((l) => l.text),
      ["[forgot-password] Unexpected error: string"]
    );
  });
});
