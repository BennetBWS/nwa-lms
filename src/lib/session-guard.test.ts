import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { NextAuthConfig } from "next-auth";
import type { JWT } from "next-auth/jwt";
import {
  SESSION_USER_SELECT,
  evaluateToken,
  makeJwtCallback,
  type SessionGuardDb,
  type SessionUserRow,
} from "./session-guard";

// #11: immediate revocation of JWT sessions. No DB (in-memory fake), no network,
// NextAuth is not loaded (type imports only). All data are dummies (example.com).

type JwtCallback = NonNullable<NonNullable<NextAuthConfig["callbacks"]>["jwt"]>;
type JwtParams = Parameters<JwtCallback>[0];

const ID = "usr_guard_1";
const EMAIL = "guard-11@example.com";
const SECRET_MARKER = "jti-secret-marker-11";

const row = (over: Partial<SessionUserRow> = {}): SessionUserRow => ({
  deactivatedAt: null,
  sessionVersion: 4,
  role: "STUDENT",
  email: EMAIL,
  name: "Guard User",
  avatar: null,
  ...over,
});

const token = (over: Partial<JWT> = {}): JWT => ({
  id: ID,
  role: "STUDENT",
  email: EMAIL,
  name: "Guard User",
  picture: null,
  sub: ID,
  sv: 4,
  jti: SECRET_MARKER,
  ...over,
});

// Same logic as auth.config.ts jwt (kept inline so NextAuth / auth.config are not loaded).
const baseJwt: JwtCallback = async ({ token: t, user }) => {
  if (user) {
    t.role = user.role;
    t.id = user.id;
  }
  return t;
};

type FindArgs = { where: { id: string }; select: unknown };

