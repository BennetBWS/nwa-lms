import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { assertLocalDatabase } from "./assert-local-db";
import {
  PRISMA_ARGS,
  describeDatabaseUrl,
  formatDatabaseTargets,
  isLocalPrismaCommand,
  runLocalPrisma,
  type DbEnv,
  type SpawnLike,
} from "./db-local";

// Edge cases for the local-DB scripts (#8).
//
// SAFETY: dummy URLs only. Remote hosts are *.invalid (unresolvable). The fake spawn never
// starts a process. The end-to-end runs ALWAYS pass both DATABASE_URL and DIRECT_URL as
// non-empty dummy values (enforced by `childEnvFor` below): if either were unset / empty,
// PrismaClient would load the real .env (production) into the child. Local dummy URLs use
// 127.0.0.1:1, which is not a database, and are only used where the guard must refuse.

const SECRET = "dummySecretPw42x";
const USER = "dummyuser";
const DB_NAME = "dummydbname";
const QUERY_VALUE = "dummyQueryValue";

const LOCAL_URL = `postgresql://${USER}:${SECRET}@127.0.0.1:54322/${DB_NAME}`;
const REMOTE_URL = `postgresql://${USER}:${SECRET}@db.example.invalid:5432/${DB_NAME}?sslmode=${QUERY_VALUE}`;

const ROOT = path.resolve(__dirname, "..", "..");

const env: Record<string, string | undefined> = process.env;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function assertNoLeak(text: string, extra: string[] = []): void {
  for (const s of [SECRET, USER, DB_NAME, QUERY_VALUE, ...extra]) {
    assert.ok(!text.includes(s), `must not contain "${s}": ${text}`);
  }
}

function withLocalProcessEnv() {
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
}

// ---------------------------------------------------------------------------
// 1. db:where never prints credentials, DB name or query values
// ---------------------------------------------------------------------------

