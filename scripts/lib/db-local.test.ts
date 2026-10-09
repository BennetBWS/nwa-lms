import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  PRISMA_ARGS,
  describeDatabaseUrl,
  formatDatabaseTargets,
  runLocalPrisma,
  type DbEnv,
  type SpawnLike,
} from "./db-local";

// SAFETY: dummy URLs only. Remote hosts are *.invalid (unresolvable). The fake spawn
// never starts a process, and the end-to-end runs below only use remote dummy URLs,
// which the guard rejects before prisma is started. No DB / network is touched.

const SECRET = "dummySecretPw42x";
const USER = "dummyuser";
const DB_NAME = "dummydbname";
const QUERY_VALUE = "dummyQueryValue";

const POOLER_URL = `postgresql://${USER}.abc:${SECRET}@aws-0-region.pooler.example.invalid:6543/${DB_NAME}?pgbouncer=true&sslmode=${QUERY_VALUE}`;
const DIRECT_URL = `postgresql://${USER}:${SECRET}@db.abc.example.invalid:5432/${DB_NAME}?sslmode=${QUERY_VALUE}`;
const LOCAL_URL = `postgresql://${USER}:${SECRET}@127.0.0.1:54322/${DB_NAME}`;

const env: Record<string, string | undefined> = process.env;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function assertNoLeak(text: string): void {
  assert.ok(!text.includes(SECRET), `must not contain the password: ${text}`);
  assert.ok(!text.includes(USER), `must not contain the username: ${text}`);
  assert.ok(!text.includes(DB_NAME), `must not contain the database name: ${text}`);
  assert.ok(!text.includes(QUERY_VALUE), `must not contain query values: ${text}`);
  assert.ok(!text.includes("pgbouncer"), `must not contain the query string: ${text}`);
}

describe("describeDatabaseUrl (db:where)", () => {
  it("shows only host:port for a pooler URL", () => {
    const out = describeDatabaseUrl(POOLER_URL);
    assert.equal(out, "aws-0-region.pooler.example.invalid:6543");
    assertNoLeak(out);
  });

  it("shows only host:port for a direct URL", () => {
    const out = describeDatabaseUrl(DIRECT_URL);
    assert.equal(out, "db.abc.example.invalid:5432");
    assertNoLeak(out);
  });

  it("shows only host:port for the local Supabase DB", () => {
    assert.equal(describeDatabaseUrl(LOCAL_URL), "127.0.0.1:54322");
    assert.equal(describeDatabaseUrl(`postgresql://${USER}:${SECRET}@LocalHost:5432/x`), "localhost:5432");
  });

  it("says when the port is omitted", () => {
    assert.equal(describeDatabaseUrl(`postgresql://${USER}:${SECRET}@localhost/${DB_NAME}`), "localhost:(ポート指定なし)");
  });

  it("reports an unset variable", () => {
    assert.equal(describeDatabaseUrl(undefined), "未設定");
  });

  it("reports broken URLs without echoing them", () => {
    for (const raw of ["", "not a url", `${SECRET}@@`, `postgresql://${USER}:${SECRET}@[bad/${DB_NAME}`]) {
      const out = describeDatabaseUrl(raw);
      assert.match(out, /解析できない URL/);
      assertNoLeak(out);
    }
  });

  it("warns when a query parameter overrides the host, without its value", () => {
    const out = describeDatabaseUrl(`postgresql://${USER}:${SECRET}@localhost:5432/${DB_NAME}?HOST=${QUERY_VALUE}`);
    assert.match(out, /^localhost:5432（注意: /);
    assertNoLeak(out);
  });
});

