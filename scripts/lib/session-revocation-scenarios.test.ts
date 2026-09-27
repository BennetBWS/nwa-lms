import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import type { JWT } from "next-auth/jwt";
import { authConfig } from "../../src/lib/auth.config";
import { SESSION_USER_SELECT, makeJwtCallback, type SessionGuardDb } from "../../src/lib/session-guard";
import { deactivateStudent, reactivateStudent, type StudentStatusDb } from "../../src/lib/student-status";
import {
  createFakeDb,
  installFakeAuth,
  installFakePrisma,
  seed,
  type FakeDb,
  type FakeSession,
} from "./student-routes.test-helpers";

// #11 シナリオテスト：「サインイン → DB 側の変更 → 次の auth() 相当」を通しで確認する。
// - auth() 相当 = makeJwtCallback（本番と同じく auth.config.ts の jwt を baseJwt に使う）
//   → auth.config.ts の session コールバック。NextAuth 本体は読み込まない。
// - DB はインメモリの fake（globalThis.prisma）。ネットワーク・実 DB には接続しない。
// - 変更系は本番のコード（deactivateStudent / reactivateStudent / change-password /
//   reset-password の route）を fake DB に対して実行する。
// データはすべてダミー（example.com）。

type JwtCallback = NonNullable<NonNullable<typeof authConfig.callbacks>["jwt"]>;
type JwtParams = Parameters<JwtCallback>[0];
type SessionCallback = NonNullable<NonNullable<typeof authConfig.callbacks>["session"]>;
type SessionParams = Parameters<SessionCallback>[0];

let db: FakeDb;
let guard: JwtCallback;
/** auth() が返すセッション（テストごとに「どの端末の cookie か」を切り替える）。 */
let currentCookie: JWT | null;
let changePassword: (req: Request) => Promise<Response>;
let reset: (req: Request) => Promise<Response>;
let logs: string[];

const HOUR = 3600_000;
const CURRENT_PASSWORD = "dummy-current-11s";
const NEW_PASSWORD = "dummy-new-password-11s";

const user = (id: string) => db.users.find((u) => u.id === id)!;
const findUniqueCalls = () => db.calls.filter((c) => c.method === "user.findUnique");

/** src/lib/auth.ts の authorize が返す値と同じ形で、jwt コールバックの signIn を実行する。 */
async function signIn(id: string): Promise<JWT> {
  const u = user(id);
  const authorizeResult = {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    image: u.avatar,
    sessionVersion: u.sessionVersion,
  };
  const token = await guard({
    token: { name: u.name, email: u.email, picture: u.avatar, sub: u.id } as JWT,
    user: authorizeResult,
    account: { provider: "credentials", type: "credentials", providerAccountId: u.id },
    trigger: "signIn",
  } as unknown as JwtParams);
  assert.ok(token, "sign-in must succeed");
  return token as JWT;
}

/** auth() 相当：jwt コールバック（DB 照合）→ session コールバック。失効なら null。 */
async function authLike(cookie: JWT | null) {
  if (!cookie) return null;
  const token = await guard({ token: cookie } as unknown as JwtParams);
  if (!token) return null;
  const session = {
    user: { name: token.name, email: token.email, image: token.picture },
    expires: new Date(Date.now() + HOUR).toISOString(),
  };
  return authConfig.callbacks!.session!({ session, token } as unknown as SessionParams);
}

const changeReq = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/user/change-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const resetReq = (token: string, newPassword: unknown = NEW_PASSWORD) =>
  new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });

