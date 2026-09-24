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

// #12: RESEND_API_KEY-set path. The Resend client is created at module load, so this
// lives in its own file (node --test runs each file in a separate process).
// SAFETY: dummy key, unresolvable base URL, and globalThis.fetch is mocked, so no
// request ever leaves the process. No DB (fake prisma on globalThis).

process.env.RESEND_API_KEY = "re_dummy_key_for_tests";
process.env.RESEND_BASE_URL = "https://resend.invalid";

let POST: (req: Request) => Promise<Response>;
let fake: FakePrisma;
let logs: LogEntry[];
let sent: { url: string; body: { to: unknown; html: string } }[];

before(async () => {
  fake = installFakePrisma();
  ({ POST } = await import("../../src/app/api/auth/forgot-password/route"));
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.createdTokens.length = 0;
  fake.failWith = undefined;
  logs = captureConsole();
  sent = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: "email_dummy" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  mock.restoreAll();
});

describe("POST /api/auth/forgot-password (RESEND_API_KEY set)", () => {
  it("sends the reset URL by mail only; nothing sensitive is logged", async () => {
    const res = await POST(jsonRequest({ email: USER_EMAIL }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });

    const token = fake.createdTokens[0];
    assert.ok(token);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].url.startsWith("https://resend.invalid/"), sent[0].url);
    assert.deepEqual(sent[0].body.to, USER_EMAIL);
    assert.ok(
      sent[0].body.html.includes(`https://nwa-lms.vercel.app/reset-password?token=${token}`),
      "mail contains the reset URL"
    );

    assert.deepEqual(logs, [], "nothing is logged on success");
    assert.deepEqual(findLeaks(logs, [token, USER_EMAIL, USER_ID]), []);
  });

  it("mail transport fails: response stays {success:true}, token/email are not logged", async () => {
    mock.restoreAll();
    logs = captureConsole();
    mock.method(globalThis, "fetch", async () => {
      throw new TypeError(`fetch failed for ${USER_EMAIL}`);
    });

    const res = await POST(jsonRequest({ email: USER_EMAIL }));
    const token = fake.createdTokens[0];

    // resend@6 catches transport errors and returns { error } instead of throwing,
    // and the route does not inspect the return value, so this is a silent 200.
    // (Reported separately: send failures are currently invisible in logs.)
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.deepEqual(findLeaks(logs, [token, USER_EMAIL, USER_ID]), []);
  });

  it("Resend API returns an error response: token/email are not logged", async () => {
    mock.restoreAll();
    logs = captureConsole();
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({ name: "validation_error", message: `Invalid to: ${USER_EMAIL}` }),
        { status: 422, headers: { "content-type": "application/json" } }
      )
    );

    const res = await POST(jsonRequest({ email: USER_EMAIL }));
    const token = fake.createdTokens[0];

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.deepEqual(findLeaks(logs, [token, USER_EMAIL, USER_ID]), []);
  });

  it("unknown email: no mail is sent, same response", async () => {
    const res = await POST(jsonRequest({ email: "nobody-12@example.com" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.equal(sent.length, 0);
    assert.deepEqual(logs, []);
  });
});
