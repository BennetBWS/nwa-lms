import { spawnSync } from "node:child_process";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import {
  formatDatabaseTargets,
  isLocalPrismaCommand,
  runLocalPrisma,
  type SpawnLike,
} from "./lib/db-local";

// Usage (via package.json):
//   npm run db:where          -> tsx scripts/db-local.ts where
//   npm run db:local:deploy   -> tsx scripts/db-local.ts deploy
//   npm run db:local:reset    -> tsx scripts/db-local.ts reset
//
// Load .env the same way as prisma/seed.ts and the Prisma CLI: the PrismaClient
// constructor reads .env into process.env without overriding variables that are
// already set, and does not connect. No query is ever run from this script.
new PrismaClient();

const ROOT = path.resolve(__dirname, "..");
const PRISMA_BIN = path.join(ROOT, "node_modules", ".bin", "prisma");

const spawn: SpawnLike = (command, args, options) =>
  spawnSync(command, args, { ...options, env: options.env as NodeJS.ProcessEnv });

const sub = process.argv[2];

if (sub === "where") {
  for (const line of formatDatabaseTargets(process.env)) console.log(line);
  process.exit(0);
} else if (isLocalPrismaCommand(sub)) {
  process.exit(
    runLocalPrisma(sub, {
      env: process.env,
      spawn,
      prismaBin: PRISMA_BIN,
      cwd: ROOT,
      logError: (message) => console.error(message),
    })
  );
} else {
  console.error("Usage: tsx scripts/db-local.ts <where|deploy|reset>");
  process.exit(2);
}
