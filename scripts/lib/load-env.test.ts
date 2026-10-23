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
    writeFileSync(path.join(dir, ".env"), "NWA_LOADENV_TEST_A=from-file\n");
    const seen: string[] = [];
    assert.equal(loadRootEnv(dir, (file) => seen.push(file)), true);
    assert.deepEqual(seen, [path.join(dir, ".env")]);
    assert.equal(rootEnvFile("/fake/root"), path.join("/fake/root", ".env"));
  });

  it("does not call the loader when .env does not exist", () => {
    const seen: string[] = [];
    assert.equal(loadRootEnv(dir, (file) => seen.push(file)), false);
    assert.deepEqual(seen, [], ".env がないのに loader を呼んだ");
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
    writeFileSync(path.join(dir, ".env"), "NWA_LOADENV_TEST_A=from-file\n");
    assert.throws(
      () =>
        loadRootEnv(dir, () => {
          throw new Error(`parse failed near ${leak}`);
        }),
      (err: unknown) => err instanceof Error && !err.message.includes(leak)
    );
  });
});

// The DB scripts must load <repo>/.env through the side-effect import ./lib/load-root-env-first,
// as their FIRST import: imports run before the script body, and requiring @prisma/client
// already loads the .env next to the schema the generated client points at.
describe("DB scripts load <repo>/.env first", () => {
  const ROOT = path.resolve(__dirname, "..", "..");
  const FIRST = path.join(ROOT, "scripts", "lib", "load-root-env-first.ts");
  const SCRIPTS = ["scripts/db-local.ts", "prisma/seed.ts", "scripts/seed-step1.ts", "scripts/verify-quiz-admin-db.ts"];

  // import / export ... from / require( at the start of a line (comments start with // or *, so they do not match)
  const MODULE_REF = /^[ \t]*(?:import\s*["']([^"']+)["']|import\b[^;]*?\bfrom\s*["']([^"']+)["']|export\b[^;]*?\bfrom\s*["']([^"']+)["'])|\brequire\s*\(\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gm;

  function moduleRefs(src: string): Array<{ spec: string; sideEffectOnly: boolean; index: number }> {
    return Array.from(src.matchAll(MODULE_REF), (m) => ({
      spec: m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5],
      sideEffectOnly: m[1] !== undefined,
      index: m.index ?? -1,
    }));
  }

  for (const rel of SCRIPTS) {
    it(`${rel}：最初の import が ./lib/load-root-env-first で、@prisma/client などのどの import よりも前にある`, () => {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      const refs = moduleRefs(src);
      assert.ok(refs.length >= 2, `${rel} の import を読めていない（${refs.length} 件）`);
      const [first, ...others] = refs;
      assert.ok(first.sideEffectOnly, `${rel} の最初の import が副作用だけの import でない（${first.spec}）`);
      assert.equal(path.resolve(path.dirname(path.join(ROOT, rel)), first.spec) + ".ts", FIRST, `${rel} の最初の import が load-root-env-first でない（${first.spec}）`);
      assert.ok(others.some((r) => r.spec === "@prisma/client" || r.spec.startsWith("./lib/") || r.spec.startsWith("node:")), `${rel} のほかの import を読めていない`);
      for (const r of others) {
        assert.ok(!/load-root-env-first|load-env$/.test(r.spec), `${rel} が .env を読む import を 2 回以上書いている（${r.spec}）`);
        assert.ok(r.index > first.index, `${rel} の ${r.spec} が load-root-env-first より前にある`);
      }
      assert.doesNotMatch(src, /\bloadRootEnv\(|\bloadEnvFile\(/, `${rel} が load-root-env-first を通さずに .env を読んでいる`);
    });
  }

  it("load-root-env-first は node:path と ./load-env だけを import し、リポジトリ直下を渡す", () => {
    const src = readFileSync(FIRST, "utf8");
    assert.deepEqual(moduleRefs(src).map((r) => r.spec).sort(), ["./load-env", "node:path"], "load-root-env-first の import が想定と違う");
    assert.match(src, /^loadRootEnv\(path\.resolve\(__dirname, "\.\.", "\.\."\)\);$/m, "リポジトリ直下（scripts/lib の 2 つ上）を渡していない");
    assert.equal(path.resolve(path.dirname(FIRST), "..", ".."), ROOT, "scripts/lib の 2 つ上がリポジトリ直下でない");
  });
});