describe("formatDatabaseTargets (db:where)", () => {
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

  it("prints both variables and that the guard passes for the local DB", () => {
    const lines = formatDatabaseTargets({ DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL });
    assert.deepEqual(lines.slice(0, 2), ["DATABASE_URL: 127.0.0.1:54322", "DIRECT_URL: 127.0.0.1:54322"]);
    assert.match(lines[2], /ガード: 通る/);
    assertNoLeak(lines.join("\n"));
  });

  it("prints that the guard refuses for remote URLs, without credentials", () => {
    const lines = formatDatabaseTargets({ DATABASE_URL: POOLER_URL, DIRECT_URL: DIRECT_URL });
    assert.equal(lines[0], "DATABASE_URL: aws-0-region.pooler.example.invalid:6543");
    assert.equal(lines[1], "DIRECT_URL: db.abc.example.invalid:5432");
    assert.match(lines[2], /ガード: 拒否/);
    assertNoLeak(lines.join("\n"));
  });

  it("handles unset variables", () => {
    const lines = formatDatabaseTargets({});
    assert.deepEqual(lines.slice(0, 2), ["DATABASE_URL: 未設定", "DIRECT_URL: 未設定"]);
    assert.match(lines[2], /ガード: 拒否.*no database URL/);
  });
});

type Call = { command: string; args: string[]; env: DbEnv; cwd: string };

function fakeSpawn(status: number | null = 0, error?: Error) {
  const calls: Call[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, env: options.env, cwd: options.cwd });
    assert.equal(options.stdio, "inherit");
    return { status, error };
  };
  return { spawn, calls };
}

describe("runLocalPrisma (db:local:deploy / db:local:reset)", () => {
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

  function run(command: "deploy" | "reset", dbEnv: DbEnv, spawn: SpawnLike) {
    const errors: string[] = [];
    const code = runLocalPrisma(command, {
      env: dbEnv,
      spawn,
      prismaBin: "/fake/prisma",
      cwd: "/fake/root",
      logError: (m) => errors.push(m),
    });
    return { code, errors };
  }

  const refusals: Array<[string, DbEnv]> = [
    ["both remote", { DATABASE_URL: POOLER_URL, DIRECT_URL: DIRECT_URL }],
    ["only DIRECT_URL remote", { DATABASE_URL: LOCAL_URL, DIRECT_URL: DIRECT_URL }],
    ["only DATABASE_URL remote", { DATABASE_URL: POOLER_URL, DIRECT_URL: LOCAL_URL }],
    ["both unset", {}],
    ["broken URL", { DATABASE_URL: "not a url", DIRECT_URL: LOCAL_URL }],
    ["host override in query", { DATABASE_URL: `${LOCAL_URL}?host=db.example.invalid`, DIRECT_URL: LOCAL_URL }],
  ];

  for (const command of ["deploy", "reset"] as const) {
    for (const [name, dbEnv] of refusals) {
      it(`${command}: does not start prisma when ${name}`, () => {
        const { spawn, calls } = fakeSpawn();
        const { code, errors } = run(command, dbEnv, spawn);
        assert.equal(code, 1);
        assert.equal(calls.length, 0, "prisma must not be started");
        assert.equal(errors.length, 1);
        assert.match(errors[0], /Refusing to run/);
        assertNoLeak(errors[0]);
      });
    }

    it(`${command}: does not start prisma when NODE_ENV is production`, () => {
      setEnv("NODE_ENV", "production");
      const { spawn, calls } = fakeSpawn();
      assert.equal(run(command, { DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL }, spawn).code, 1);
      assert.equal(calls.length, 0);
    });

    it(`${command}: does not start prisma when VERCEL_ENV is set`, () => {
      setEnv("VERCEL_ENV", "development");
      const { spawn, calls } = fakeSpawn();
      assert.equal(run(command, { DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL }, spawn).code, 1);
      assert.equal(calls.length, 0);
    });
  }

  it("deploy: starts `prisma migrate deploy` with the checked env for the local DB", () => {
    const { spawn, calls } = fakeSpawn(0);
    const dbEnv = { DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL };
    const { code, errors } = run("deploy", dbEnv, spawn);
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/fake/prisma");
    assert.deepEqual(calls[0].args, ["migrate", "deploy"]);
    assert.equal(calls[0].cwd, "/fake/root");
    assert.equal(calls[0].env, dbEnv, "the child must get exactly the env that was checked");
  });

  it("reset: starts `prisma migrate reset --force` for the local DB", () => {
    const { spawn, calls } = fakeSpawn(0);
    const { code } = run("reset", { DATABASE_URL: "postgresql://u:p@localhost:54322/postgres", DIRECT_URL: LOCAL_URL }, spawn);
    assert.equal(code, 0);
    assert.deepEqual(calls[0].args, ["migrate", "reset", "--force"]);
  });

  it("passes through prisma's exit code, and fails when prisma cannot start", () => {
    const local = { DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL };
    assert.equal(run("deploy", local, fakeSpawn(3).spawn).code, 3);
    assert.equal(run("deploy", local, fakeSpawn(null).spawn).code, 1);
    const failed = run("deploy", local, fakeSpawn(null, new Error("ENOENT")).spawn);
    assert.equal(failed.code, 1);
    assert.match(failed.errors[0], /prisma を起動できなかった/);
  });

  it("never runs `migrate dev` or `db push`", () => {
    for (const args of Object.values(PRISMA_ARGS)) {
      assert.ok(!args.includes("dev"));
      assert.ok(!args.includes("push"));
      assert.ok(!args.includes("db"));
    }
  });
});

