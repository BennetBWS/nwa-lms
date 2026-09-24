import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

// End-to-end checks for the destructive seed scripts.
//
// SAFETY: every run sets BOTH DATABASE_URL and DIRECT_URL explicitly to dummy values.
// Prisma's .env loading never overrides variables that are already set, so the real
// connection strings in .env are never used. Remote hosts are *.invalid (unresolvable)
// and are rejected by the guard before any connection. localhost:1 is not a database;
// connecting there only produces "Can't reach database server".

const ROOT = path.resolve(__dirname, "..", "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const SECRET = "dummySecretPw42";

const SCRIPTS = ["prisma/seed.ts", "scripts/seed-step1.ts"];

function run(script: string, databaseUrl: string, directUrl: string) {
  // Plain record view: Next.js types NODE_ENV as read-only.
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
  };
  delete childEnv.NODE_ENV;
  delete childEnv.VERCEL_ENV;
  const res = spawnSync(TSX, [script], {
    cwd: ROOT,
    env: childEnv as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 90_000,
  });
  return { code: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

for (const script of SCRIPTS) {
  describe(`${script} guard`, () => {
    it("exits 1 without leaking the password when both URLs are remote", () => {
      const url = `postgresql://u:${SECRET}@db.example.invalid:5432/db?password=${SECRET}`;
      const { code, output } = run(script, url, url);
      assert.equal(code, 1, output);
      assert.match(output, /Refusing to run: database host "db\.example\.invalid" is not local/);
      assert.ok(!output.includes(SECRET), "output must not contain the password");
    });

    it("exits 1 when only DIRECT_URL is remote (postgres:// scheme)", () => {
      const local = `postgresql://u:${SECRET}@localhost:1/db`;
      const remote = `postgres://u:${SECRET}@db.example.invalid:5432/db`;
      const { code, output } = run(script, local, remote);
      assert.equal(code, 1, output);
      assert.match(output, /Refusing to run/);
      assert.doesNotMatch(output, /Can't reach database server/, "guard must stop before any query");
      assert.ok(!output.includes(SECRET), "output must not contain the password");
    });

    it("exits 1 without leaking the password when the local DB is not running (localhost:1)", () => {
      const url = `postgresql://u:${SECRET}@localhost:1/db?password=${SECRET}`;
      const { code, output } = run(script, url, url);
      assert.equal(code, 1, output);
      assert.match(output, /Can't reach database server at `localhost:1`/);
      assert.ok(!output.includes(SECRET), "output must not contain the password");
    });
  });
}