before(async () => {
  db = createFakeDb();
  installFakePrisma(db);
  // route の auth() は「現在の cookie を DB と照合した結果」を返す（本番の auth() 相当）。
  installFakeAuth((() => authLike(currentCookie)) as unknown as () => FakeSession);
  guard = makeJwtCallback(db.client as unknown as SessionGuardDb, authConfig.callbacks!.jwt!);
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
  db.resets.push({
    id: "r1",
    userId: "stu_active",
    token: "tok-scenario",
    expiresAt: new Date(Date.now() + HOUR),
    used: false,
  });
  currentCookie = null;
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    mock.method(console, level, (...args: unknown[]) => logs.push(args.map(String).join(" ")));
  }
  mock.method(globalThis, "fetch", async () => {
    throw new Error("network access is not allowed in tests");
  });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

function assertNoPersonalDataInLogs() {
  for (const line of logs) {
    for (const u of db.users) {
      for (const s of [u.id, u.email, u.name, u.password]) {
        assert.ok(!line.includes(s), `log must not contain personal data: ${line}`);
      }
    }
    for (const s of ["tok-scenario", CURRENT_PASSWORD, NEW_PASSWORD]) {
      assert.ok(!line.includes(s), `log must not contain secrets: ${line}`);
    }
  }
}

describe("サインイン直後とアクセスごとの DB 読み取り", () => {
  it("サインインでは DB を読まず、以後のアクセスごとに findUnique がちょうど 1 回（password は select しない）", async () => {
    const cookie = await signIn("stu_active");
    assert.equal(findUniqueCalls().length, 0, "sign-in must not read the DB");
    assert.equal(cookie.sv, 3);

    for (let i = 1; i <= 3; i++) {
      const s = await authLike(cookie);
      assert.equal(s?.user?.id, "stu_active");
      assert.equal(s?.user?.role, "STUDENT");
      assert.equal(findUniqueCalls().length, i);
    }
    for (const c of findUniqueCalls()) {
      const args = c.args[0] as { where: unknown; select: Record<string, unknown> };
      assert.deepEqual(args.where, { id: "stu_active" });
      assert.deepEqual(args.select, SESSION_USER_SELECT);
      assert.ok(!("password" in args.select), "password must not be selected");
    }
    assert.deepEqual(logs, []);
  });

  it("セッションに password（ハッシュ）が入らない", async () => {
    const cookie = await signIn("stu_active");
    const next = await guard({ token: cookie } as unknown as JwtParams);
    const serialized = JSON.stringify([cookie, next, await authLike(cookie)]);
    assert.ok(!serialized.includes(user("stu_active").password));
    assert.ok(!/"password"/.test(serialized));
  });
});

describe("DB 側の変更で次の auth() 相当が null になる", () => {
  it("無効化（deactivateStudent）→ null。再有効化しても無効化前のトークンは復活しない。再ログインすれば有効", async () => {
    const oldCookie = await signIn("stu_active");
    assert.ok(await authLike(oldCookie));

    const off = await deactivateStudent(db.client as unknown as StudentStatusDb, "stu_active");
    assert.equal(off.kind, "ok");
    assert.equal(await authLike(oldCookie), null);

    const on = await reactivateStudent(db.client as unknown as StudentStatusDb, "stu_active");
    assert.equal(on.kind, "ok");
    assert.equal(user("stu_active").deactivatedAt, null);
    assert.equal(await authLike(oldCookie), null, "old token (sv before deactivation) must stay revoked");

    const fresh = await signIn("stu_active");
    assert.equal(fresh.sv, 4);
    assert.equal((await authLike(fresh))?.user?.id, "stu_active");
    assertNoPersonalDataInLogs();
  });

  it("無効化を 2 回実行しても sessionVersion は 1 回だけ進み、再有効化後の新しいトークンは有効", async () => {
    const dbs = db.client as unknown as StudentStatusDb;
    await deactivateStudent(dbs, "stu_active");
    await deactivateStudent(dbs, "stu_active");
    await reactivateStudent(dbs, "stu_active");
    assert.equal(user("stu_active").sessionVersion, 4);
    assert.ok(await authLike(await signIn("stu_active")));
  });

  it("ロール変更 → null", async () => {
    const cookie = await signIn("stu_active");
    user("stu_active").role = "INSTRUCTOR";
    assert.equal(await authLike(cookie), null);
  });

  it("メールアドレス変更 → null", async () => {
    const cookie = await signIn("stu_active");
    user("stu_active").email = "changed-11s@example.com";
    assert.equal(await authLike(cookie), null);
  });

  it("sessionVersion 変更 → null", async () => {
    const cookie = await signIn("stu_active");
    user("stu_active").sessionVersion += 1;
    assert.equal(await authLike(cookie), null);
  });

  it("ユーザー行の物理削除 → null", async () => {
    const cookie = await signIn("stu_active");
    db.users.splice(db.users.indexOf(user("stu_active")), 1);
    assert.equal(await authLike(cookie), null);
  });

  it("名前・アバターの変更では失効せず、セッションの表示名が DB の値に追従する", async () => {
    const cookie = await signIn("stu_active");
    user("stu_active").name = "Renamed 11s";
    user("stu_active").avatar = "/avatars/dummy-11s.png";
    const s = await authLike(cookie);
    assert.equal(s?.user?.name, "Renamed 11s");
    assert.equal(s?.user?.image, "/avatars/dummy-11s.png");
  });

  it("他人の id に書き換えたトークン（ロール・メール・sv が一致しない）は null", async () => {
    const cookie = await signIn("stu_active");
    assert.equal(await authLike({ ...cookie, id: "ins_1" }), null);
    assert.equal(await authLike({ ...cookie, id: "stu_off" }), null);
  });
});

describe("パスワード変更（change-password）で全端末が失効する", () => {
  it("端末 A で変更 → 端末 A・B とも null。他ユーザーのセッションは影響を受けない。新しいパスワードで再ログインすれば有効", async () => {
    const deviceA = await signIn("stu_active");
    const deviceB = await signIn("stu_active");
    const instructor = await signIn("ins_1");

    currentCookie = deviceA;
    const res = await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });

    assert.equal(await authLike(deviceA), null);
    assert.equal(await authLike(deviceB), null);
    assert.equal((await authLike(instructor))?.user?.id, "ins_1");
    assert.equal(user("ins_1").sessionVersion, 0);
    assert.equal(user("stu_off").sessionVersion, 5);

    const fresh = await signIn("stu_active");
    assert.equal(fresh.sv, 4);
    assert.ok(await authLike(fresh));
    assertNoPersonalDataInLogs();
  });

  it("失効済みのトークンで change-password を呼ぶと 401（パスワード・sessionVersion 不変）", async () => {
    const old = await signIn("stu_active");
    await deactivateStudent(db.client as unknown as StudentStatusDb, "stu_active");
    await reactivateStudent(db.client as unknown as StudentStatusDb, "stu_active");
    const before = { ...user("stu_active") };

    currentCookie = old;
    const res = await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.deepEqual(user("stu_active"), before);
  });

  it("同じ端末で 2 回続けて変更しようとすると 2 回目は 401（1 回目でこの端末も失効している）", async () => {
    currentCookie = await signIn("stu_active");
    assert.equal((await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }))).status, 200);
    const res = await changePassword(changeReq({ currentPassword: NEW_PASSWORD, newPassword: "another-dummy-11s" }));
    assert.equal(res.status, 401);
    assert.ok(await bcrypt.compare(NEW_PASSWORD, user("stu_active").password));
    assert.equal(user("stu_active").sessionVersion, 4);
  });

  it("DB の読み取りで例外 → auth() 相当は null（fail-closed）→ change-password は 401。ログは固定文言のみ", async () => {
    currentCookie = await signIn("stu_active");
    const client = db.client as { user: { findUnique: unknown } };
    const original = client.user.findUnique;
    client.user.findUnique = async () => {
      throw Object.assign(new Error("connect failed for active-7@example.com stu_active"), { code: "P1001" });
    };
    try {
      const res = await changePassword(changeReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));
      assert.equal(res.status, 401);
    } finally {
      client.user.findUnique = original;
    }
    assert.deepEqual(logs, ["[auth] session check failed: Error"]);
    assertNoPersonalDataInLogs();
  });
});

