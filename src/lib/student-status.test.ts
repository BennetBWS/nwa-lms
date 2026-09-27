import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deactivateStudent,
  parseStudentStatusFilter,
  reactivateStudent,
  studentListWhere,
  studentStatusOf,
  type StudentStatusDb,
} from "./student-status";

// #7: soft deactivation. No DB: an in-memory fake with the few Prisma methods used.
// All data are dummies.

type Row = { id: string; role: "STUDENT" | "INSTRUCTOR"; deactivatedAt: Date | null; sessionVersion: number };
type Token = { userId: string; used: boolean };
type Where = { id?: string; role?: string; deactivatedAt?: null | { not: null } };

function matches(row: Row, where: Where): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.role !== undefined && row.role !== where.role) return false;
  if (where.deactivatedAt === null && row.deactivatedAt !== null) return false;
  if (where.deactivatedAt && "not" in where.deactivatedAt && row.deactivatedAt === null) return false;
  return true;
}

function makeFake(
  rows: Row[],
  tokens: Token[] = [],
  hooks: { afterUserUpdateMany?: () => void } = {}
) {
  const calls: string[] = [];
  let transactions = 0;
  const user = {
    async findUnique(args: { where: { id: string } }) {
      calls.push("user.findUnique");
      const row = rows.find((r) => r.id === args.where.id);
      return row ? { id: row.id, role: row.role, deactivatedAt: row.deactivatedAt } : null;
    },
    async updateMany(args: {
      where: Where;
      data: { deactivatedAt?: Date | null; sessionVersion?: { increment: number } };
    }) {
      calls.push("user.updateMany");
      const hit = rows.filter((r) => matches(r, args.where));
      for (const r of hit) {
        if ("deactivatedAt" in args.data) r.deactivatedAt = args.data.deactivatedAt ?? null;
        if (args.data.sessionVersion) r.sessionVersion += args.data.sessionVersion.increment;
      }
      // Lets a test change the row between the update and the read-back.
      hooks.afterUserUpdateMany?.();
      return { count: hit.length };
    },
    // Destructive methods must never be called; they record the call and throw.
    async update() {
      calls.push("user.update");
      throw new Error("user.update must not be called");
    },
    async delete() {
      calls.push("user.delete");
      throw new Error("user.delete must not be called");
    },
    async deleteMany() {
      calls.push("user.deleteMany");
      throw new Error("user.deleteMany must not be called");
    },
  };
  const passwordReset = {
    async updateMany(args: { where: { userId: string; used: boolean }; data: { used: boolean } }) {
      calls.push("passwordReset.updateMany");
      assert.deepEqual(args.data, { used: true });
      let count = 0;
      for (const t of tokens) {
        if (t.userId === args.where.userId && t.used === args.where.used) {
          t.used = true;
          count++;
        }
      }
      return { count };
    },
    async deleteMany() {
      calls.push("passwordReset.deleteMany");
      throw new Error("passwordReset.deleteMany must not be called");
    },
  };
  const tx = { user, passwordReset };
  const db = {
    ...tx,
    async $transaction<T>(fn: (t: typeof tx) => Promise<T>): Promise<T> {
      transactions++;
      calls.push("$transaction");
      return fn(tx);
    },
  };
  return {
    db: db as unknown as StudentStatusDb,
    calls,
    get transactions() {
      return transactions;
    },
  };
}

const NOW = new Date("2026-09-27T12:00:00.000Z");
const EARLIER = new Date("2026-09-01T00:00:00.000Z");

let rows: Row[];
let tokens: Token[];

beforeEach(() => {
  rows = [
    { id: "stu_active", role: "STUDENT", deactivatedAt: null, sessionVersion: 3 },
    { id: "stu_off", role: "STUDENT", deactivatedAt: EARLIER, sessionVersion: 5 },
    { id: "ins_1", role: "INSTRUCTOR", deactivatedAt: null, sessionVersion: 0 },
  ];
  tokens = [
    { userId: "stu_active", used: false },
    { userId: "stu_active", used: false },
    { userId: "stu_active", used: true },
    { userId: "ins_1", used: false },
  ];
});

