import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import {
  STUDENT_SESSION,
  createFakeDb,
  installFakeAuth,
  installFakePrisma,
  seed,
  type FakeDb,
  type FakeSession,
} from "./student-routes.test-helpers";

// #11 追加テスト（tester）：change-password / reset-password の異常系・他ユーザーへの影響、
// および auth.ts / auth.config.ts / middleware.ts の依存関係（Edge に DB を持ち込まない）の静的確認。
// DB なし（globalThis.prisma のインメモリ fake）、ネットワークなし、NextAuth はスタブ。
// データはすべてダミー（example.com）。

let db: FakeDb;
let session: FakeSession | { user: { email: string } };
let changePassword: (req: Request) => Promise<Response>;
let reset: (req: Request) => Promise<Response>;
let logs: string[];

const HOUR = 3600_000;
const CURRENT_PASSWORD = "dummy-current-11e";
const NEW_PASSWORD = "dummy-new-password-11e";

const changeReq = (body: unknown) =>
  new Request("http://localhost/api/user/change-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const resetReq = (body: unknown) =>
  new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const user = (id: string) => db.users.find((u) => u.id === id)!;
const snapshotUsers = () => db.users.map((u) => ({ ...u }));

before(async () => {
  db = createFakeDb();
  installFakePrisma(db);
  installFakeAuth(() => session as FakeSession);
  ({ POST: changePassword } = await import("../../src/app/api/user/change-password/route"));
  ({ POST: reset } = await import("../../src/app/api/auth/reset-password/route"));
});

beforeEach(() => {
  for (const k of ["users", "resets", "progress", "quizAttempts", "comments", "assignments", "notifications", "calls"] as const) {
    db[k].length = 0;
  }
  db.beforeTransaction = undefined;
  seed(db);
  user("stu_active").password = bcrypt.hashSync(CURRENT_PASSWORD, 4);
  user("ins_1").password = bcrypt.hashSync(CURRENT_PASSWORD, 4);
  const future = new Date(Date.now() + HOUR);
  db.resets.push(
    { id: "r1", userId: "stu_active", token: "tok-e-active", expiresAt: future, used: false },
    { id: "r2", userId: "ins_1", token: "tok-e-ins", expiresAt: future, used: false }
  );
  session = STUDENT_SESSION;
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    mock.method(console, level, (...args: unknown[]) => logs.push(args.map(String).join(" ")));
  }
  mock.method(globalThis, "fetch", async () => {
    throw new Error("network access is not allowed in tests");
  });
});

afterEach(() => {
  mock.restoreAll();
});

describe("change-password: 異常系・権限（追加）", () => {
  it("新パスワードの長さ判定は現在のパスワード照合より先（7 文字＋誤った現在パスワードでも長さエラー、DB を読まない）", async () => {
    const res = await changePassword(changeReq({ currentPassword: "wrong-dummy", newPassword: "1234567" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Password must be at least 8 characters" });
    assert.ok(!db.calls.some((c) => c.method === "user.findUnique"));
  });

  it("配列・オブジェクト・null（length が 8 以上に見えるものを含む）は 400", async () => {
    for (const newPassword of [["a", "b", "c", "d", "e", "f", "g", "h"], { length: 8 }, null, true]) {
      const res = await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword }));
      assert.equal(res.status, 400, JSON.stringify(newPassword));
      assert.deepEqual(await res.json(), { error: "Password must be at least 8 characters" });
    }
    assert.ok(!db.calls.some((c) => c.method === "user.update"));
  });

  it("未ログイン（セッションはあるが id・email とも無い）は 401", async () => {
    session = { user: {} } as FakeSession;
    const res = await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(db.calls.length, 0);
  });

  it("セッションのユーザーが DB に存在しない → 404 User not found（既存の挙動）", async () => {
    session = { user: { id: "usr_missing", role: "STUDENT" } };
    const res = await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "User not found" });
  });

  it("成功時に更新されるのは本人の行だけ（他ユーザーのパスワード・sessionVersion は不変）", async () => {
    const before = snapshotUsers();
    const res = await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 200);
    const updates = db.calls.filter((c) => c.method === "user.update");
    assert.equal(updates.length, 1);
    assert.deepEqual((updates[0].args[0] as { where: unknown }).where, { id: "stu_active" });
    for (const u of before.filter((x) => x.id !== "stu_active")) {
      assert.deepEqual(user(u.id), u);
    }
    assert.deepEqual(logs, []);
  });

  it("他ユーザー（講師）の現在パスワードを知っていても、自分のセッションでは講師の行は変わらない", async () => {
    // 学生のセッションで、講師の現在パスワード（同じダミー値）を送っても対象は本人のみ。
    const insBefore = { ...user("ins_1") };
    await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));
    assert.deepEqual(user("ins_1"), insBefore);
  });

  it("id の無い（email のみの）セッションでもメールで本人を特定し、sessionVersion +1", async () => {
    session = { user: { email: "active-7@example.com" } };
    const res = await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 200);
    assert.equal(user("stu_active").sessionVersion, 4);
    assert.equal(user("ins_1").sessionVersion, 0);
  });

  it("currentPassword が文字列以外（数値・配列・オブジェクト・null・欠落）：400、何も更新しない", async () => {
    const before = snapshotUsers();
    for (const currentPassword of [12345678, [CURRENT_PASSWORD], { value: CURRENT_PASSWORD }, null, undefined]) {
      const res = await changePassword(changeReq({ currentPassword, newPassword: NEW_PASSWORD }));
      assert.equal(res.status, 400, JSON.stringify(currentPassword));
      assert.deepEqual(await res.json(), { error: "Current password is incorrect" });
    }
    assert.deepEqual(snapshotUsers(), before);
    assert.ok(!db.calls.some((c) => c.method === "user.findUnique" || c.method === "user.update"));
    assert.deepEqual(logs, []);
  });
});

