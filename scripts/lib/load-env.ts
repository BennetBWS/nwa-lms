/**
 * Load the repository's `.env` into process.env explicitly (#81).
 *
 * The DB scripts (scripts/db-local.ts, prisma/seed.ts, scripts/seed-step1.ts,
 * scripts/verify-quiz-admin-db.ts) used to rely on `new PrismaClient()` loading .env.
 * The generated client loads the .env next to the schema it was generated from, so a
 * client generated from another checkout (e.g. a worktree sharing node_modules through
 * a symlink) silently skipped this repository's .env. This reads the file by path instead.
 *
 * - Only `<root>/.env` is read. `.env.local` is never read (DB URLs live only in .env).
 * - Variables that are already set are not overridden (process.loadEnvFile semantics),
 *   so explicit values from the shell or tests always win.
 * - A missing file is not an error. Nothing from the file is ever printed.
 */

import path from "node:path";

export type EnvFileLoader = (file: string) => void;

/** The file this module reads for a repository root. */
export function rootEnvFile(root: string): string {
  return path.join(root, ".env");
}

function isMissingFile(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT";
}

/**
 * Load `<root>/.env` with process.loadEnvFile. Returns true when the file was loaded,
 * false when it does not exist. Other errors (e.g. the path is a directory) are thrown
 * with a fixed message that contains no file content.
 */
export function loadRootEnv(root: string, loader: EnvFileLoader = (file) => process.loadEnvFile(file)): boolean {
  try {
    loader(rootEnvFile(root));
    return true;
  } catch (err) {
    if (isMissingFile(err)) return false;
    throw new Error("Could not load .env (check that it is a readable file).");
  }
}