function fakeDb(result: SessionUserRow | null | Error) {
  const calls: FindArgs[] = [];
  const db = {
    user: {
      async findUnique(args: FindArgs) {
        calls.push(args);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
  return { db: db as unknown as SessionGuardDb, calls };
}

const access = (t: JWT) => ({ token: t }) as unknown as JwtParams;

let logs: string[];

beforeEach(() => {
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

function assertNoSecretsInLogs() {
  for (const line of logs) {
    for (const s of [ID, EMAIL, SECRET_MARKER, "Guard User"]) {
      assert.ok(!line.includes(s), `log must not contain ${s}: ${line}`);
    }
  }
}

describe("evaluateToken", () => {
  it("valid when everything matches; the token is returned unchanged", () => {
    const t = token();
    const r = evaluateToken(t, row());
    assert.equal(r.valid, true);
    assert.deepEqual(r.valid && r.token, t);
  });

  const revoked: [string, JWT, SessionUserRow | null, string][] = [
    ["user not found", token(), null, "not_found"],
    ["deactivated", token(), row({ deactivatedAt: new Date("2026-09-01T00:00:00.000Z") }), "deactivated"],
    ["sessionVersion differs", token({ sv: 3 }), row(), "version"],
    ["token without sv (issued before #11)", token({ sv: undefined }), row({ sessionVersion: 0 }), "version"],
    ["role differs", token({ role: "INSTRUCTOR" }), row(), "role"],
    ["email differs", token(), row({ email: "changed-11@example.com" }), "email"],
  ];
  for (const [label, t, u, reason] of revoked) {
    it(`revoked: ${label}`, () => {
      assert.deepEqual(evaluateToken(t, u), { valid: false, reason });
    });
  }

  it("name and avatar follow the DB, without mutating the input token", () => {
    const t = token();
    const r = evaluateToken(t, row({ name: "Renamed", avatar: "/avatars/dummy.png" }));
    assert.equal(r.valid, true);
    if (!r.valid) return;
    assert.equal(r.token.name, "Renamed");
    assert.equal(r.token.picture, "/avatars/dummy.png");
    assert.equal(r.token.sv, 4);
    assert.equal(t.name, "Guard User");
    assert.equal(t.picture, null);
  });
});

describe("makeJwtCallback: access (not sign-in)", () => {
  it("valid: one findUnique by primary key with the fixed select", async () => {
    const { db, calls } = fakeDb(row());
    const out = await makeJwtCallback(db, baseJwt)(access(token()));
    assert.equal(out?.id, ID);
    assert.equal(out?.sv, 4);
    assert.deepEqual(calls, [{ where: { id: ID }, select: SESSION_USER_SELECT }]);
    assert.deepEqual(SESSION_USER_SELECT, {
      deactivatedAt: true,
      sessionVersion: true,
      role: true,
      email: true,
      name: true,
      avatar: true,
    });
    assert.deepEqual(logs, []);
  });

  const revoked: [string, JWT, SessionUserRow | null][] = [
    ["user not found", token(), null],
    ["deactivated", token(), row({ deactivatedAt: new Date() })],
    ["sv differs", token({ sv: 5 }), row()],
    ["sv missing", token({ sv: undefined }), row()],
    ["role differs", token(), row({ role: "INSTRUCTOR" })],
    ["email differs", token(), row({ email: "changed-11@example.com" })],
  ];
  for (const [label, t, u] of revoked) {
    it(`revoked (${label}): null`, async () => {
      const { db, calls } = fakeDb(u);
      assert.equal(await makeJwtCallback(db, baseJwt)(access(t)), null);
      assert.equal(calls.length, 1);
      assertNoSecretsInLogs();
    });
  }

  it("token without id: null, DB not read", async () => {
    for (const t of [token({ id: undefined }), token({ id: "" })]) {
      const { db, calls } = fakeDb(row());
      assert.equal(await makeJwtCallback(db, baseJwt)(access(t)), null);
      assert.equal(calls.length, 0);
    }
  });

  it("DB error: null (fail-closed); log has a fixed text and the error name only", async () => {
    const err = Object.assign(new Error(`connection failed for ${EMAIL} ${ID}`), { code: "P1001" });
    const { db } = fakeDb(err);
    assert.equal(await makeJwtCallback(db, baseJwt)(access(token())), null);
    assert.deepEqual(logs, ["[auth] session check failed: Error"]);
    assertNoSecretsInLogs();
  });

  it("name / avatar changes are reflected into the returned token", async () => {
    const { db } = fakeDb(row({ name: "Renamed", avatar: "/avatars/dummy.png" }));
    const out = await makeJwtCallback(db, baseJwt)(access(token()));
    assert.equal(out?.name, "Renamed");
    assert.equal(out?.picture, "/avatars/dummy.png");
  });

  it("trigger 'update' is checked against the DB like a normal access", async () => {
    const { db, calls } = fakeDb(row({ sessionVersion: 9 }));
    const params = { token: token(), trigger: "update" } as unknown as JwtParams;
    assert.equal(await makeJwtCallback(db, baseJwt)(params), null);
    assert.equal(calls.length, 1);
  });
});

describe("makeJwtCallback: sign-in", () => {
  const signInToken = (): JWT =>
    ({ name: "Guard User", email: EMAIL, picture: null, sub: ID }) as JWT;

  it("does not read the DB; sets id, role and sv from authorize's user", async () => {
    const { db, calls } = fakeDb(new Error("must not be called"));
    const params = {
      token: signInToken(),
      user: { id: ID, email: EMAIL, name: "Guard User", role: "INSTRUCTOR", image: null, sessionVersion: 7 },
      trigger: "signIn",
    } as unknown as JwtParams;
    const out = await makeJwtCallback(db, baseJwt)(params);
    assert.equal(calls.length, 0);
    assert.equal(out?.id, ID);
    assert.equal(out?.role, "INSTRUCTOR");
    assert.equal(out?.sv, 7);
    assert.equal(out?.email, EMAIL);
    assert.deepEqual(logs, []);
  });

  it("user present without trigger is also treated as sign-in (sessionVersion 0 is valid)", async () => {
    const { db, calls } = fakeDb(new Error("must not be called"));
    const params = {
      token: signInToken(),
      user: { id: ID, role: "STUDENT", sessionVersion: 0 },
    } as unknown as JwtParams;
    const out = await makeJwtCallback(db, baseJwt)(params);
    assert.equal(calls.length, 0);
    assert.equal(out?.sv, 0);
  });

  it("authorize result without sessionVersion: refused (null)", async () => {
    const { db, calls } = fakeDb(row());
    const params = {
      token: signInToken(),
      user: { id: ID, role: "STUDENT" },
      trigger: "signIn",
    } as unknown as JwtParams;
    assert.equal(await makeJwtCallback(db, baseJwt)(params), null);
    assert.equal(calls.length, 0);
  });

  it("a token signed in with the current sessionVersion stays valid on the next access", async () => {
    const { db } = fakeDb(row({ sessionVersion: 7 }));
    const cb = makeJwtCallback(db, baseJwt);
    const signedIn = await cb({
      token: signInToken(),
      user: { id: ID, role: "STUDENT", sessionVersion: 7 },
      trigger: "signIn",
    } as unknown as JwtParams);
    assert.ok(signedIn);
    const next = await cb(access(signedIn));
    assert.equal(next?.sv, 7);
  });
});