describe("deactivateStudent", () => {
  it("sets deactivatedAt, bumps sessionVersion, invalidates unused tokens, deletes nothing", async () => {
    const fake = makeFake(rows, tokens);
    const result = await deactivateStudent(fake.db, "stu_active", NOW);

    assert.deepEqual(result, {
      kind: "ok",
      changed: true,
      student: { id: "stu_active", status: "deactivated", deactivatedAt: NOW.toISOString() },
    });
    assert.equal(rows[0].deactivatedAt, NOW);
    assert.equal(rows[0].sessionVersion, 4);
    assert.deepEqual(
      tokens.filter((t) => t.userId === "stu_active").map((t) => t.used),
      [true, true, true]
    );
    assert.equal(tokens[3].used, false, "other users' tokens are untouched");
    assert.equal(fake.transactions, 1, "runs in one transaction");
    assert.ok(!fake.calls.some((c) => /delete/i.test(c)), `no delete call: ${fake.calls}`);
  });

  it("is idempotent: keeps the original deactivatedAt and does not bump sessionVersion again", async () => {
    const fake = makeFake(rows, tokens);
    const first = await deactivateStudent(fake.db, "stu_active", NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const second = await deactivateStudent(fake.db, "stu_active", later);

    assert.equal(first.kind, "ok");
    assert.deepEqual(second, {
      kind: "ok",
      changed: false,
      student: { id: "stu_active", status: "deactivated", deactivatedAt: NOW.toISOString() },
    });
    assert.equal(rows[0].sessionVersion, 4);
    assert.ok(!fake.calls.some((c) => /delete/i.test(c)));
  });

  it("already deactivated student: returns the current state unchanged", async () => {
    const fake = makeFake(rows, tokens);
    const result = await deactivateStudent(fake.db, "stu_off", NOW);
    assert.deepEqual(result, {
      kind: "ok",
      changed: false,
      student: { id: "stu_off", status: "deactivated", deactivatedAt: EARLIER.toISOString() },
    });
    assert.equal(rows[1].sessionVersion, 5);
  });

  it("instructor: not_found, nothing is changed", async () => {
    const fake = makeFake(rows, tokens);
    assert.deepEqual(await deactivateStudent(fake.db, "ins_1", NOW), { kind: "not_found" });
    assert.equal(rows[2].deactivatedAt, null);
    assert.equal(rows[2].sessionVersion, 0);
    assert.equal(tokens[3].used, false);
    assert.ok(!fake.calls.includes("user.updateMany"));
    assert.ok(!fake.calls.includes("passwordReset.updateMany"));
  });

  it("unknown id: not_found, nothing is changed", async () => {
    const fake = makeFake(rows, tokens);
    assert.deepEqual(await deactivateStudent(fake.db, "nope", NOW), { kind: "not_found" });
    assert.deepEqual(fake.calls, ["$transaction", "user.findUnique"]);
  });
});

describe("reactivateStudent", () => {
  it("clears deactivatedAt only; sessionVersion and tokens are unchanged", async () => {
    const fake = makeFake(rows, tokens);
    const result = await reactivateStudent(fake.db, "stu_off");

    assert.deepEqual(result, {
      kind: "ok",
      changed: true,
      student: { id: "stu_off", status: "active", deactivatedAt: null },
    });
    assert.equal(rows[1].deactivatedAt, null);
    assert.equal(rows[1].sessionVersion, 5);
    assert.equal(fake.transactions, 1, "runs in one transaction");
    assert.deepEqual(fake.calls, [
      "$transaction",
      "user.findUnique",
      "user.updateMany",
      "user.findUnique",
    ]);
    assert.ok(!fake.calls.some((c) => /delete|passwordReset/i.test(c)));
  });

  it("answers from the row read back after the update, not from assumed values", async () => {
    // Simulates the row changing between the update and the read-back
    // (e.g. a concurrent deactivation): the response must reflect the DB.
    const fake = makeFake(rows, tokens, {
      afterUserUpdateMany: () => {
        rows[1].deactivatedAt = NOW;
      },
    });
    const result = await reactivateStudent(fake.db, "stu_off");
    assert.deepEqual(result, {
      kind: "ok",
      changed: true,
      student: { id: "stu_off", status: "deactivated", deactivatedAt: NOW.toISOString() },
    });
  });

  it("not_found when the user is no longer a student on read-back", async () => {
    const fake = makeFake(rows, tokens, {
      afterUserUpdateMany: () => {
        rows[1].role = "INSTRUCTOR";
      },
    });
    assert.deepEqual(await reactivateStudent(fake.db, "stu_off"), { kind: "not_found" });
  });

  it("is idempotent for an active student", async () => {
    const fake = makeFake(rows, tokens);
    const result = await reactivateStudent(fake.db, "stu_active");
    assert.deepEqual(result, {
      kind: "ok",
      changed: false,
      student: { id: "stu_active", status: "active", deactivatedAt: null },
    });
    assert.equal(rows[0].sessionVersion, 3);
  });

  it("deactivate -> reactivate round trip keeps the bumped sessionVersion", async () => {
    const fake = makeFake(rows, tokens);
    await deactivateStudent(fake.db, "stu_active", NOW);
    await reactivateStudent(fake.db, "stu_active");
    assert.equal(rows[0].deactivatedAt, null);
    assert.equal(rows[0].sessionVersion, 4);
  });

  it("instructor / unknown id: not_found", async () => {
    const fake = makeFake(rows, tokens);
    assert.deepEqual(await reactivateStudent(fake.db, "ins_1"), { kind: "not_found" });
    assert.deepEqual(await reactivateStudent(fake.db, "nope"), { kind: "not_found" });
    assert.ok(!fake.calls.includes("user.updateMany"));
    assert.equal(fake.transactions, 2);
  });
});

describe("studentStatusOf", () => {
  it("maps deactivatedAt to status and an ISO string", () => {
    assert.deepEqual(studentStatusOf({ id: "a", deactivatedAt: null }), {
      id: "a",
      status: "active",
      deactivatedAt: null,
    });
    assert.deepEqual(studentStatusOf({ id: "b", deactivatedAt: EARLIER }), {
      id: "b",
      status: "deactivated",
      deactivatedAt: "2026-09-01T00:00:00.000Z",
    });
  });
});

describe("student list status filter", () => {
  it("defaults to active; accepts active / deactivated / all; rejects anything else", () => {
    assert.equal(parseStudentStatusFilter(null), "active");
    assert.equal(parseStudentStatusFilter("active"), "active");
    assert.equal(parseStudentStatusFilter("deactivated"), "deactivated");
    assert.equal(parseStudentStatusFilter("all"), "all");
    for (const v of ["", "ACTIVE", "inactive", "deleted", " all", "active,deactivated"]) {
      assert.equal(parseStudentStatusFilter(v), null, `"${v}" is rejected`);
    }
  });

  it("builds a where clause limited to students", () => {
    assert.deepEqual(studentListWhere("active"), { role: "STUDENT", deactivatedAt: null });
    assert.deepEqual(studentListWhere("deactivated"), {
      role: "STUDENT",
      deactivatedAt: { not: null },
    });
    assert.deepEqual(studentListWhere("all"), { role: "STUDENT" });
  });
});

describe("deactivate / reactivate round trips (#7)", () => {
  it("deactivate -> deactivate -> reactivate -> deactivate: +1 per effective deactivation, first deactivatedAt kept", async () => {
    const fake = makeFake(rows, tokens);
    const t1 = new Date("2026-09-27T10:00:00.000Z");
    const t2 = new Date("2026-09-27T11:00:00.000Z");
    const t3 = new Date("2026-09-27T12:00:00.000Z");

    const a = await deactivateStudent(fake.db, "stu_active", t1);
    const b = await deactivateStudent(fake.db, "stu_active", t2);
    assert.ok(a.kind === "ok" && a.changed && b.kind === "ok" && !b.changed);
    assert.equal(rows[0].sessionVersion, 4);
    assert.equal(rows[0].deactivatedAt, t1, "second deactivation keeps the first time");

    const r = await reactivateStudent(fake.db, "stu_active");
    assert.ok(r.kind === "ok" && r.changed);
    assert.equal(rows[0].sessionVersion, 4);

    const c = await deactivateStudent(fake.db, "stu_active", t3);
    assert.deepEqual(c, {
      kind: "ok",
      changed: true,
      student: { id: "stu_active", status: "deactivated", deactivatedAt: t3.toISOString() },
    });
    assert.equal(rows[0].sessionVersion, 5);
    assert.ok(!fake.calls.some((x) => /delete/i.test(x)));
  });

  it("concurrent deactivations bump sessionVersion only once", async () => {
    const fake = makeFake(rows, tokens);
    const results = await Promise.all([
      deactivateStudent(fake.db, "stu_active", NOW),
      deactivateStudent(fake.db, "stu_active", new Date(NOW.getTime() + 1)),
    ]);
    assert.equal(rows[0].sessionVersion, 4);
    assert.equal(rows[0].deactivatedAt, NOW);
    assert.deepEqual(
      results.map((x) => x.kind === "ok" && x.changed),
      [true, false]
    );
  });
});
