import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// End-to-end checks for scripts/verify-quiz-admin-db.ts (#81): it must refuse to run
// anywhere but a local database, before creating a PrismaClient or running any query.
//
// SAFETY: same approach as seed-scripts.test.ts. Every run sets BOTH DATABASE_URL and
// DIRECT_URL explicitly to dummy values; loading .env never overrides variables that are
// already set, so the real connection strings in .env are never used. Remote hosts are
// *.invalid (unresolvable) and are rejected by the guard before any connection.
// localhost:1 is not a database; connecting there only fails.

const ROOT = path.resolve(__dirname, "..", "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const SCRIPT = "scripts/verify-quiz-admin-db.ts";
const SECRET = "dummySecretPw42v";

function run(databaseUrl: string, directUrl: string, extra: Record<string, string> = {}) {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
  };
  delete childEnv.NODE_ENV;
  delete childEnv.VERCEL_ENV;
  Object.assign(childEnv, extra);
  const res = spawnSync(TSX, [SCRIPT], {
    cwd: ROOT,
    env: childEnv as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 90_000,
  });
  return { code: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function assertRefusedBeforeAnyQuery(output: string): void {
  assert.match(output, /Refusing to run/, "ガードの拒否の文が出ていない");
  assert.doesNotMatch(output, /Can't reach database server/, "ガードより先に DB へ接続しようとした");
  assert.doesNotMatch(output, /^(PASS|FAIL) /m, "ガードを通らずに確認を始めた");
  assert.ok(!output.includes(SECRET), "出力にパスワードが含まれている");
}

describe(`${SCRIPT} guard`, () => {
  it("exits 1 before any query when both URLs are remote", () => {
    const url = `postgresql://u:${SECRET}@db.example.invalid:5432/db?password=${SECRET}`;
    const { code, output } = run(url, url);
    assert.equal(code, 1, output);
    assert.match(output, /Refusing to run: database host "db\.example\.invalid" is not local/, output);
    assertRefusedBeforeAnyQuery(output);
  });

  it("exits 1 before any query when only DIRECT_URL is remote", () => {
    const local = `postgresql://u:${SECRET}@localhost:1/db`;
    const remote = `postgres://u:${SECRET}@db.example.invalid:5432/db`;
    const { code, output } = run(local, remote);
    assert.equal(code, 1, output);
    assertRefusedBeforeAnyQuery(output);
  });

  it("exits 1 before any query when only DATABASE_URL is remote", () => {
    const remote = `postgresql://u:${SECRET}@aws-0-region.pooler.example.invalid:6543/db?pgbouncer=true`;
    const local = `postgresql://u:${SECRET}@localhost:1/db`;
    const { code, output } = run(remote, local);
    assert.equal(code, 1, output);
    assertRefusedBeforeAnyQuery(output);
  });

  it("exits 1 without leaking the username when the password has an unencoded \"#\"", () => {
    const url = `postgresql://dummyverifyuser:1234#${SECRET}@db.example.invalid:5432/db`;
    const { code, output } = run(url, url);
    assert.equal(code, 1, output);
    assert.match(output, /Refusing to run: database URL #1 could not be parsed/, output);
    assertRefusedBeforeAnyQuery(output);
    for (const s of ["dummyverifyuser", "1234", "db.example.invalid"]) {
      assert.ok(!output.includes(s), `出力に "${s}" が含まれている`);
    }
  });

  it("exits 1 before any query when NODE_ENV is production, even with local URLs", () => {
    const local = `postgresql://u:${SECRET}@localhost:1/db`;
    const { code, output } = run(local, local, { NODE_ENV: "production" });
    assert.equal(code, 1, output);
    assertRefusedBeforeAnyQuery(output);
  });

  it("exits 1 before any query when VERCEL_ENV is set, even with local URLs", () => {
    const local = `postgresql://u:${SECRET}@localhost:1/db`;
    const { code, output } = run(local, local, { VERCEL_ENV: "production" });
    assert.equal(code, 1, output);
    assertRefusedBeforeAnyQuery(output);
  });

  it("exits 1 without leaking the password when the local DB is not running (localhost:1)", () => {
    const url = `postgresql://u:${SECRET}@localhost:1/db?password=${SECRET}`;
    const { code, output } = run(url, url);
    assert.equal(code, 1, output);
    assert.doesNotMatch(output, /^PASS /m, "DB がないのに PASS を出した");
    assert.match(output, /^FAIL /m, "DB に接続できないときに FAIL を出していない");
    assert.ok(!output.includes(SECRET), "出力にパスワードが含まれている");
  });
});

describe("package.json db:local:verify-quiz-admin", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

  it("runs the script with tsx", () => {
    assert.equal(pkg.scripts["db:local:verify-quiz-admin"], "tsx scripts/verify-quiz-admin-db.ts");
  });

  it("is not part of npm test (npm test does not connect to a DB)", () => {
    assert.ok(!pkg.scripts.test.includes("verify-quiz-admin"), "npm test に verify-quiz-admin が含まれている");
    // npm test のファイルの並び（scripts/lib/*.test.ts・src/lib/*.test.ts）に本体のスクリプトが入らない
    assert.ok(!SCRIPT.startsWith("scripts/lib/") && !SCRIPT.endsWith(".test.ts"), "本体のスクリプトが npm test の対象の場所にある");
  });
});
