import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRootEnv } from "./load-env";

// #81：load-env の境界と、「生成された Prisma Client が別の場所（別の checkout の schema）を指していても、
// スクリプトが <repo>/.env を読む」ことの再現テスト。
//
// SAFETY: リポジトリの .env は読まない。E2E は一時ディレクトリにスクリプトのコピーとダミーの .env を置き、
// @prisma/client は一時ディレクトリの node_modules に置いた偽物（接続しない。メソッドを呼ぶと固定の文で投げる）を使う。
// リモートのホストは *.invalid、ローカルは 127.0.0.1 の使われていないポートで、どれにも接続しない。

const REPO = path.resolve(__dirname, "..", "..");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
const env: Record<string, string | undefined> = process.env;
const KEYS = ["NWA_LOADENV_EDGE_A", "NWA_LOADENV_EDGE_B", "NWA_LOADENV_EDGE_C"];

describe("loadRootEnv の境界", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "nwa-load-env-edge-"));
    for (const k of KEYS) delete env[k];
  });
  afterEach(() => {
    try {
      chmodSync(path.join(dir, ".env"), 0o600);
    } catch {
      // ないときは何もしない
    }
    rmSync(dir, { recursive: true, force: true });
    for (const k of KEYS) delete env[k];
  });

  it("空文字で設定済みの変数も上書きしない（未設定と区別する）", () => {
    writeFileSync(path.join(dir, ".env"), "NWA_LOADENV_EDGE_A=from-file\n");
    env.NWA_LOADENV_EDGE_A = "";
    assert.equal(loadRootEnv(dir), true);
    assert.equal(env.NWA_LOADENV_EDGE_A, "", "空文字で設定済みの変数を .env で上書きした");
  });

  it("引用符付きの DB の URL を、引用符を外して読む（? や = を含んでも切れない）", () => {
    const url = "postgresql://u:p@127.0.0.1:54399/postgres?schema=public&x=1";
    writeFileSync(path.join(dir, ".env"), `NWA_LOADENV_EDGE_A="${url}"\nNWA_LOADENV_EDGE_B='${url}'\n`);
    loadRootEnv(dir);
    assert.equal(env.NWA_LOADENV_EDGE_A, url, "二重引用符の値を正しく読めていない");
    assert.equal(env.NWA_LOADENV_EDGE_B, url, "一重引用符の値を正しく読めていない");
  });

  it("${VAR} は展開しない（Prisma の dotenv-expand との違い。.env に参照を書くと値がそのまま入る）", () => {
    writeFileSync(path.join(dir, ".env"), "NWA_LOADENV_EDGE_A=base\nNWA_LOADENV_EDGE_C=${NWA_LOADENV_EDGE_A}\n");
    loadRootEnv(dir);
    assert.equal(env.NWA_LOADENV_EDGE_C, "${NWA_LOADENV_EDGE_A}", "展開の挙動が変わった（ドキュメントと照合する）");
  });

  it("ENOENT 以外のエラーは固定の文にし、元のエラーを cause・stack に残さない", () => {
    const leak = "dummySecretValue77";
    writeFileSync(path.join(dir, ".env"), "NWA_LOADENV_EDGE_A=from-file\n");
    let caught: unknown;
    try {
      loadRootEnv(dir, () => {
        throw Object.assign(new Error(`EACCES near ${leak}`), { code: "EACCES" });
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, "エラーを投げていない");
    assert.equal(caught.message, "Could not load .env (check that it is a readable file).");
    assert.equal((caught as Error & { cause?: unknown }).cause, undefined, "元のエラーを cause に残している");
    assert.ok(!String(caught.stack).includes(leak), "stack に元のエラーの文が含まれている");
  });

  it("ENOENT（確かめたあとで消えた。loader が投げた）は false を返し、投げない", () => {
    writeFileSync(path.join(dir, ".env"), "NWA_LOADENV_EDGE_A=from-file\n");
    const r = loadRootEnv(dir, () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    assert.equal(r, false);
  });

  it(
    "権限がなくて読めない .env は「ない」と区別してエラーにする",
    {
      skip: typeof process.getuid === "function" && process.getuid() === 0 ? "root では chmod 000 でも読める" : false,
    },
    () => {
      writeFileSync(path.join(dir, ".env"), "NWA_LOADENV_EDGE_A=from-file\n");
      chmodSync(path.join(dir, ".env"), 0o000);
      assert.throws(
        () => loadRootEnv(dir),
        (err: unknown) => err instanceof Error && err.message === "Could not load .env (check that it is a readable file)."
      );
    }
  );
});

// ---------------------------------------------------------------------------
// 生成された Prisma Client が別の場所を指していても、<repo>/.env を読む（再現テスト）
// ---------------------------------------------------------------------------

// 別の checkout の schema から生成されたクライアントの代わり。「別の checkout の .env」の値を、未設定のときだけ入れる
// （Prisma と同じく上書きしない）。本物の Prisma 6.19 の生成物（node_modules/.prisma/client/index.js）は、
// constructor だけでなく require の時点でも warnEnvConflicts → tryLoadEnvs で schema の隣の .env を dotenv で読む。
// "require" はその本物の動き、"constructor" は constructor でだけ読む場合。
type ClientMode = "require" | "constructor";
const fakePrismaClient = (mode: ClientMode) => `
function loadOtherCheckoutEnv() {
  if (process.env.DATABASE_URL === undefined) process.env.DATABASE_URL = "postgresql://other:other@127.0.0.1:54398/other";
  if (process.env.DIRECT_URL === undefined) process.env.DIRECT_URL = "postgresql://other:other@127.0.0.1:54398/other";
}
if (${JSON.stringify(mode)} === "require") loadOtherCheckoutEnv();
class PrismaClient {
  constructor() {
    loadOtherCheckoutEnv();
    return new Proxy(this, {
      get(_t, prop) {
        if (prop === "then") return undefined;
        throw new Error("FAKE_PRISMA_QUERY_CALLED");
      },
    });
  }
}
// verify-quiz-admin-db.ts（と src/lib/admin-quiz-edit.ts）は Prisma の値を import する。関数の中でしか使わないが、念のため置く
const JsonNull = Object.freeze({ fake: "JsonNull" });
module.exports = { PrismaClient, Prisma: { JsonNull, DbNull: JsonNull, AnyNull: JsonNull } };
`;

function makeSandbox(rootEnv: string | null, rootEnvLocal: string | null, mode: ClientMode): string {
  const root = mkdtempSync(path.join(tmpdir(), "nwa-load-env-e2e-"));
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  for (const f of ["db-local.ts", "seed-step1.ts", "verify-quiz-admin-db.ts"]) cpSync(path.join(REPO, "scripts", f), path.join(root, "scripts", f));
  for (const f of ["db-local.ts", "assert-local-db.ts", "load-env.ts", "load-root-env-first.ts"]) {
    cpSync(path.join(REPO, "scripts", "lib", f), path.join(root, "scripts", "lib", f));
  }
  mkdirSync(path.join(root, "prisma"), { recursive: true });
  cpSync(path.join(REPO, "prisma", "seed.ts"), path.join(root, "prisma", "seed.ts"));
  cpSync(path.join(REPO, "src", "lib"), path.join(root, "src", "lib"), {
    recursive: true,
    filter: (src) => !/\.test\.tsx?$/.test(src),
  });
  const client = path.join(root, "node_modules", "@prisma", "client");
  mkdirSync(client, { recursive: true });
  writeFileSync(path.join(client, "package.json"), JSON.stringify({ name: "@prisma/client", main: "index.js" }));
  writeFileSync(path.join(client, "index.js"), fakePrismaClient(mode));
  const bcrypt = path.join(root, "node_modules", "bcryptjs");
  mkdirSync(bcrypt, { recursive: true });
  writeFileSync(path.join(bcrypt, "package.json"), JSON.stringify({ name: "bcryptjs", main: "index.js" }));
  writeFileSync(path.join(bcrypt, "index.js"), "module.exports = { hash: async () => 'x', hashSync: () => 'x' };\n");
  if (rootEnv !== null) writeFileSync(path.join(root, ".env"), rootEnv);
  if (rootEnvLocal !== null) writeFileSync(path.join(root, ".env.local"), rootEnvLocal);
  return root;
}

function runIn(root: string, args: string[], preset: Record<string, string> = {}) {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.DATABASE_URL;
  delete childEnv.DIRECT_URL;
  delete childEnv.NODE_ENV;
  delete childEnv.VERCEL_ENV;
  Object.assign(childEnv, preset);
  const res = spawnSync(TSX, args, { cwd: root, env: childEnv as NodeJS.ProcessEnv, encoding: "utf8", timeout: 90_000 });
  return { code: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const ROOT_PW = "rootEnvPw91x";
const LOCAL_ENV = `DATABASE_URL="postgresql://u:${ROOT_PW}@127.0.0.1:54397/postgres"\nDIRECT_URL="postgresql://u:${ROOT_PW}@127.0.0.1:54396/postgres"\n`;
const REMOTE_ENV = `DATABASE_URL="postgresql://u:${ROOT_PW}@db.from-root-env.invalid:5432/postgres"\nDIRECT_URL="postgresql://u:${ROOT_PW}@db.from-root-env.invalid:5432/postgres"\n`;
const ENV_LOCAL_FILE = `DATABASE_URL="postgresql://u:x@from-env-local.invalid:5432/db"\nDIRECT_URL="postgresql://u:x@from-env-local.invalid:5432/db"\n`;

describe("E2E：別の場所を指すクライアントでも <repo>/.env を読む（一時ディレクトリのコピー）", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  const sandbox = (rootEnv: string | null, mode: ClientMode = "require", rootEnvLocal: string | null = ENV_LOCAL_FILE) => {
    const r = makeSandbox(rootEnv, rootEnvLocal, mode);
    roots.push(r);
    return r;
  };

  it("db:where は <root>/.env のホスト:ポートを出し、別の checkout・.env.local の値を出さない", () => {
    const root = sandbox(LOCAL_ENV);
    const { code, output } = runIn(root, ["scripts/db-local.ts", "where"]);
    assert.equal(code, 0, output);
    assert.match(output, /DATABASE_URL: 127\.0\.0\.1:54397\n/, "DATABASE_URL が <root>/.env の値でない");
    assert.match(output, /DIRECT_URL: 127\.0\.0\.1:54396\n/, "DIRECT_URL が <root>/.env の値でない");
    assert.ok(!output.includes("54398"), "別の checkout の .env の値を出した");
    assert.ok(!output.includes("from-env-local"), ".env.local の値を出した");
    assert.ok(!output.includes(ROOT_PW), "出力にパスワードが含まれている");
  });

  it("db:where は、シェルで設定済みの値を <root>/.env より優先する", () => {
    const root = sandbox(LOCAL_ENV);
    const { code, output } = runIn(root, ["scripts/db-local.ts", "where"], { DIRECT_URL: "postgresql://u:p@127.0.0.1:54395/db" });
    assert.equal(code, 0, output);
    assert.match(output, /DATABASE_URL: 127\.0\.0\.1:54397\n/, "DATABASE_URL が <root>/.env の値でない");
    assert.match(output, /DIRECT_URL: 127\.0\.0\.1:54395\n/, "設定済みの DIRECT_URL を上書きした");
  });

  it("<root>/.env がなくても db:where は止まらず、.env.local も別の checkout の値も読まない", () => {
    const root = sandbox(null);
    const { code, output } = runIn(root, ["scripts/db-local.ts", "where"]);
    assert.equal(code, 0, output);
    assert.ok(!output.includes("54398"), "別の checkout の .env の値を出した");
    assert.ok(!output.includes("from-env-local"), ".env.local の値を出した");
    assert.match(output, /ガード: 拒否/, "URL がないのにガードが通った");
  });

  for (const script of ["scripts/seed-step1.ts", "prisma/seed.ts", "scripts/verify-quiz-admin-db.ts"]) {
    it(`${script}：クライアントが constructor でだけ .env を読むなら、<root>/.env のリモートの URL でガードに拒否される`, () => {
      const root = sandbox(REMOTE_ENV, "constructor");
      const { code, output } = runIn(root, [script]);
      assert.equal(code, 1, output);
      assert.match(output, /Refusing to run: database host "db\.from-root-env\.invalid" is not local/, output);
      assert.ok(!output.includes("FAKE_PRISMA_QUERY_CALLED"), "ガードより先、またはガードを通ってクエリを呼んだ");
      assert.ok(!output.includes(ROOT_PW), "出力にパスワードが含まれている");
    });

    it(
      `${script}：クライアントが require の時点で別の checkout の .env を読んでも、<root>/.env の値でガードを判定する`,
      () => {
        const root = sandbox(REMOTE_ENV, "require");
        const { code, output } = runIn(root, [script]);
        assert.equal(code, 1, output);
        assert.match(output, /Refusing to run: database host "db\.from-root-env\.invalid" is not local/, output);
        assert.ok(!output.includes("FAKE_PRISMA_QUERY_CALLED"), "ガードより先、またはガードを通ってクエリを呼んだ");
        assert.doesNotMatch(output, /^(PASS|FAIL) /m, "ガードを通らずに確認を始めた");
        assert.ok(!output.includes(ROOT_PW), "出力にパスワードが含まれている");
      }
    );
  }

  it("前提：本物の生成物は require の時点で warnEnvConflicts（tryLoadEnvs）を呼ぶ", () => {
    const generated = readFileSync(path.join(REPO, "node_modules", ".prisma", "client", "index.js"), "utf8");
    const warnAt = generated.indexOf("warnEnvConflicts(");
    const ctorAt = generated.indexOf("getPrismaClient(config)");
    assert.ok(warnAt !== -1 && ctorAt !== -1, "生成物の形が変わった（再現テストの前提を見直す）");
    assert.ok(warnAt < ctorAt, "warnEnvConflicts がトップレベルで先に呼ばれていない");
  });

  it("コピーしたスクリプトは本物と同じ内容（再現テストの前提）", () => {
    const root = sandbox(LOCAL_ENV);
    for (const rel of ["scripts/db-local.ts", "scripts/seed-step1.ts", "prisma/seed.ts", "scripts/verify-quiz-admin-db.ts", "scripts/lib/load-env.ts", "scripts/lib/load-root-env-first.ts", "scripts/lib/assert-local-db.ts"]) {
      assert.equal(readFileSync(path.join(root, rel), "utf8"), readFileSync(path.join(REPO, rel), "utf8"), `${rel} のコピーが違う`);
    }
  });
});

// ---------------------------------------------------------------------------
// docs の `npm run <script>`：名前の途中で切れて、存在する別の名前に一致しないこと
// ---------------------------------------------------------------------------

describe("docs の npm run の名前を最後まで読む", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const docs = ["CLAUDE.md", "docs/dev-db-setup.md", ".env.example"];

  it("英数字・_・.・- まで含めて読んでも、すべて package.json にある", () => {
    let seen = 0;
    for (const rel of docs) {
      const text = readFileSync(path.join(REPO, rel), "utf8");
      for (const m of Array.from(text.matchAll(/npm run ([A-Za-z0-9_:.-]*[A-Za-z0-9_])/g))) {
        seen += 1;
        assert.ok(pkg.scripts[m[1]] !== undefined, `${rel} mentions missing script ${m[1]}`);
      }
    }
    assert.ok(seen >= 10, `docs の npm run を ${seen} 件しか読めていない（走査の前提）`);
  });

  it("db:local:verify-quiz-admin は CLAUDE.md に名前の全体で書かれている", () => {
    const text = readFileSync(path.join(REPO, "CLAUDE.md"), "utf8");
    assert.match(text, /npm run db:local:verify-quiz-admin(?![A-Za-z0-9_:.-])/, "CLAUDE.md に db:local:verify-quiz-admin がない");
  });
});
