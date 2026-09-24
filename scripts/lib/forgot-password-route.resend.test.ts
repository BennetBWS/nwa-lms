import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
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

// #12 / #9: path where the mail config (RESEND_API_KEY / MAIL_FROM / APP_BASE_URL /
// MAIL_REPLY_TO) is complete. Resend reads RESEND_BASE_URL at module load, so this
// lives in its own file (node --test runs each file in a separate process).
// SAFETY: dummy key, unresolvable base URL, and globalThis.fetch is mocked, so no
// request ever leaves the process. No DB (fake prisma on globalThis).
// All values below are dummies (example.test / example.com).

const API_KEY = "re_dummy_key_for_tests";
const MAIL_FROM = "NWA テスト送信 <no-reply@mail.example.test>";
const MAIL_REPLY_TO = "support@example.test";
const APP_BASE_URL = "https://lms.example.test";

process.env.RESEND_API_KEY = API_KEY;
process.env.RESEND_BASE_URL = "https://resend.invalid";
process.env.MAIL_FROM = MAIL_FROM;
process.env.MAIL_REPLY_TO = MAIL_REPLY_TO;
// Trailing slash on purpose: it must be normalized.
process.env.APP_BASE_URL = `${APP_BASE_URL}/`;
delete process.env.VERCEL_ENV;

type SentBody = { from: unknown; reply_to?: unknown; to: unknown; subject: unknown; html: string };

let POST: (req: Request) => Promise<Response>;
// Loaded lazily: a static import is hoisted above the env setup, and resend captures
// RESEND_BASE_URL when it is first loaded. Both the CJS and ESM builds are collected
// because the route may be loaded as either, depending on how tsx compiles it.
type ResendCtor = typeof import("resend").Resend;
let resendClasses: ResendCtor[];
let fake: FakePrisma;
let logs: LogEntry[];
let sent: { url: string; body: SentBody }[];

