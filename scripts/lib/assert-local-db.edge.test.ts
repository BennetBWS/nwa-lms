import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertLocalDatabase } from "./assert-local-db";

// Dummy URLs only. Never put real connection strings here.
const SECRET = "dummy-Secret-Pw-9x";
const USER = "dummyremoteuser";
const LOCAL_URL = "postgresql://user:dummy@localhost:5432/db";
const REMOTE_HOST = "db.example.invalid";

// Next.js types NODE_ENV as read-only; write through a plain record view.
const env: Record<string, string | undefined> = process.env;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function messageOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Error, "must throw an Error");
    return err.message;
  }
  assert.fail("expected assertLocalDatabase to throw");
}

function assertNoLeak(message: string, url: string): void {
  assert.ok(!message.includes(SECRET), `message must not contain the password: ${message}`);
  assert.ok(!message.includes(USER), `message must not contain the username: ${message}`);
  assert.ok(!message.includes(url), `message must not contain the full URL: ${message}`);
  assert.ok(!message.includes("?"), `message must not contain a query string: ${message}`);
  assert.ok(!message.includes("5432"), `message must not contain the port: ${message}`);
  assert.ok(!message.includes("/db"), `message must not contain the database path: ${message}`);
}

describe("assertLocalDatabase (edge cases)", () => {
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

  describe("DATABASE_URL / DIRECT_URL combinations", () => {
    it("rejects when only DIRECT_URL is remote (DATABASE_URL local)", () => {
      const direct = `postgresql://${USER}:${SECRET}@${REMOTE_HOST}:5432/db`;
      const msg = messageOf(() => assertLocalDatabase([LOCAL_URL, direct]));
      assert.match(msg, /db\.example\.invalid/);
      assertNoLeak(msg, direct);
    });

    it("rejects when only DATABASE_URL is remote (DIRECT_URL local)", () => {
      const pooled = `postgresql://${USER}:${SECRET}@${REMOTE_HOST}:6543/db?pgbouncer=true`;
      const msg = messageOf(() => assertLocalDatabase([pooled, LOCAL_URL]));
      assert.match(msg, /db\.example\.invalid/);
      assertNoLeak(msg, pooled);
    });

    it("with DATABASE_URL undefined, decides by DIRECT_URL alone", () => {
      assert.doesNotThrow(() => assertLocalDatabase([undefined, LOCAL_URL]));
      assert.throws(() =>
        assertLocalDatabase([undefined, `postgresql://u:p@${REMOTE_HOST}/db`])
      );
    });

    it("rejects an empty-string URL even when the other URL is local (fail-safe)", () => {
      const msg = messageOf(() => assertLocalDatabase([LOCAL_URL, ""]));
      assert.match(msg, /#2 could not be parsed/);
    });
  });

  describe("credentials never appear in error messages", () => {
    const cases: Array<[string, string]> = [
      ["user + password", `postgresql://${USER}:${SECRET}@${REMOTE_HOST}:5432/db`],
      ["password in query string", `postgresql://${REMOTE_HOST}:5432/db?user=${USER}&password=${SECRET}`],
      ["password in query with sslmode", `postgres://${USER}@${REMOTE_HOST}:5432/db?sslmode=require&password=${SECRET}`],
      ["percent-encoded password", `postgresql://${USER}:${encodeURIComponent(SECRET + "@#/")}@${REMOTE_HOST}:5432/db`],
      ["password in fragment", `postgresql://${REMOTE_HOST}:5432/db#${SECRET}`],
      ["unparsable URL containing password", `${USER}:${SECRET}@${REMOTE_HOST}:5432/db`],
      ["garbage with spaces", `postgresql://${USER}:${SECRET}@ bad host/db`],
    ];

    for (const [name, url] of cases) {
      it(name, () => {
        const msg = messageOf(() => assertLocalDatabase([url]));
        assertNoLeak(msg, url);
      });
    }

    it("NODE_ENV=production message does not include the URL", () => {
      setEnv("NODE_ENV", "production");
      const url = `postgresql://${USER}:${SECRET}@localhost:5432/db`;
      const msg = messageOf(() => assertLocalDatabase([url]));
      assertNoLeak(msg, url);
    });

    it("VERCEL_ENV message does not include the URL", () => {
      setEnv("VERCEL_ENV", "production");
      const url = `postgresql://${USER}:${SECRET}@localhost:5432/db`;
      const msg = messageOf(() => assertLocalDatabase([url]));
      assertNoLeak(msg, url);
    });
  });

  describe("schemes", () => {
    it("accepts local hosts with both postgres:// and postgresql://", () => {
      assert.doesNotThrow(() =>
        assertLocalDatabase([
          "postgres://user:dummy@localhost:5432/db",
          "postgresql://user:dummy@localhost:5432/db",
          "postgres://user:dummy@127.0.0.1:5432/db",
          "postgres://user:dummy@[::1]:5432/db",
        ])
      );
    });

    it("rejects remote hosts with both postgres:// and postgresql://", () => {
      assert.throws(() => assertLocalDatabase([`postgres://u:p@${REMOTE_HOST}:5432/db`]), /not local/);
      assert.throws(() => assertLocalDatabase([`postgresql://u:p@${REMOTE_HOST}:5432/db`]), /not local/);
    });
  });

  describe("host forms", () => {
    it("accepts IPv6 loopback with and without port, and in expanded form", () => {
      assert.doesNotThrow(() =>
        assertLocalDatabase([
          "postgresql://user:dummy@[::1]:5432/db",
          "postgresql://user:dummy@[::1]/db",
          "postgresql://user:dummy@[0:0:0:0:0:0:0:1]:5432/db",
        ])
      );
    });

    it("accepts local hosts without a port", () => {
      assert.doesNotThrow(() =>
        assertLocalDatabase([
          "postgresql://user:dummy@localhost/db",
          "postgresql://user:dummy@127.0.0.1/db",
          "postgresql://user:dummy@host.docker.internal/db",
        ])
      );
    });

    it("accepts upper/mixed-case local hosts", () => {
      assert.doesNotThrow(() =>
        assertLocalDatabase([
          "postgresql://user:dummy@LocalHost:5432/db",
          "postgresql://user:dummy@HOST.DOCKER.INTERNAL:5432/db",
        ])
      );
    });

    it("rejects upper-case remote hosts and shows the host in lower case", () => {
      const msg = messageOf(() =>
        assertLocalDatabase([`postgresql://${USER}:${SECRET}@DB.Example.INVALID:5432/db`])
      );
      assert.match(msg, /"db\.example\.invalid"/);
    });

    it("rejects remote hosts without a port", () => {
      assert.throws(() => assertLocalDatabase([`postgresql://u:p@${REMOTE_HOST}/db`]), /not local/);
    });

    it("rejects other loopback-ish / wildcard addresses that are not allow-listed", () => {
      for (const host of ["0.0.0.0", "127.0.0.2", "127.1", "localhost.", "[::]", "[::ffff:127.0.0.1]"]) {
        assert.throws(
          () => assertLocalDatabase([`postgresql://u:p@${host}:5432/db`]),
          /not local|could not be parsed/,
          host
        );
      }
    });

    it("is not fooled by userinfo / fragment tricks", () => {
      assert.throws(
        () => assertLocalDatabase([`postgresql://u:p@localhost@${REMOTE_HOST}/db`]),
        /db\.example\.invalid/
      );
      assert.throws(
        () => assertLocalDatabase([`postgresql://${REMOTE_HOST}#@localhost/db`]),
        /db\.example\.invalid/
      );
    });
  });

  describe("invalid input", () => {
    it("rejects an empty string", () => {
      assert.throws(() => assertLocalDatabase([""]), /could not be parsed/);
    });

    it("rejects a URL without a host", () => {
      assert.throws(() => assertLocalDatabase(["postgresql://"]), /\(empty\)/);
      assert.throws(() => assertLocalDatabase(["postgresql:///db"]), /\(empty\)/);
    });

    it("rejects a scheme-less host:port string", () => {
      assert.throws(() => assertLocalDatabase(["localhost:5432/db"]), /not local|could not be parsed/);
    });

    it("rejects plain garbage", () => {
      assert.throws(() => assertLocalDatabase(["not a url"]), /could not be parsed/);
      assert.throws(() => assertLocalDatabase(["   "]), /could not be parsed/);
    });

    it("reports the index of the unparsable URL", () => {
      assert.throws(() => assertLocalDatabase([LOCAL_URL, "not a url"]), /#2/);
    });
  });

  describe("known gaps (reported, not fixed here)", () => {
    // Prisma (quaint) honours a `host` query parameter and connects there instead of the
    // URL authority host. The guard only checks the authority host, so this URL passes
    // the guard but Prisma would connect to db.example.invalid.
    // Verified manually: seed-step1.ts with `...@localhost:1/db?host=127.0.0.2`
    // fails with "Can't reach database server at `127.0.0.2:1`".
    it(
      "rejects a local URL whose `host` query parameter points to a remote host",
      { todo: "guard ignores ?host= query parameter (bug reported to implementer)" },
      () => {
        assert.throws(() =>
          assertLocalDatabase([`postgresql://u:p@localhost:5432/db?host=${REMOTE_HOST}`])
        );
      }
    );
  });
});