describe("describeDatabaseUrl: URL forms", () => {
  const cases: Array<[string, string, string]> = [
    ["IPv6 loopback", `postgresql://${USER}:${SECRET}@[::1]:54322/${DB_NAME}`, "[::1]:54322"],
    ["IPv6 loopback, long form", `postgresql://${USER}:${SECRET}@[0:0:0:0:0:0:0:1]:54322/${DB_NAME}`, "[::1]:54322"],
    ["IPv6 remote", `postgresql://${USER}:${SECRET}@[2001:db8::1]:5432/${DB_NAME}?sslmode=${QUERY_VALUE}`, "[2001:db8::1]:5432"],
    [
      "URL-encoded symbols in the password",
      `postgresql://${USER}:${SECRET}%40%3A%2F%23%3F%25%26@db.example.invalid:5432/${DB_NAME}`,
      "db.example.invalid:5432",
    ],
    ["unencoded @ in the password", `postgresql://${USER}:${SECRET}@x@db.example.invalid:5432/${DB_NAME}`, "db.example.invalid:5432"],
    ["upper-case host", `postgresql://${USER}:${SECRET}@DB.Example.INVALID:5432/${DB_NAME}`, "db.example.invalid:5432"],
    ["comma-separated hosts without ports", `postgresql://${USER}:${SECRET}@localhost,db.example.invalid/${DB_NAME}`, "localhost,db.example.invalid:(ポート指定なし)"],
    ["no host (unix socket default)", `postgresql:///${DB_NAME}`, "(ホストなし):(ポート指定なし)"],
    ["prisma+postgres with api_key", `prisma+postgres://localhost:51213/?api_key=${QUERY_VALUE}`, "localhost:51213"],
    ["leading whitespace", ` postgresql://${USER}:${SECRET}@localhost:5432/${DB_NAME}`, "localhost:5432"],
  ];

  for (const [name, raw, expected] of cases) {
    it(`${name}: shows only "${expected}"`, () => {
      const out = describeDatabaseUrl(raw);
      assert.equal(out, expected);
      assertNoLeak(out);
    });
  }

  const overrides: Array<[string, string]> = [
    ["?host=", `postgresql://${USER}:${SECRET}@localhost:5432/${DB_NAME}?host=db.example.invalid`],
    ["?HOST= (upper case)", `postgresql://${USER}:${SECRET}@localhost:5432/${DB_NAME}?HOST=db.example.invalid`],
    ["?hostaddr=", `postgresql://${USER}:${SECRET}@localhost:5432/${DB_NAME}?hostaddr=10.0.0.1`],
    ["?h%6fst= (percent-encoded key)", `postgresql://${USER}:${SECRET}@localhost:5432/${DB_NAME}?h%6fst=db.example.invalid`],
    ["host after other params", `postgresql://${USER}:${SECRET}@localhost:5432/${DB_NAME}?sslmode=${QUERY_VALUE}&host=%2Fvar%2Frun%2Fpostgresql`],
  ];

  for (const [name, raw] of overrides) {
    it(`warns about a host override (${name}) without the value`, () => {
      const out = describeDatabaseUrl(raw);
      assert.match(out, /^localhost:5432（注意: クエリの host \/ hostaddr 指定で接続先が上書きされる）$/);
      assertNoLeak(out, ["db.example.invalid", "10.0.0.1", "postgresql%2F", "/var/run"]);
    });
  }

  const unparsable = [
    "",
    "   ",
    `${SECRET}`,
    `postgresql://${USER}:${SECRET}@localhost:5432,db.example.invalid:5432/${DB_NAME}`,
    `postgresql://${USER}:${SECRET}@/${DB_NAME}?host=/var/run/postgresql`,
    `postgresql://${USER}:${SECRET}@localhost:99999/${DB_NAME}`,
    `postgresql://${USER}:${SECRET}@localhost:port/${DB_NAME}`,
    `//${USER}:${SECRET}@localhost/${DB_NAME}`,
  ];

  for (const raw of unparsable) {
    it(`reports an unparsable URL without echoing it: ${JSON.stringify(raw.replace(SECRET, "***"))}`, () => {
      const out = describeDatabaseUrl(raw);
      assert.match(out, /解析できない URL/);
      assertNoLeak(out, ["localhost", "db.example.invalid", "/var/run"]);
    });
  }

  // KNOWN ISSUE (reported, production code not changed by the tester):
  // an UNENCODED "#", "/" or "?" in the password ends the authority early, so WHATWG URL
  // parses "user:<digits>" as host:port. db:where then prints the username (and the
  // leading digits of the password) as "host:port", and the guard message prints the
  // username as the "database host". CLAUDE.md requires URL-encoding, so this only
  // happens with a misconfigured .env, which is exactly when db:where is used.
  for (const sep of ["#", "/", "?"]) {
    it(
      `does not print the username when the password contains an unencoded "${sep}"`,
      { todo: "known issue: username / password digits shown as host:port (reported for #8)" },
      () => {
        const raw = `postgresql://${USER}:1234${sep}${SECRET}@db.example.invalid:5432/${DB_NAME}`;
        const out = formatDatabaseTargets({ DATABASE_URL: raw, DIRECT_URL: raw }).join("\n");
        assertNoLeak(out, ["1234"]);
      }
    );
  }
});