before(async () => {
  fake = installFakePrisma();
  const requireFromRoot = createRequire(path.join(process.cwd(), "package.json"));
  const cjs = (requireFromRoot("resend") as { Resend: ResendCtor }).Resend;
  const esm = (await import("resend")).Resend;
  resendClasses = cjs === esm ? [cjs] : [cjs, esm];
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

const secretsFor = (token: string | undefined) =>
  [token ?? "", USER_EMAIL, USER_ID, API_KEY, MAIL_FROM, "no-reply@mail.example.test", MAIL_REPLY_TO];

describe("POST /api/auth/forgot-password (mail config complete)", () => {
  it("sends the reset URL built from APP_BASE_URL with MAIL_FROM / MAIL_REPLY_TO; logs nothing", async () => {
    const res = await POST(jsonRequest({ email: USER_EMAIL }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });

    const token = fake.createdTokens[0];
    assert.ok(token);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].url.startsWith("https://resend.invalid/"), sent[0].url);
    assert.equal(sent[0].body.from, MAIL_FROM);
    assert.equal(sent[0].body.reply_to, MAIL_REPLY_TO);
    assert.deepEqual(sent[0].body.to, USER_EMAIL);
    assert.equal(sent[0].body.subject, "NWA - パスワードリセット");
    assert.ok(
      sent[0].body.html.includes(`href="${APP_BASE_URL}/reset-password?token=${token}"`),
      "mail contains the reset URL built from APP_BASE_URL"
    );
    assert.ok(!sent[0].body.html.includes("nwa-lms.vercel.app"), "no hard-coded host");

    assert.deepEqual(logs, [], "nothing is logged on success");
    assert.deepEqual(findLeaks(logs, secretsFor(token)), []);
  });

  it("spoofed request URL / Host / X-Forwarded-Host / Origin do not change the reset URL", async () => {
    const req = new Request("http://evil.example/api/auth/forgot-password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
        origin: "http://evil.example",
      },
      body: JSON.stringify({ email: USER_EMAIL }),
    });

    const res = await POST(req);
    assert.equal(res.status, 200);

    const token = fake.createdTokens[0];
    assert.equal(sent.length, 1);
    assert.ok(sent[0].body.html.includes(`href="${APP_BASE_URL}/reset-password?token=${token}"`));
    assert.ok(!sent[0].body.html.includes("evil.example"));
  });

  it("Resend API returns 422 validation_error: one error line with name/status only", async () => {
    mock.restoreAll();
    logs = captureConsole();
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          statusCode: 422,
          name: "validation_error",
          message: `Invalid \`to\` field: ${USER_EMAIL}`,
        }),
        { status: 422, headers: { "content-type": "application/json" } }
      )
    );

    const res = await POST(jsonRequest({ email: USER_EMAIL }));
    const token = fake.createdTokens[0];

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.deepEqual(logs, [
      {
        level: "error",
        text: "[forgot-password] Failed to send the reset email: name=validation_error status=422",
      },
    ]);
    assert.ok(!logs[0].text.includes("Invalid"), "error.message is not logged");
    assert.deepEqual(findLeaks(logs, secretsFor(token)), []);
  });

  it("fetch throws: resend@6 turns it into { error }, logged as application_error without status", async () => {
    mock.restoreAll();
    logs = captureConsole();
    mock.method(globalThis, "fetch", async () => {
      throw new TypeError(`fetch failed for ${USER_EMAIL}`);
    });

    const res = await POST(jsonRequest({ email: USER_EMAIL }));
    const token = fake.createdTokens[0];

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.deepEqual(logs, [
      {
        level: "error",
        text: "[forgot-password] Failed to send the reset email: name=application_error status=none",
      },
    ]);
    assert.deepEqual(findLeaks(logs, secretsFor(token)), []);
  });

  it("send throws: still {success:true} (no 500 only for registered users), logs the error name only", async () => {
    mock.restoreAll();
    logs = captureConsole();
    let fetchCalls = 0;
    mock.method(globalThis, "fetch", async () => {
      fetchCalls++;
      throw new Error("network access is not allowed in tests");
    });
    for (const ResendClass of resendClasses) {
      mock.method(ResendClass.prototype, "post", async () => {
        throw new TypeError(`send failed for ${USER_EMAIL} ${API_KEY}`);
      });
    }

    const res = await POST(jsonRequest({ email: USER_EMAIL }));
    const token = fake.createdTokens[0];

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.equal(fetchCalls, 0);
    assert.deepEqual(logs, [
      { level: "error", text: "[forgot-password] Failed to send the reset email: threw TypeError" },
    ]);
    assert.deepEqual(findLeaks(logs, secretsFor(token)), []);
  });

  it("Resend client creation throws: still {success:true} (not 500), logs the error name only", async () => {
    // The Resend constructor starts with `this.key = key`, so a throwing setter on the
    // prototype makes `new Resend(...)` throw. Both CJS and ESM builds are patched.
    const patched: ResendCtor[] = [];
    try {
      for (const ResendClass of resendClasses) {
        Object.defineProperty(ResendClass.prototype, "key", {
          configurable: true,
          set() {
            throw new RangeError(`constructor failed for ${USER_EMAIL} ${API_KEY}`);
          },
        });
        patched.push(ResendClass);
      }

      const res = await POST(jsonRequest({ email: USER_EMAIL }));
      const token = fake.createdTokens[0];

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { success: true });
      assert.equal(sent.length, 0);
      assert.deepEqual(logs, [
        { level: "error", text: "[forgot-password] Failed to send the reset email: threw RangeError" },
      ]);
      assert.deepEqual(findLeaks(logs, secretsFor(token)), []);
    } finally {
      for (const ResendClass of patched) {
        delete (ResendClass.prototype as unknown as Record<string, unknown>).key;
      }
    }
  });

  it("unknown email: no mail is sent, same response", async () => {
    const res = await POST(jsonRequest({ email: "nobody-12@example.com" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.equal(sent.length, 0);
    assert.deepEqual(logs, []);
  });
});
