import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildResetUrl, readMailConfig, type MailConfigResult } from "./mail-config";

// Dummy values only (example.test). Never put real keys or addresses here.
const KEY = "re_dummy_key_for_mail_config_tests";
const FROM = "Next World Academy <no-reply@mail.example.test>";
const BASE = "https://lms.example.test";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    RESEND_API_KEY: KEY,
    MAIL_FROM: FROM,
    APP_BASE_URL: BASE,
    ...overrides,
  };
  const out: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  return out;
}

function expectOk(result: MailConfigResult) {
  if (result.ok === false) {
    assert.fail(`expected ok, got missing=${result.missing.join(",")} invalid=${result.invalid.join(",")}`);
  }
  return result.config;
}

function expectNg(result: MailConfigResult) {
  if (result.ok === true) assert.fail("expected not ok");
  return result;
}

describe("readMailConfig", () => {
  it("returns the config when all required variables are valid", () => {
    assert.deepEqual(expectOk(readMailConfig(env())), { apiKey: KEY, from: FROM, appBaseUrl: BASE });
  });

  it("includes replyTo only when MAIL_REPLY_TO is set", () => {
    assert.equal(expectOk(readMailConfig(env({ MAIL_REPLY_TO: "  " }))).replyTo, undefined);
    assert.equal(
      expectOk(readMailConfig(env({ MAIL_REPLY_TO: "support@example.test" }))).replyTo,
      "support@example.test"
    );
  });

  it("reports every missing variable by name (blank counts as missing)", () => {
    const r = expectNg(
      readMailConfig(env({ RESEND_API_KEY: undefined, MAIL_FROM: undefined, APP_BASE_URL: undefined }))
    );
    assert.deepEqual(r.missing, ["RESEND_API_KEY", "MAIL_FROM", "APP_BASE_URL"]);
    assert.deepEqual(r.invalid, []);

    const blank = expectNg(readMailConfig(env({ RESEND_API_KEY: "   ", MAIL_FROM: "" })));
    assert.deepEqual(blank.missing, ["RESEND_API_KEY", "MAIL_FROM"]);
  });

  it("does not include any value in the result when not ok", () => {
    const r = expectNg(
      readMailConfig(env({ MAIL_FROM: "no-at-sign", APP_BASE_URL: "https://user:pw@lms.example.test" }))
    );
    const json = JSON.stringify(r);
    for (const v of [KEY, "no-at-sign", "lms.example.test", "user:pw"]) {
      assert.ok(!json.includes(v), `result must not contain ${v}`);
    }
  });

  describe("MAIL_FROM", () => {
    it("accepts `addr` and `Display Name <addr>` (Japanese / spaces allowed)", () => {
      for (const from of [
        "no-reply@mail.example.test",
        "Next World Academy <no-reply@mail.example.test>",
        "ネクストワールド アカデミー <no-reply@mail.example.test>",
        "<no-reply@mail.example.test>",
      ]) {
        assert.equal(expectOk(readMailConfig(env({ MAIL_FROM: from }))).from, from);
      }
    });

    it("trims surrounding spaces", () => {
      assert.equal(expectOk(readMailConfig(env({ MAIL_FROM: `  ${FROM}  ` }))).from, FROM);
    });

    it("rejects line breaks and values without @", () => {
      for (const from of [
        "no-reply@mail.example.test\r\nBcc: x@example.test",
        "Name\n <no-reply@mail.example.test>",
        "no-reply@mail.example.test\n",
        "no-reply.example.test",
        "Name <no-reply.example.test>",
        "Name <a@example.test",
        "a b@example.test",
      ]) {
        assert.deepEqual(expectNg(readMailConfig(env({ MAIL_FROM: from }))).invalid, ["MAIL_FROM"], from);
      }
    });
  });

  describe("MAIL_REPLY_TO", () => {
    it("rejects line breaks and values without @", () => {
      for (const replyTo of ["support@example.test\nBcc: x@example.test", "support.example.test"]) {
        assert.deepEqual(
          expectNg(readMailConfig(env({ MAIL_REPLY_TO: replyTo }))).invalid,
          ["MAIL_REPLY_TO"],
          replyTo
        );
      }
    });
  });

  describe("APP_BASE_URL", () => {
    it("normalizes a trailing slash to the origin", () => {
      assert.equal(expectOk(readMailConfig(env({ APP_BASE_URL: `${BASE}/` }))).appBaseUrl, BASE);
      assert.equal(
        expectOk(readMailConfig(env({ APP_BASE_URL: "https://LMS.Example.Test:443/" }))).appBaseUrl,
        BASE
      );
    });

    it("rejects non-http(s) schemes, paths, queries, fragments and credentials", () => {
      for (const url of [
        "javascript:alert(1)",
        "data:text/html,hi",
        "ftp://lms.example.test",
        "lms.example.test",
        "not a url",
        `${BASE}/app`,
        `${BASE}/reset-password`,
        `${BASE}//`,
        `${BASE}/?x=1`,
        `${BASE}?`,
        `${BASE}/#top`,
        `${BASE}#`,
        "https://user@lms.example.test",
        "https://user:pw@lms.example.test",
        "http://lms.example.test",
      ]) {
        assert.deepEqual(expectNg(readMailConfig(env({ APP_BASE_URL: url }))).invalid, ["APP_BASE_URL"], url);
      }
    });

    it("allows http only for localhost / 127.0.0.1 outside production", () => {
      assert.equal(
        expectOk(readMailConfig(env({ APP_BASE_URL: "http://localhost:3000" }))).appBaseUrl,
        "http://localhost:3000"
      );
      assert.equal(
        expectOk(readMailConfig(env({ APP_BASE_URL: "http://127.0.0.1:3000/", VERCEL_ENV: "preview" })))
          .appBaseUrl,
        "http://127.0.0.1:3000"
      );
      for (const url of ["http://localhost:3000", "http://127.0.0.1"]) {
        assert.deepEqual(
          expectNg(readMailConfig(env({ APP_BASE_URL: url, VERCEL_ENV: "production" }))).invalid,
          ["APP_BASE_URL"],
          url
        );
      }
    });

    it("https is accepted in production", () => {
      assert.equal(
        expectOk(readMailConfig(env({ VERCEL_ENV: "production" }))).appBaseUrl,
        BASE
      );
    });
  });

  it("reports missing and invalid together", () => {
    const r = expectNg(
      readMailConfig(env({ MAIL_FROM: undefined, APP_BASE_URL: "javascript:alert(1)", MAIL_REPLY_TO: "x" }))
    );
    assert.deepEqual(r.missing, ["MAIL_FROM"]);
    assert.deepEqual(r.invalid, ["APP_BASE_URL", "MAIL_REPLY_TO"]);
  });

  it("defaults to process.env", () => {
    const saved = { ...process.env };
    try {
      delete process.env.RESEND_API_KEY;
      delete process.env.MAIL_FROM;
      delete process.env.APP_BASE_URL;
      assert.deepEqual(expectNg(readMailConfig()).missing, ["RESEND_API_KEY", "MAIL_FROM", "APP_BASE_URL"]);
    } finally {
      for (const k of ["RESEND_API_KEY", "MAIL_FROM", "APP_BASE_URL"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("buildResetUrl", () => {
  it("builds <base>/reset-password?token=<token>", () => {
    const token = "0f0e0d0c-0b0a-4908-8706-050403020100";
    assert.equal(buildResetUrl(BASE, token), `${BASE}/reset-password?token=${token}`);
    assert.equal(
      buildResetUrl("http://localhost:3000", token),
      `http://localhost:3000/reset-password?token=${token}`
    );
  });

  it("encodes the token as a query parameter", () => {
    assert.equal(
      buildResetUrl(BASE, "a&b=c #d"),
      `${BASE}/reset-password?token=a%26b%3Dc+%23d`
    );
  });
});