describe("パスワードリセット（reset-password）で全端末が失効する", () => {
  it("リセット成功 → ログイン中の全端末が null。他ユーザーは影響を受けない", async () => {
    const deviceA = await signIn("stu_active");
    const deviceB = await signIn("stu_active");
    const instructor = await signIn("ins_1");

    const res = await reset(resetReq("tok-scenario"));
    assert.equal(res.status, 200);
    assert.equal(await authLike(deviceA), null);
    assert.equal(await authLike(deviceB), null);
    assert.ok(await authLike(instructor));
    assert.ok(await authLike(await signIn("stu_active")));
    assertNoPersonalDataInLogs();
  });

  it("リセットに失敗（使用済み）した場合は sessionVersion が進まず、既存の端末は有効なまま", async () => {
    const device = await signIn("stu_active");
    db.resets[0].used = true;
    const res = await reset(resetReq("tok-scenario"));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Token already used" });
    assert.ok(await authLike(device));
  });
});

describe("reset-password の期限境界（Date を固定）", () => {
  const NOW = Date.parse("2026-09-28T00:00:00.000Z");

  const run = async (expiresAt: number) => {
    db.resets[0].expiresAt = new Date(expiresAt);
    mock.timers.enable({ apis: ["Date"], now: NOW });
    const snapshot = { ...user("stu_active") };
    const res = await reset(resetReq("tok-scenario"));
    return { res, snapshot, body: (await res.json()) as Record<string, unknown> };
  };

  it("期限の 1ms 前：成功、sessionVersion +1", async () => {
    const { res, snapshot } = await run(NOW + 1);
    assert.equal(res.status, 200);
    assert.equal(user("stu_active").sessionVersion, snapshot.sessionVersion + 1);
  });

  it("期限の 1ms 後：Token expired（400）、トランザクションに入らない", async () => {
    const { res, body, snapshot } = await run(NOW - 1);
    assert.equal(res.status, 400);
    assert.deepEqual(body, { error: "Token expired" });
    assert.deepEqual(user("stu_active"), snapshot);
    assert.ok(!db.calls.some((c) => c.method === "$transaction"));
  });

  it("期限ちょうど（expiresAt === now）：400 でパスワード・sessionVersion・トークンとも不変", async () => {
    // 事前判定（expiresAt < now で期限切れ）は通過し、条件付き更新（expiresAt > now）で弾かれる。
    // 応答文言は現状 "Invalid token"（読み直し後の判定も有効扱いになり、フォールバックに落ちる）。
    // 安全性（変更されないこと）のみを固定し、文言は報告事項とする。
    const { res, body, snapshot } = await run(NOW);
    assert.equal(res.status, 400);
    assert.ok(
      body.error === "Token expired" || body.error === "Invalid token",
      `unexpected error: ${JSON.stringify(body)}`
    );
    assert.deepEqual(user("stu_active"), snapshot);
    assert.equal(db.resets[0].used, false);
  });
});