const ROOT = path.resolve(__dirname, "..", "..");

describe("package.json db scripts", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  it("no longer has the unguarded db:migrate (prisma migrate dev)", () => {
    assert.equal(pkg.scripts["db:migrate"], undefined);
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      assert.doesNotMatch(cmd, /prisma\s+migrate/, `${name} must not call prisma migrate directly`);
      assert.doesNotMatch(cmd, /prisma\s+db\s/, `${name} must not call prisma db directly`);
    }
  });

  it("routes the DB scripts through scripts/db-local.ts", () => {
    assert.equal(pkg.scripts["db:where"], "tsx scripts/db-local.ts where");
    assert.equal(pkg.scripts["db:local:deploy"], "tsx scripts/db-local.ts deploy");
    assert.equal(pkg.scripts["db:local:reset"], "tsx scripts/db-local.ts reset");
    assert.equal(pkg.scripts["db:seed"], "npx tsx prisma/seed.ts");
  });
});

// End-to-end: run the real entry point. Both URLs are set explicitly to dummy values;
// Prisma's .env loading never overrides variables that are already set.
describe("scripts/db-local.ts (end-to-end, remote dummy URLs only)", () => {
  const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

  function runScript(sub: string, extra: DbEnv = {}) {
    const childEnv: DbEnv = { ...process.env, DATABASE_URL: POOLER_URL, DIRECT_URL: DIRECT_URL, ...extra };
    delete childEnv.NODE_ENV;
    delete childEnv.VERCEL_ENV;
    const res = spawnSync(TSX, ["scripts/db-local.ts", sub], {
      cwd: ROOT,
      env: childEnv as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 90_000,
    });
    return { code: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  }

  it("where: prints host:port only", () => {
    const { code, output } = runScript("where");
    assert.equal(code, 0, output);
    assert.match(output, /DATABASE_URL: aws-0-region\.pooler\.example\.invalid:6543/);
    assert.match(output, /DIRECT_URL: db\.abc\.example\.invalid:5432/);
    assert.match(output, /ガード: 拒否/);
    assertNoLeak(output);
  });

  for (const sub of ["deploy", "reset"]) {
    it(`${sub}: exits 1 before starting prisma`, () => {
      const { code, output } = runScript(sub);
      assert.equal(code, 1, output);
      assert.match(output, /Refusing to run: database host "aws-0-region\.pooler\.example\.invalid" is not local/);
      assert.doesNotMatch(output, /Prisma schema loaded|Datasource/, "prisma must not start");
      assertNoLeak(output);
    });
  }

  it("rejects an unknown subcommand", () => {
    const { code, output } = runScript("dev");
    assert.equal(code, 2, output);
    assert.match(output, /Usage/);
  });
});