describe("reset-password: 異常系・他ユーザーへの影響（追加）", () => {
  it("token / newPassword の欠落は 400 Token and new password are required（既存文言）", async () => {
    for (const body of [{ token: "tok-e-active" }, { newPassword: NEW_PASSWORD }, {}]) {
      const res = await reset(resetReq(body));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Token and new password are required" });
    }
  });

  it("7 文字は 400、トークンは消費されない", async () => {
    const res = await reset(resetReq({ token: "tok-e-active", newPassword: "1234567" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Password must be at least 8 characters" });
    assert.equal(db.resets[0].used, false);
  });

  it("ちょうど 8 文字は成功", async () => {
    const res = await reset(resetReq({ token: "tok-e-active", newPassword: "12345678" }));
    assert.equal(res.status, 200);
    assert.ok(await bcrypt.compare("12345678", user("stu_active").password));
  });

  it("成功時に変わるのはトークンの持ち主だけ（他ユーザーの行・他ユーザーのトークンは不変）", async () => {
    const before = snapshotUsers();
    const res = await reset(resetReq({ token: "tok-e-active", newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 200);
    assert.equal(user("stu_active").sessionVersion, 4);
    for (const u of before.filter((x) => x.id !== "stu_active")) {
      assert.deepEqual(user(u.id), u);
    }
    assert.equal(db.resets.find((r) => r.id === "r2")!.used, false);
    const upd = db.calls.find((c) => c.method === "user.update")!;
    assert.deepEqual((upd.args[0] as { where: unknown }).where, { id: "stu_active" });
    assert.deepEqual(logs, []);
  });

  it("newPassword が文字列以外（数値・配列・オブジェクト・真偽値）：400、何も更新しない・トークンを消費しない", async () => {
    for (const newPassword of [12345678, ["a", "b", "c", "d", "e", "f", "g", "h"], { length: 8 }, true]) {
      const before = snapshotUsers();
      const res = await reset(resetReq({ token: "tok-e-active", newPassword }));
      assert.equal(res.status, 400, JSON.stringify(newPassword));
      assert.deepEqual(await res.json(), { error: "Token and new password are required" });
      assert.deepEqual(snapshotUsers(), before);
      assert.equal(db.resets[0].used, false);
    }
    assert.ok(!db.calls.some((c) => c.method === "passwordReset.findUnique" || c.method === "$transaction"));
    assert.deepEqual(logs, []);
  });

  it("token が文字列以外（数値・配列・オブジェクト）：400、DB を読まず何も更新しない", async () => {
    const before = snapshotUsers();
    for (const token of [12345, ["tok-e-active"], { equals: "tok-e-active" }]) {
      const res = await reset(resetReq({ token, newPassword: NEW_PASSWORD }));
      assert.equal(res.status, 400, JSON.stringify(token));
      assert.deepEqual(await res.json(), { error: "Token and new password are required" });
    }
    assert.deepEqual(snapshotUsers(), before);
    assert.equal(db.resets[0].used, false);
    assert.equal(db.calls.length, 0);
    assert.deepEqual(logs, []);
  });
});

describe("依存関係の静的確認（Edge の middleware に DB を持ち込まない）", () => {
  const src = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  const importsOf = (code: string) =>
    Array.from(code.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)).map((m) => ({
      typeOnly: !!m[1],
      from: m[2],
    }));

  it("middleware.ts は next-auth と auth.config だけを読み込む", () => {
    const froms = importsOf(src("src/middleware.ts")).map((i) => i.from).sort();
    assert.deepEqual(froms, ["@/lib/auth.config", "next-auth"]);
  });

  it("auth.config.ts は実行時の import を持たない（型 import のみ）", () => {
    const imports = importsOf(src("src/lib/auth.config.ts"));
    assert.ok(imports.length > 0);
    for (const i of imports) assert.ok(i.typeOnly, `runtime import in auth.config.ts: ${i.from}`);
    assert.ok(!/prisma|session-guard/i.test(src("src/lib/auth.config.ts").replace(/\/\/.*$/gm, "")));
  });

  it("session-guard.ts の @prisma/client / next-auth は型 import のみ", () => {
    for (const i of importsOf(src("src/lib/session-guard.ts"))) {
      if (i.from === "@prisma/client" || i.from.startsWith("next-auth")) {
        assert.ok(i.typeOnly, `runtime import of ${i.from}`);
      }
    }
  });

  it("auth.ts（Node 側）は jwt を makeJwtCallback で上書きし、authorize が sessionVersion を返す", () => {
    const code = src("src/lib/auth.ts");
    assert.match(code, /jwt:\s*makeJwtCallback\(\s*prisma\s*,\s*authConfig\.callbacks\.jwt\s*\)/);
    assert.match(code, /sessionVersion:\s*user\.sessionVersion/);
    // callbacks は authConfig.callbacks を展開した上で jwt だけを差し替える（session / authorized は維持）。
    assert.match(code, /callbacks:\s*\{\s*\.\.\.authConfig\.callbacks,/);
  });
});
