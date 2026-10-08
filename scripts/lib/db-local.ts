/**
 * Helpers for the local-database npm scripts (#8):
 *
 * - `npm run db:where`        show only "host:port" of DATABASE_URL / DIRECT_URL (no connection)
 * - `npm run db:local:deploy` guard, then `prisma migrate deploy`
 * - `npm run db:local:reset`  guard, then `prisma migrate reset --force`
 *
 * The entry point is `scripts/db-local.ts`. This module has no side effects so that
 * tests can inject the environment and the child-process launcher.
 *
 * Nothing here may print a username, password, database name or query string.
 */

import { assertLocalDatabase } from "./assert-local-db";

export type DbEnv = Record<string, string | undefined>;

export const DB_URL_KEYS = ["DATABASE_URL", "DIRECT_URL"] as const;

// Same names the guard rejects: they override the URL host in Postgres / Prisma.
const HOST_OVERRIDE_PARAMS: ReadonlySet<string> = new Set(["host", "hostaddr"]);

/**
 * Describe where a database URL points, as "host:port" only.
 * Never returns the username, password, database name or query values.
 */
export function describeDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined) return "未設定";
  if (raw === "") return "空（解析できない URL）";

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "解析できない URL";
  }

  const host = parsed.hostname === "" ? "(ホストなし)" : parsed.hostname.toLowerCase();
  const port = parsed.port === "" ? "(ポート指定なし)" : parsed.port;
  let line = `${host}:${port}`;

  const overridden = Array.from(parsed.searchParams.keys()).some((key) =>
    HOST_OVERRIDE_PARAMS.has(key.toLowerCase())
  );
  if (overridden) {
    line += "（注意: クエリの host / hostaddr 指定で接続先が上書きされる）";
  }
  return line;
}

/**
 * Lines printed by `npm run db:where`. Includes whether the local-DB guard
 * (`assertLocalDatabase`) would allow `db:local:*` / `db:seed` right now.
 * The guard's messages contain only a hostname, never credentials.
 */
export function formatDatabaseTargets(env: DbEnv): string[] {
  const lines = DB_URL_KEYS.map((key) => `${key}: ${describeDatabaseUrl(env[key])}`);

  try {
    assertLocalDatabase(DB_URL_KEYS.map((key) => env[key]));
    lines.push("ローカル DB のガード: 通る（db:local:deploy / db:local:reset / db:seed を実行できる）");
  } catch (err) {
    const reason = err instanceof Error ? err.message : "local database check failed.";
    lines.push(`ローカル DB のガード: 拒否（${reason}）`);
  }
  return lines;
}

export type LocalPrismaCommand = "deploy" | "reset";

// `migrate reset` also runs the seed configured in package.json ("prisma.seed"),
// which is the same guarded script as `npm run db:seed`.
export const PRISMA_ARGS: Readonly<Record<LocalPrismaCommand, readonly string[]>> = {
  deploy: ["migrate", "deploy"],
  reset: ["migrate", "reset", "--force"],
};

export function isLocalPrismaCommand(value: string | undefined): value is LocalPrismaCommand {
  return value === "deploy" || value === "reset";
}

export type SpawnResult = { status: number | null; error?: Error };

export type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd: string; env: DbEnv; stdio: "inherit" }
) => SpawnResult;

export type RunLocalPrismaOptions = {
  env: DbEnv;
  spawn: SpawnLike;
  prismaBin: string;
  cwd: string;
  logError: (message: string) => void;
};

/**
 * Run `prisma migrate deploy|reset` only after the local-DB guard passes.
 * The child gets exactly the environment that was checked, so the Prisma CLI
 * (which never lets .env override variables already set) uses the same URLs.
 * Returns the process exit code.
 */
export function runLocalPrisma(command: LocalPrismaCommand, opts: RunLocalPrismaOptions): number {
  try {
    assertLocalDatabase(DB_URL_KEYS.map((key) => opts.env[key]));
  } catch (err) {
    opts.logError(err instanceof Error ? err.message : "Refusing to run: local database check failed.");
    return 1;
  }

  const result = opts.spawn(opts.prismaBin, [...PRISMA_ARGS[command]], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: "inherit",
  });

  if (result.error) {
    opts.logError("prisma を起動できなかった（npm install 済みか確認する）。");
    return 1;
  }
  return result.status ?? 1;
}
