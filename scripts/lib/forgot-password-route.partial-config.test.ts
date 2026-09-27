import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  USER_EMAIL,
  USER_ID,
  captureConsole,
  findLeaks,
  installFakePrisma,
  jsonRequest,
  type FakePrisma,
  type LogEntry,
} from "./forgot-password-route.test-helpers";

// #9: RESEND_API_KEY is set but the rest of the mail config is incomplete.
// Mail must not be sent (no fallback sender / host), and only the variable names are logged.
// SAFETY: dummy values, unresolvable Resend base URL, fetch is a failing stub, fake prisma.

const API_KEY = "re_dummy_key_for_partial_config_tests";
const BAD_BASE_URL = "https://lms.example.test/some/path?x=1";

process.env.RESEND_API_KEY = API_KEY;
process.env.RESEND_BASE_URL = "https://resend.invalid";
delete process.env.MAIL_FROM;
delete process.env.MAIL_REPLY_TO;
process.env.APP_BASE_URL = BAD_BASE_URL;
delete process.env.VERCEL_ENV;

const WARN_TEXT =
  "[forgot-password] Mail sending is not configured (missing: MAIL_FROM; invalid: APP_BASE_URL). Skipped sending the reset email.";

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

describe("POST /api/auth/forgot-password (API key set, MAIL_FROM missing, APP_BASE_URL invalid)", () => {
  it("does not send, logs one fixed warning with variable names only, returns success", async () => {
    const res = await POST(jsonRequest({ email: USER_EMAIL }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.equal(fetchCalls, 0, "no mail request with an incomplete config");
    assert.equal(fake.createdTokens.length, 1);

    assert.deepEqual(logs, [{ level: "warn", text: WARN_TEXT }]);
    assert.deepEqual(
      findLeaks(logs, [fake.createdTokens[0], USER_EMAIL, USER_ID, API_KEY, BAD_BASE_URL, "lms.example.test"]),
      []
    );
  });

  it("MAIL_REPLY_TO with a line break is reported as invalid", async () => {
    process.env.MAIL_REPLY_TO = "support@example.test\r\nBcc: someone@example.test";
    try {
      await POST(jsonRequest({ email: USER_EMAIL }));
    } finally {
      delete process.env.MAIL_REPLY_TO;
    }

    assert.equal(fetchCalls, 0);
    assert.deepEqual(logs, [
      {
        level: "warn",
        text: "[forgot-password] Mail sending is not configured (missing: MAIL_FROM; invalid: APP_BASE_URL, MAIL_REPLY_TO). Skipped sending the reset email.",
      },
    ]);
    assert.ok(!logs[0].text.includes("example.test"));
  });
});
