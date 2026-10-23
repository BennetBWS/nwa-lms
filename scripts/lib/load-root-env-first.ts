/**
 * Side-effect import: load `<repo>/.env` into process.env (#81).
 *
 * Must be the FIRST import of every DB script (scripts/db-local.ts, prisma/seed.ts,
 * scripts/seed-step1.ts, scripts/verify-quiz-admin-db.ts). Imports are evaluated before
 * the script body, and requiring `@prisma/client` already loads the .env next to the
 * schema the client was generated from (possibly another checkout). Loading this
 * repository's .env first means those values cannot win (dotenv never overrides).
 *
 * Imports only node:path and ./load-env (no @prisma/client). Nothing is printed.
 */

import path from "node:path";

import { loadRootEnv } from "./load-env";

loadRootEnv(path.resolve(__dirname, "..", ".."));
