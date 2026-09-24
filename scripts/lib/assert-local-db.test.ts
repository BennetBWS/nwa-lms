import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertLocalDatabase } from "./assert-local-db";

// Dummy URLs only. Never put real connection strings here.
const LOCAL_URL = "postgresql://user:dummy@localhost:5432/db";
const REMOTE_PASSWORD = "dummy-secret-Pa55";
const REMOTE_URL = `postgresql://remoteuser:${REMOTE_PASSWORD}@db.example.invalid:5432/db`;

// Next.js types NODE_ENV as read-only; write through a plain record view.
const env: Record<string, string | undefined> = process.env;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

describe("assertLocalDatabase", () => {
  let savedNodeEnv: string | undefined;
  let savedVercelEnv: string | undefined;

  beforeEach(() => {
    savedNodeEnv = env.NODE_ENV;
    savedVercelEnv = env.VERCEL_ENV;
    setEnv("VERCEL_ENV", undefined);
    setEnv("NODE_ENV", "development");
  });

  afterEach(() => {
    setEnv("NODE_ENV", savedNodeEnv);
    setEnv("VERCEL_ENV", savedVercelEnv);
  });

  it("allows local hosts", () => {
    assert.doesNotThrow(() => assertLocalDatabase([LOCAL_URL]));
    assert.doesNotThrow(() =>
      assertLocalDatabase([
        "postgresql://user:dummy@127.0.0.1:5432/db",
        "postgresql://user:dummy@[::1]:5432/db",
        "postgresql://user:dummy@host.docker.internal:5432/db",
        "postgresql://user:dummy@LOCALHOST:5432/db",
      ])
    );
  });

  it("skips undefined entries when at least one URL is set", () => {
    assert.doesNotThrow(() => assertLocalDatabase([LOCAL_URL, undefined]));
  });

  it("rejects a remote host", () => {
    assert.throws(() => assertLocalDatabase([REMOTE_URL]), /db\.example\.invalid/);
  });

  it("rejects when any one of the URLs is remote", () => {
    assert.throws(() => assertLocalDatabase([LOCAL_URL, REMOTE_URL]), /not local/);
  });

  it("rejects hosts that only look local", () => {
    assert.throws(() =>
      assertLocalDatabase(["postgresql://user:dummy@localhost.example.invalid:5432/db"])
    );
  });

  it("rejects when NODE_ENV is production", () => {
    setEnv("NODE_ENV", "production");
    assert.throws(() => assertLocalDatabase([LOCAL_URL]), /production/);
  });

  it("rejects when VERCEL_ENV is set", () => {
    setEnv("VERCEL_ENV", "preview");
    assert.throws(() => assertLocalDatabase([LOCAL_URL]), /VERCEL_ENV/);
  });

  it("rejects when all URLs are undefined", () => {
    assert.throws(() => assertLocalDatabase([undefined, undefined]), /no database URL/);
    assert.throws(() => assertLocalDatabase([]), /no database URL/);
  });

  it("rejects unparsable URLs", () => {
    assert.throws(() => assertLocalDatabase(["not a url"]), /could not be parsed/);
  });

  it("does not leak credentials or the full URL in error messages", () => {
    const cases = [REMOTE_URL, `${REMOTE_PASSWORD}-not-a-url`];
    for (const url of cases) {
      try {
        assertLocalDatabase([url]);
        assert.fail("expected assertLocalDatabase to throw");
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.ok(!err.message.includes(REMOTE_PASSWORD), "message must not contain the password");
        assert.ok(!err.message.includes("remoteuser"), "message must not contain the username");
        assert.ok(!err.message.includes(url), "message must not contain the full URL");
      }
    }
  });
});
