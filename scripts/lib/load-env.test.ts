import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRootEnv, rootEnvFile } from "./load-env";

// SAFETY: every .env here is a dummy file in a fresh temp directory. The repository's
// own .env is never read by these tests (they only read its path in the static checks
// below, as source text of the scripts, never the file itself).

const env: Record<string, string | undefined> = process.env;
const KEYS = ["NWA_LOADENV_TEST_A", "NWA_LOADENV_TEST_B", "NWA_LOADENV_TEST_LOCAL"];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nwa-load-env-"));
  for (const k of KEYS) delete env[k];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of KEYS) delete env[k];
});

describe("loadRootEnv", () => {
  it("reads <root>/.env into process.env", () => {
    writeFileSync(path.join(dir, ".env"), "NWA_LOADENV_TEST_A=from-file\n");
    assert.equal(loadRootEnv(dir), true);
    assert.equal(env.NWA_LOADENV_TEST_A, "from-file", ".env の値が読み込まれていない");
  });

  it("does not override variables that are already set", () => {
    writeFileSync(path.join(dir, ".env"), "NWA_LOADENV_TEST_A=from-file\nNWA_LOADENV_TEST_B=from-file\n");
    env.NWA_LOADENV_TEST_A = "preset";
    loadRootEnv(dir);
    assert.equal(env.NWA_LOADENV_TEST_A, "preset", "設定済みの変数を .env で上書きした");
    assert.equal(env.NWA_LOADENV_TEST_B, "from-file", "未設定の変数が読み込まれていない");
  });

  it("does not read .env.local", () => {
    writeFileSync(path.join(dir, ".env"), "NWA_LOADENV_TEST_A=from-file\n");
    writeFileSync(path.join(dir, ".env.local"), "NWA_LOADENV_TEST_LOCAL=from-local\n");
    loadRootEnv(dir);
    assert.equal(env.NWA_LOADENV_TEST_LOCAL, undefined, ".env.local を読んだ");
  });

  it("returns false and changes nothing when .env does not exist", () => {
    writeFileSync(path.join(dir, ".env.local"), "NWA_LOADENV_TEST_LOCAL=from-local\n");
    assert.equal(loadRootEnv(dir), false);
    assert.equal(env.NWA_LOADENV_TEST_LOCAL, undefined, ".env がないときに別のファイルを読んだ");
  });

  it("passes only <root>/.env to the loader", () => {
    const seen: string[] = [];
    loadRootEnv("/fake/root", (file) => seen.push(file));
    assert.deepEqual(seen, [path.join("/fake/root", ".env")]);
    assert.equal(rootEnvFile("/fake/root"), path.join("/fake/root", ".env"));
  });

  it("throws a fixed message without file content when .env cannot be read", () => {
    mkdirSync(path.join(dir, ".env"));
    assert.throws(
      () => loadRootEnv(dir),
      (err: unknown) => err instanceof Error && err.message === "Could not load .env (check that it is a readable file)."
    );
  });

  it("rethrows loader errors as the fixed message, never the original text", () => {
    const leak = "dummySecretValue42";
    assert.throws(
      () =>
        loadRootEnv(dir, () => {
          throw new Error(`parse failed near ${leak}`);
        }),
      (err: unknown) => err instanceof Error && !err.message.includes(leak)
    );
  });
});

// The DB scripts must load .env by path before the guard, not through `new PrismaClient()`.
describe("DB scripts load <repo>/.env explicitly", () => {
  const ROOT = path.resolve(__dirname, "..", "..");
  const SCRIPTS = ["scripts/db-local.ts", "prisma/seed.ts", "scripts/seed-step1.ts", "scripts/verify-quiz-admin-db.ts"];

  for (const rel of SCRIPTS) {
    it(`${rel} calls loadRootEnv(<repo root>) before PrismaClient and the guard`, () => {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      const call = src.search(/^loadRootEnv\(/m);
      assert.ok(call !== -1, `${rel} がトップレベルで loadRootEnv を呼んでいない`);
      const prismaAt = src.indexOf("new PrismaClient(");
      if (prismaAt !== -1) assert.ok(call < prismaAt, `${rel} は PrismaClient を作ったあとで .env を読んでいる`);
      const guardAt = src.search(/^\s*assertLocalDatabase\(/m);
      if (guardAt !== -1) assert.ok(call < guardAt, `${rel} はガードのあとで .env を読んでいる`);
      assert.doesNotMatch(src, /loadEnvFile\(/, `${rel} が loadRootEnv を通さずに loadEnvFile を呼んでいる`);
    });
  }
});
