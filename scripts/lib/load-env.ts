/**
 * Load the repository's `.env` into process.env explicitly (#81).
 *
 * The DB scripts (scripts/db-local.ts, prisma/seed.ts, scripts/seed-step1.ts,
 * scripts/verify-quiz-admin-db.ts) used to rely on `new PrismaClient()` loading .env.
 * The generated client loads the .env next to the schema it was generated from (already
 * when `@prisma/client` is required), so a client generated from another checkout (e.g. a
 * worktree sharing node_modules through a symlink) silently skipped this repository's .env.
 * This reads the file by path instead. The scripts call it through the side-effect import
 * `./load-root-env-first`, which must be their first import (before `@prisma/client`).
 *
 * - Only `<root>/.env` is read. `.env.local` is never read (DB URLs live only in .env).
 * - Variables that are already set are not overridden (process.loadEnvFile semantics),
 *   so explicit values from the shell or tests always win.
 * - `${VAR}` references are not expanded (unlike Prisma's dotenv-expand). The current .env does not use them.
 * - A missing file is not an error. A file that exists but cannot be read is an error
 *   (checked before loading: Node 20's loadEnvFile reports EACCES as ENOENT).
 * - Nothing from the file is ever printed.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";

export type EnvFileLoader = (file: string) => void;

const UNREADABLE = "Could not load .env (check that it is a readable file).";

/** The file this module reads for a repository root. */
export function rootEnvFile(root: string): string {
  return path.join(root, ".env");
}

function isMissingFile(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT";
}

/**
 * Load `<root>/.env`. Returns false when it does not exist, true when it was loaded.
 * Throws a fixed message (no file content, no cause) when it exists but is not a
 * readable regular file, or when loading fails for another reason.
 */
export function loadRootEnv(root: string, loader: EnvFileLoader = (file) => process.loadEnvFile(file)): boolean {
  const file = rootEnvFile(root);
  if (!existsSync(file)) return false;

  let readable = true;
  try {
    accessSync(file, constants.R_OK);
    readable = statSync(file).isFile();
  } catch {
    readable = false;
  }
  if (!readable) throw new Error(UNREADABLE);

  try {
    loader(file);
    return true;
  } catch (err) {
    // Removed between the check and the load
    if (isMissingFile(err)) return false;
    throw new Error(UNREADABLE);
  }
}