describe("formatDatabaseTargets: guard verdict", () => {
  withLocalProcessEnv();

  it("empty strings are reported as unparsable and refused", () => {
    const lines = formatDatabaseTargets({ DATABASE_URL: "", DIRECT_URL: "" });
    assert.deepEqual(lines.slice(0, 2), ["DATABASE_URL: 空（解析できない URL）", "DIRECT_URL: 空（解析できない URL）"]);
    assert.match(lines[2], /ガード: 拒否.*could not be parsed/);
  });

  it("only DIRECT_URL remote: refused, and names only the remote host", () => {
    const lines = formatDatabaseTargets({ DATABASE_URL: LOCAL_URL, DIRECT_URL: REMOTE_URL });
    assert.equal(lines[0], "DATABASE_URL: 127.0.0.1:54322");
    assert.equal(lines[1], "DIRECT_URL: db.example.invalid:5432");
    assert.match(lines[2], /ガード: 拒否.*"db\.example\.invalid" is not local/);
    assertNoLeak(lines.join("\n"));
  });

  it("refuses under NODE_ENV=production / VERCEL_ENV even for the local DB", () => {
    setEnv("NODE_ENV", "production");
    assert.match(formatDatabaseTargets({ DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL })[2], /ガード: 拒否.*NODE_ENV/);
    setEnv("NODE_ENV", "development");
    setEnv("VERCEL_ENV", "preview");
    assert.match(formatDatabaseTargets({ DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL })[2], /ガード: 拒否.*VERCEL_ENV/);
  });

  it("prints exactly three lines and ignores other variables", () => {
    const lines = formatDatabaseTargets({
      DATABASE_URL: LOCAL_URL,
      DIRECT_URL: LOCAL_URL,
      SHADOW_DATABASE_URL: REMOTE_URL,
      AUTH_SECRET: SECRET,
    });
    assert.equal(lines.length, 3);
    assertNoLeak(lines.join("\n"), ["db.example.invalid"]);
  });
});

// ---------------------------------------------------------------------------
// 2. db:local:deploy / db:local:reset never start prisma unless the guard passes
// ---------------------------------------------------------------------------

type Call = { command: string; args: string[]; env: DbEnv; cwd: string };

function fakeSpawn(status: number | null = 0) {
  const calls: Call[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, env: options.env, cwd: options.cwd });
    return { status };
  };
  return { spawn, calls };
}

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

const LOOKALIKE_HOSTS = [
  "127.0.0.1.example.com",
  "localhost.evil.invalid",
  "localhost.",
  "local%68ost",
  "localhost,db.example.invalid",
  "127.0.0.2",
  "127.1",
  "0.0.0.0",
  "[::ffff:127.0.0.1]",
  "[2001:db8::1]",
  "host.docker.internal.example.invalid",
  "evil-localhost",
];

const REFUSED_URLS: Array<[string, string]> = [
  ...LOOKALIKE_HOSTS.map((h): [string, string] => [`host ${h}`, `postgresql://${USER}:${SECRET}@${h}:54322/${DB_NAME}`]),
  ["userinfo that looks local", `postgresql://localhost:54322@db.example.invalid:5432/${DB_NAME}`],
  ["?host= override", `${LOCAL_URL}?host=db.example.invalid`],
  ["?Hostaddr= override", `${LOCAL_URL}?Hostaddr=10.0.0.1`],
  ["?h%6fst= override", `${LOCAL_URL}?h%6fst=db.example.invalid`],
  ["unix socket via ?host=", `postgresql://${USER}:${SECRET}@localhost/${DB_NAME}?host=%2Ftmp`],
  ["no host", `postgresql:///${DB_NAME}`],
  ["empty string", ""],
  ["not a URL", "not a url"],
];

describe("runLocalPrisma: refusals (no prisma)", () => {
  withLocalProcessEnv();

  for (const command of ["deploy", "reset"] as const) {
    for (const [name, url] of REFUSED_URLS) {
      it(`${command}: refuses DATABASE_URL with ${name}`, () => {
        const { spawn, calls } = fakeSpawn();
        const { code, errors } = run(command, { DATABASE_URL: url, DIRECT_URL: LOCAL_URL }, spawn);
        assert.equal(code, 1);
        assert.equal(calls.length, 0, "prisma must not be started");
        assert.match(errors[0], /^Refusing to run/);
        assertNoLeak(errors[0]);
      });

      it(`${command}: refuses DIRECT_URL with ${name} (DATABASE_URL local)`, () => {
        const { spawn, calls } = fakeSpawn();
        const { code } = run(command, { DATABASE_URL: LOCAL_URL, DIRECT_URL: url }, spawn);
        assert.equal(code, 1);
        assert.equal(calls.length, 0, "prisma must not be started");
      });
    }

    it(`${command}: refuses for any non-empty VERCEL_ENV value`, () => {
      for (const value of ["production", "preview", "development", "x"]) {
        setEnv("VERCEL_ENV", value);
        const { spawn, calls } = fakeSpawn();
        assert.equal(run(command, { DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL }, spawn).code, 1);
        assert.equal(calls.length, 0);
      }
    });
  }

  it("the allowed hosts are exactly those of assert-local-db (local forms are accepted)", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "[::1]", "host.docker.internal"]) {
      const url = `postgresql://u:p@${host}:54322/postgres`;
      const { spawn, calls } = fakeSpawn();
      assert.equal(run("deploy", { DATABASE_URL: url, DIRECT_URL: url }, spawn).code, 0, host);
      assert.equal(calls.length, 1, host);
    }
  });
});

describe("runLocalPrisma agrees with assertLocalDatabase and db:where", () => {
  withLocalProcessEnv();

  const samples: DbEnv[] = [
    { DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL },
    { DATABASE_URL: LOCAL_URL, DIRECT_URL: REMOTE_URL },
    { DATABASE_URL: REMOTE_URL, DIRECT_URL: LOCAL_URL },
    { DATABASE_URL: LOCAL_URL },
    { DIRECT_URL: LOCAL_URL },
    {},
    ...REFUSED_URLS.map(([, url]) => ({ DATABASE_URL: url, DIRECT_URL: url })),
  ];

  samples.forEach((dbEnv, i) => {
    it(`sample #${i + 1}: spawn happens iff the guard passes iff db:where says 通る`, () => {
      let guardPasses = true;
      try {
        assertLocalDatabase([dbEnv.DATABASE_URL, dbEnv.DIRECT_URL]);
      } catch {
        guardPasses = false;
      }
      const { spawn, calls } = fakeSpawn();
      run("reset", dbEnv, spawn);
      assert.equal(calls.length === 1, guardPasses);
      const verdict = formatDatabaseTargets(dbEnv)[2];
      assert.equal(/ガード: 通る/.test(verdict), guardPasses, verdict);
    });
  });

  it("guard reads NODE_ENV / VERCEL_ENV from process.env, not from opts.env (entry point passes process.env)", () => {
    // Documents current behaviour: runLocalPrisma's `env` option only supplies the URLs.
    // scripts/db-local.ts passes `process.env`, so both are the same object in practice.
    const { spawn, calls } = fakeSpawn();
    run("deploy", { DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL, NODE_ENV: "production", VERCEL_ENV: "production" }, spawn);
    assert.equal(calls.length, 1);
    const src = readFileSync(path.join(ROOT, "scripts", "db-local.ts"), "utf8");
    assert.match(src, /runLocalPrisma\(sub, \{\s*env: process\.env,/);
  });
});

// ---------------------------------------------------------------------------
// 3. Child process: fixed args, no shell, no argument injection
// ---------------------------------------------------------------------------

describe("child process arguments", () => {
  withLocalProcessEnv();

  it("isLocalPrismaCommand accepts only the exact words deploy / reset", () => {
    assert.equal(isLocalPrismaCommand("deploy"), true);
    assert.equal(isLocalPrismaCommand("reset"), true);
    for (const bad of [undefined, "", "Deploy", "RESET", "deploy ", " reset", "deploy;rm -rf /", "dev", "push",
      "where", "toString", "__proto__", "constructor", "hasOwnProperty", "--force"]) {
      assert.equal(isLocalPrismaCommand(bad), false, String(bad));
    }
  });

  it("each spawn gets a fresh copy of the args; mutating it does not change PRISMA_ARGS", () => {
    const evil: SpawnLike = (_c, args) => {
      args.push("--schema=/tmp/evil.prisma");
      args[0] = "db";
      return { status: 0 };
    };
    run("deploy", { DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL }, evil);
    run("reset", { DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL }, evil);
    assert.deepEqual([...PRISMA_ARGS.deploy], ["migrate", "deploy"]);
    assert.deepEqual([...PRISMA_ARGS.reset], ["migrate", "reset", "--force"]);
    const { spawn, calls } = fakeSpawn();
    run("reset", { DATABASE_URL: LOCAL_URL, DIRECT_URL: LOCAL_URL }, spawn);
    assert.deepEqual(calls[0].args, ["migrate", "reset", "--force"]);
    assert.equal(calls[0].command, "/fake/prisma");
  });

  it("args do not depend on the URL contents (nothing from the env is put on the command line)", () => {
    const weird = `postgresql://u:p@localhost:54322/x?sslmode=disable&schema=$(touch%20/tmp/pwn)`;
    const { spawn, calls } = fakeSpawn();
    run("deploy", { DATABASE_URL: weird, DIRECT_URL: weird }, spawn);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["migrate", "deploy"]);
    assert.ok(!calls[0].args.join(" ").includes("pwn"));
  });

  it("entry point: spawnSync without a shell, absolute prisma bin, only argv[2] is used", () => {
    const src = readFileSync(path.join(ROOT, "scripts", "db-local.ts"), "utf8");
    assert.doesNotMatch(src, /shell\s*:/, "must not pass a shell option");
    assert.doesNotMatch(src, /\bexecSync\b|\bexec\(|\bexecFile/, "must not use exec*");
    assert.match(src, /spawnSync\(command, args, \{ \.\.\.options, env: options\.env as NodeJS\.ProcessEnv \}\)/);
    assert.match(src, /path\.join\(ROOT, "node_modules", "\.bin", "prisma"\)/);
    assert.doesNotMatch(src, /process\.argv\.slice|process\.argv\[3\]/, "extra CLI args must not be forwarded");
    // .env is loaded (by PrismaClient) BEFORE the guard reads process.env.
    assert.ok(src.indexOf("new PrismaClient()") < src.indexOf("const sub = process.argv[2]"));
    assert.doesNotMatch(src, /\$connect|\$queryRaw|\$executeRaw/, "must never query the DB");
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end through the real entry point (both URL variables always set)
// ---------------------------------------------------------------------------

const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

/**
 * Child env for scripts/db-local.ts. Throws unless BOTH DATABASE_URL and DIRECT_URL are
 * non-empty strings, so a test can never fall back to the real .env (production).
 */
function childEnvFor(urls: { DATABASE_URL: string; DIRECT_URL: string }, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  for (const key of ["DATABASE_URL", "DIRECT_URL"] as const) {
    const v = urls[key];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`test safety: ${key} must be a non-empty dummy URL`);
    }
  }
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.NODE_ENV;
  delete childEnv.VERCEL_ENV;
  Object.assign(childEnv, extra, { DATABASE_URL: urls.DATABASE_URL, DIRECT_URL: urls.DIRECT_URL });
  return childEnv as NodeJS.ProcessEnv;
}

function runScript(args: string[], urls: { DATABASE_URL: string; DIRECT_URL: string }, extra: Record<string, string> = {}) {
  const res = spawnSync(TSX, ["scripts/db-local.ts", ...args], {
    cwd: ROOT,
    env: childEnvFor(urls, extra),
    encoding: "utf8",
    timeout: 90_000,
  });
  return { code: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const PRISMA_STARTED = /Prisma schema loaded|Datasource|Environment variables loaded|migrations? found|Applying migration|Can't reach database/;
const LOCAL_DUMMY = `postgresql://${USER}:${SECRET}@127.0.0.1:1/${DB_NAME}`;

describe("e2e safety helper", () => {
  it("refuses to build a child env without both URLs", () => {
    assert.throws(() => childEnvFor({ DATABASE_URL: REMOTE_URL, DIRECT_URL: "" }), /test safety/);
    assert.throws(() => childEnvFor({ DATABASE_URL: " ", DIRECT_URL: REMOTE_URL }), /test safety/);
    assert.throws(
      () => childEnvFor({ DATABASE_URL: REMOTE_URL } as unknown as { DATABASE_URL: string; DIRECT_URL: string }),
      /test safety/
    );
  });

  it("extra variables cannot override the dummy URLs", () => {
    const e = childEnvFor({ DATABASE_URL: REMOTE_URL, DIRECT_URL: REMOTE_URL }, { DATABASE_URL: "", DIRECT_URL: "" });
    assert.equal(e.DATABASE_URL, REMOTE_URL);
    assert.equal(e.DIRECT_URL, REMOTE_URL);
  });

  it("the existing db-local.test.ts e2e also sets both URLs explicitly", () => {
    const src = readFileSync(path.join(ROOT, "scripts", "lib", "db-local.test.ts"), "utf8");
    assert.match(src, /DATABASE_URL: POOLER_URL, DIRECT_URL: DIRECT_URL, \.\.\.extra/);
    // No call site passes `extra` that could unset a URL.
    assert.doesNotMatch(src, /runScript\("[a-z]+", \{/);
  });
});

describe("scripts/db-local.ts e2e: refusals before prisma", () => {
  const cases: Array<[string, { DATABASE_URL: string; DIRECT_URL: string }, Record<string, string>, RegExp]> = [
    ["only DIRECT_URL remote", { DATABASE_URL: LOCAL_DUMMY, DIRECT_URL: REMOTE_URL }, {}, /"db\.example\.invalid" is not local/],
    ["NODE_ENV=production, local URLs", { DATABASE_URL: LOCAL_DUMMY, DIRECT_URL: LOCAL_DUMMY }, { NODE_ENV: "production" }, /NODE_ENV is "production"/],
    ["VERCEL_ENV=preview, local URLs", { DATABASE_URL: LOCAL_DUMMY, DIRECT_URL: LOCAL_DUMMY }, { VERCEL_ENV: "preview" }, /VERCEL_ENV is set/],
    [
      "lookalike host 127.0.0.1.example.com",
      { DATABASE_URL: `postgresql://${USER}:${SECRET}@127.0.0.1.example.com:54322/${DB_NAME}`, DIRECT_URL: LOCAL_DUMMY },
      {},
      /"127\.0\.0\.1\.example\.com" is not local/,
    ],
    [
      "lookalike host localhost.evil.invalid",
      { DATABASE_URL: LOCAL_DUMMY, DIRECT_URL: `postgresql://${USER}:${SECRET}@localhost.evil.invalid:54322/${DB_NAME}` },
      {},
      /"localhost\.evil\.invalid" is not local/,
    ],
    [
      "?host= override on a local URL",
      { DATABASE_URL: `${LOCAL_DUMMY}?host=db.example.invalid`, DIRECT_URL: LOCAL_DUMMY },
      {},
      /query parameter "host" is not allowed/,
    ],
  ];

  for (const sub of ["deploy", "reset"]) {
    for (const [name, urls, extra, reason] of cases) {
      it(`${sub}: exits 1 without starting prisma (${name})`, () => {
        const { code, output } = runScript([sub], urls, extra);
        assert.equal(code, 1, output);
        assert.match(output, reason);
        assert.doesNotMatch(output, PRISMA_STARTED, "prisma must not start");
        assertNoLeak(output);
      });
    }

    it(`${sub}: extra CLI arguments do not bypass the guard`, () => {
      const { code, output } = runScript([sub, "--schema=/tmp/x.prisma", "--skip-seed"], { DATABASE_URL: REMOTE_URL, DIRECT_URL: REMOTE_URL });
      assert.equal(code, 1, output);
      assert.match(output, /Refusing to run/);
      assert.doesNotMatch(output, PRISMA_STARTED);
    });
  }

  for (const sub of ["", "migrate", "dev", "deploy;id", "DEPLOY", "toString"]) {
    it(`unknown subcommand ${JSON.stringify(sub)} exits 2`, () => {
      const { code, output } = runScript([sub], { DATABASE_URL: REMOTE_URL, DIRECT_URL: REMOTE_URL });
      assert.equal(code, 2, output);
      assert.match(output, /Usage/);
      assert.doesNotMatch(output, PRISMA_STARTED);
    });
  }
});

describe("scripts/db-local.ts e2e: where never leaks", () => {
  const urls: Array<[string, string, RegExp]> = [
    ["IPv6", `postgresql://${USER}:${SECRET}@[2001:db8::1]:5432/${DB_NAME}?sslmode=${QUERY_VALUE}`, /DATABASE_URL: \[2001:db8::1\]:5432/],
    ["encoded password", `postgresql://${USER}:${SECRET}%40%23%2F@db.example.invalid:5432/${DB_NAME}`, /DATABASE_URL: db\.example\.invalid:5432/],
    ["?host= override", `postgresql://${USER}:${SECRET}@localhost:5432/${DB_NAME}?host=db.example.invalid`, /DATABASE_URL: localhost:5432（注意/],
    ["multiple hosts", `postgresql://${USER}:${SECRET}@localhost:1,db.example.invalid:5432/${DB_NAME}`, /DATABASE_URL: 解析できない URL/],
    ["not a URL", `${USER} ${SECRET}`, /DATABASE_URL: 解析できない URL/],
    // "user:password" alone is a valid URL whose scheme is "user:"; nothing is printed.
    ["bare user:password", `${USER}:${SECRET}`, /DATABASE_URL: \(ホストなし\):\(ポート指定なし\)/],
  ];

  for (const [name, url, expected] of urls) {
    it(`${name}`, () => {
      const { code, output } = runScript(["where"], { DATABASE_URL: url, DIRECT_URL: REMOTE_URL });
      assert.equal(code, 0, output);
      assert.match(output, expected);
      assert.match(output, /DIRECT_URL: db\.example\.invalid:5432/);
      assert.match(output, /ガード: 拒否/);
      assertNoLeak(output);
    });
  }

  it("where under NODE_ENV=production still prints only host:port and exits 0", () => {
    const { code, output } = runScript(["where"], { DATABASE_URL: LOCAL_DUMMY, DIRECT_URL: LOCAL_DUMMY }, { NODE_ENV: "production" });
    assert.equal(code, 0, output);
    assert.match(output, /DATABASE_URL: 127\.0\.0\.1:1\n/);
    assert.match(output, /ガード: 拒否/);
    assertNoLeak(output);
  });
});

// ---------------------------------------------------------------------------
// 5. package.json / docs / supabase/config.toml consistency
// ---------------------------------------------------------------------------

describe("package.json", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
    prisma?: { seed?: string };
  };

  it("prisma.seed (run by migrate reset) is the same guarded script as db:seed", () => {
    assert.equal(pkg.prisma?.seed, pkg.scripts["db:seed"]);
    assert.match(pkg.prisma?.seed ?? "", /prisma\/seed\.ts$/);
    const seedSrc = readFileSync(path.join(ROOT, "prisma", "seed.ts"), "utf8");
    assert.match(seedSrc, /assertLocalDatabase/);
  });

  it("no script touches the linked (production) Supabase project or calls the supabase CLI", () => {
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      assert.doesNotMatch(cmd, /\bsupabase\b|--linked|db\s+push|vercel\s+env/, name);
    }
  });

  it("npm test picks up this file", () => {
    assert.match(pkg.scripts.test, /scripts\/lib\/\*\.test\.ts/);
  });
});

describe("docs and .env.example match the implementation", () => {
  const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
  const docs = { "CLAUDE.md": read("CLAUDE.md"), "docs/dev-db-setup.md": read("docs/dev-db-setup.md"), ".env.example": read(".env.example") };
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  it("every `npm run <script>` mentioned exists in package.json, and db:migrate is gone", () => {
    for (const [file, text] of Object.entries(docs)) {
      for (const m of Array.from(text.matchAll(/npm run ([a-z:]+)/g))) {
        assert.ok(pkg.scripts[m[1]] !== undefined, `${file} mentions missing script ${m[1]}`);
      }
      assert.doesNotMatch(text, /db:migrate/, file);
    }
  });

  it("the local DB port in the docs matches supabase/config.toml", () => {
    const toml = read("supabase/config.toml");
    const port = /\[db\][^[]*?\nport = (\d+)/.exec(toml)?.[1];
    assert.equal(port, "54322");
    for (const [file, text] of Object.entries(docs)) {
      assert.match(text, /127\.0\.0\.1:54322/, file);
    }
  });

  it("no connection strings, project refs or secrets are written down", () => {
    for (const [file, text] of Object.entries(docs)) {
      assert.doesNotMatch(text, /postgres(ql)?:\/\/[^\s'"`]*:[^\s'"`]*@/i, `${file}: URL with credentials`);
      assert.doesNotMatch(text, /[a-z0-9]{20}\.supabase\.co|db\.[a-z0-9]{20}\.|postgres\.[a-z0-9]{20}/i, `${file}: Supabase project ref`);
      assert.doesNotMatch(text, /aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com/i, `${file}: concrete pooler host`);
      assert.doesNotMatch(text, /\beyJ[A-Za-z0-9_-]{10,}|\bsk_(live|test)_|\bre_[A-Za-z0-9]{16,}/, `${file}: key-like string`);
    }
  });

  it(".env.example has variable names only (no values for DB / secrets)", () => {
    for (const line of docs[".env.example"].split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!m) continue;
      if (["AUTH_URL"].includes(m[1])) {
        assert.match(m[2], /^http:\/\/localhost(:\d+)?$/);
        continue;
      }
      assert.equal(m[2], "", `${m[1]} must be empty in .env.example`);
    }
  });

  it("the documented guarded scripts route through scripts/db-local.ts", () => {
    assert.match(docs["CLAUDE.md"], /npm run db:local:deploy/);
    assert.match(docs["CLAUDE.md"], /npm run db:local:reset/);
    assert.match(docs["CLAUDE.md"], /npm run db:where/);
    assert.match(docs["CLAUDE.md"], /migrate reset --force/);
    assert.deepEqual([...PRISMA_ARGS.reset], ["migrate", "reset", "--force"]);
  });
});

describe("supabase/config.toml", () => {
  const raw = readFileSync(path.join(ROOT, "supabase", "config.toml"), "utf8");

  // Minimal TOML reader: [section] headers and `key = value` lines (no comments).
  const values = new Map<string, string>();
  let section = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      section = header[1];
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(trimmed);
    if (kv) values.set(section ? `${section}.${kv[1]}` : kv[1], kv[2]);
  }

  it("uses Postgres 17 on 127.0.0.1:54322 for project nwa-lms", () => {
    assert.equal(values.get("db.major_version"), "17");
    assert.equal(values.get("db.port"), "54322");
    assert.equal(values.get("project_id"), '"nwa-lms"');
  });

  it("disables services the app does not use", () => {
    for (const key of [
      "auth.enabled",
      "storage.enabled",
      "realtime.enabled",
      "edge_runtime.enabled",
      "analytics.enabled",
      "local_smtp.enabled",
      "db.pooler.enabled",
      "db.seed.enabled",
      "db.migrations.enabled",
      "storage.s3_protocol.enabled",
    ]) {
      assert.equal(values.get(key), "false", key);
    }
    assert.equal(values.get("studio.enabled"), "true");
  });

  it("does not expose new public tables to anon / authenticated (#2)", () => {
    assert.equal(values.get("api.auto_expose_new_tables"), "false");
  });

  it("contains no secrets: every secret-like key is empty or env(...)", () => {
    for (const [key, value] of Array.from(values.entries())) {
      if (/(secret|secret_key|token|password|api_key|access_key|sid)$/i.test(key.split(".").pop() ?? "") && !/^(true|false|\d+)$/.test(value)) {
        assert.match(value, /^"(env\([A-Z0-9_]+\))?"$/, `${key} must be "" or "env(...)"`);
      }
    }
    assert.doesNotMatch(raw, /\beyJ[A-Za-z0-9_-]{10,}|\bsk_(live|test)_|\bsb_secret_|postgres(ql)?:\/\/[^\s"]*@/);
  });

  it("supabase/.gitignore keeps local env files out of git", () => {
    const gi = readFileSync(path.join(ROOT, "supabase", ".gitignore"), "utf8");
    assert.match(gi, /^\.env\.local$/m);
    assert.match(gi, /^\.env\.keys$/m);
    assert.match(gi, /^\.temp$/m);
  });
});
