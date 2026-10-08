import Module from "node:module";
import path from "node:path";

// Shared helpers for the #7 route tests (admin student APIs, reset token APIs).
//
// SAFETY: no database and no network.
// - `prisma` (src/lib/prisma.ts) reuses `globalThis.prisma`; an in-memory fake is
//   installed there BEFORE the route is imported, so no PrismaClient is created.
// - `auth` (src/lib/auth.ts, NextAuth) is replaced in the CommonJS module cache
//   with a stub whose session is controlled by the test, so NextAuth is never loaded.
// All data are dummies (example.com).
//
// LIMITATION: the fake `$transaction` only runs the callback (or awaits the array).
// It does NOT reproduce rollback on error or isolation levels, so these tests do
// not guarantee atomicity; they only check which calls are made and the results.

export type Role = "STUDENT" | "INSTRUCTOR";

export type UserRow = {
  id: string;
  email: string;
  name: string;
  password: string;
  role: Role;
  avatar: string | null;
  createdAt: Date;
  deactivatedAt: Date | null;
  sessionVersion: number;
};

export type ResetRow = { id: string; userId: string; token: string; expiresAt: Date; used: boolean };

// Child rows that deactivation must keep. Extra columns (e.g. quizAttempt.answers,
// assignment.feedback) may be added; child findMany returns rows as they are
// (select / include are ignored), so a route must pick the fields it returns.
export type ChildRow = {
  id: string;
  userId: string;
  lessonId?: string;
  completed?: boolean;
  completedAt?: Date | null;
  [column: string]: unknown;
};

// Course structure for course.findMany (#32). Not filled by seed(): tests that need
// courses push them (default: no course).
export type FakeCourse = {
  id: string;
  name: string;
  order: number;
  color: string;
  description: string | null;
  sections: { id: string; title: string; lessons: { id: string; title: string }[] }[];
};

type Where = Record<string, unknown>;

const DESTRUCTIVE = ["delete", "deleteMany"] as const;

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return actual === null || actual === undefined;
  if (typeof cond === "object" && !(cond instanceof Date)) {
    const c = cond as Record<string, unknown>;
    if ("not" in c) {
      if (c.not === null) return actual !== null && actual !== undefined;
      return actual !== c.not;
    }
    if ("gt" in c && c.gt instanceof Date) {
      return actual instanceof Date && actual.getTime() > c.gt.getTime();
    }
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  return actual === cond;
}

function matches(row: Record<string, unknown>, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => matchValue(row[k], v));
}

function project(row: UserRow, select: Record<string, unknown> | undefined, db: FakeDb) {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    if (k === "progress") {
      const spec = v as { where?: Where; select?: Record<string, boolean> };
      out.progress = db.progress
        .filter((p) => p.userId === row.id && matches(p as Record<string, unknown>, spec.where))
        .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
        .map((p) => pick({ completedAt: p.completedAt ?? null, lessonId: p.lessonId ?? null }, spec.select ?? { completedAt: true }));
      continue;
    }
    out[k] = (row as Record<string, unknown>)[k];
  }
  return out;
}

function pick(row: Record<string, unknown>, select: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
  return out;
}

type SelectSpec = { select?: Record<string, unknown>; where?: Where };

/**
 * course.findMany with a select: projects course -> sections -> lessons -> progress
 * (progress rows from db.progress, filtered by lessonId and the nested where).
 * Without a select the course rows are returned as they are (sections and lessons
 * included, no progress).
 */
function projectCourse(course: FakeCourse, select: Record<string, unknown> | undefined, db: FakeDb) {
  if (!select) return structuredClone(course);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    if (k !== "sections") {
      out[k] = (course as unknown as Record<string, unknown>)[k];
      continue;
    }
    const sectionSel = (v as SelectSpec).select ?? {};
    out.sections = course.sections.map((section) => {
      const s: Record<string, unknown> = {};
      for (const [sk, sv] of Object.entries(sectionSel)) {
        if (!sv) continue;
        if (sk !== "lessons") {
          s[sk] = (section as unknown as Record<string, unknown>)[sk];
          continue;
        }
        const lessonSel = (sv as SelectSpec).select ?? {};
        s.lessons = section.lessons.map((lesson) => {
          const l: Record<string, unknown> = {};
          for (const [lk, lv] of Object.entries(lessonSel)) {
            if (!lv) continue;
            if (lk !== "progress") {
              l[lk] = (lesson as unknown as Record<string, unknown>)[lk];
              continue;
            }
            const spec = lv as SelectSpec;
            l.progress = db.progress
              .filter((p) => p.lessonId === lesson.id && matches(p as Record<string, unknown>, spec.where))
              .map((p) => (spec.select ? pick(p as Record<string, unknown>, spec.select) : { ...p }));
          }
          return l;
        });
      }
      return s;
    });
  }
  return out;
}

export type Call = { method: string; args: unknown[] };

export type FakeDb = {
  users: UserRow[];
  resets: ResetRow[];
  progress: ChildRow[];
  quizAttempts: ChildRow[];
  comments: ChildRow[];
  assignments: ChildRow[];
  notifications: ChildRow[];
  courses: FakeCourse[];
  calls: Call[];
  /** Error thrown by the next user.create (e.g. a P2002 from a concurrent invite). */
  createError: unknown;
  /** Runs once at the start of the next $transaction (simulates a change made concurrently). */
  beforeTransaction: (() => void) | undefined;
  client: Record<string, unknown>;
};

function destructiveStubs(db: FakeDb, model: string) {
  const out: Record<string, () => Promise<never>> = {};
  for (const m of DESTRUCTIVE) {
    out[m] = async () => {
      db.calls.push({ method: `${model}.${m}`, args: [] });
      throw new Error(`${model}.${m} must not be called`);
    };
  }
  return out;
}

export function createFakeDb(): FakeDb {
  const db: FakeDb = {
    users: [],
    resets: [],
    progress: [],
    quizAttempts: [],
    comments: [],
    assignments: [],
    notifications: [],
    courses: [],
    calls: [],
    createError: undefined,
    beforeTransaction: undefined,
    client: {},
  };
  const rec = (method: string, args: unknown) => db.calls.push({ method, args: [args] });

  const user = {
    ...destructiveStubs(db, "user"),
    async findUnique(args: { where: { id?: string; email?: string }; select?: Record<string, unknown> }) {
      rec("user.findUnique", args);
      const { id, email } = args.where;
      if (id === undefined && email === undefined) throw new Error("fake prisma: findUnique needs id or email");
      const row = db.users.find((u) => (id !== undefined ? u.id === id : u.email === email));
      return row ? project(row, args.select, db) : null;
    },
    async findFirst(args: { where: Where; select?: Record<string, unknown> }) {
      rec("user.findFirst", args);
      const row = db.users.find((u) => matches(u as unknown as Record<string, unknown>, args.where));
      return row ? project(row, args.select, db) : null;
    },
    async findMany(args: { where?: Where; select?: Record<string, unknown>; orderBy?: unknown }) {
      rec("user.findMany", args);
      return db.users
        .filter((u) => matches(u as unknown as Record<string, unknown>, args.where))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((u) => project(u, args.select, db));
    },
    async updateMany(args: {
      where: Where;
      data: { deactivatedAt?: Date | null; sessionVersion?: { increment: number } };
    }) {
      rec("user.updateMany", args);
      const hit = db.users.filter((u) => matches(u as unknown as Record<string, unknown>, args.where));
      for (const u of hit) {
        if ("deactivatedAt" in args.data) u.deactivatedAt = args.data.deactivatedAt ?? null;
        if (args.data.sessionVersion) u.sessionVersion += args.data.sessionVersion.increment;
      }
      return { count: hit.length };
    },
    async update(args: {
      where: { id: string };
      data: { password?: string; sessionVersion?: { increment: number } };
    }) {
      rec("user.update", args);
      const row = db.users.find((u) => u.id === args.where.id);
      if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      const { sessionVersion, ...rest } = args.data;
      Object.assign(row, rest);
      if (sessionVersion) row.sessionVersion += sessionVersion.increment;
      return { ...row };
    },
    async create(args: { data: { email: string; name: string; password: string; role: Role } }) {
      rec("user.create", args);
      if (db.createError !== undefined) {
        const e = db.createError;
        db.createError = undefined;
        throw e;
      }
      const row: UserRow = {
        id: `user_new_${db.users.length + 1}`,
        avatar: null,
        createdAt: new Date(),
        deactivatedAt: null,
        sessionVersion: 0,
        ...args.data,
      };
      db.users.push(row);
      return { ...row };
    },
  };

  const passwordReset = {
    ...destructiveStubs(db, "passwordReset"),
    async findUnique(args: { where: { token: string }; include?: { user?: { select: Record<string, boolean> } } }) {
      rec("passwordReset.findUnique", args);
      const row = db.resets.find((r) => r.token === args.where.token);
      if (!row) return null;
      const out: Record<string, unknown> = { ...row };
      if (args.include?.user) {
        const u = db.users.find((x) => x.id === row.userId);
        out.user = u ? project(u, args.include.user.select, db) : null;
      }
      return out;
    },
    async updateMany(args: { where: Where & { user?: Where }; data: { used: boolean } }) {
      rec("passwordReset.updateMany", args);
      // `user` is a relation filter (e.g. { user: { deactivatedAt: null } }).
      const { user: userWhere, ...where } = args.where;
      const hit = db.resets.filter((r) => {
        if (!matches(r as unknown as Record<string, unknown>, where)) return false;
        if (!userWhere) return true;
        const u = db.users.find((x) => x.id === r.userId);
        return !!u && matches(u as unknown as Record<string, unknown>, userWhere);
      });
      for (const r of hit) r.used = args.data.used;
      return { count: hit.length };
    },
    async update(args: { where: { token: string }; data: { used: boolean } }) {
      rec("passwordReset.update", args);
      const row = db.resets.find((r) => r.token === args.where.token);
      if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      Object.assign(row, args.data);
      return { ...row };
    },
  };

  const child = (model: string, rows: () => ChildRow[]) => ({
    ...destructiveStubs(db, model),
    async findMany(args: { where?: Where }) {
      rec(`${model}.findMany`, args);
      return rows().filter((r) => matches(r as unknown as Record<string, unknown>, args.where));
    },
  });

  const tx = {
    user,
    passwordReset,
    progress: child("progress", () => db.progress),
    quizAttempt: child("quizAttempt", () => db.quizAttempts),
    comment: child("comment", () => db.comments),
    assignment: child("assignment", () => db.assignments),
    notification: child("notification", () => db.notifications),
    course: {
      async findMany(args: { select?: Record<string, unknown>; orderBy?: unknown } | undefined) {
        rec("course.findMany", args);
        return [...db.courses].sort((a, b) => a.order - b.order).map((c) => projectCourse(c, args?.select, db));
      },
    },
    lesson: {
      async count() {
        rec("lesson.count", undefined);
        return 10;
      },
    },
  };

  db.client = {
    ...tx,
    async $transaction(arg: unknown) {
      rec("$transaction", undefined);
      const hook = db.beforeTransaction;
      db.beforeTransaction = undefined;
      hook?.();
      if (typeof arg === "function") return (arg as (t: typeof tx) => Promise<unknown>)(tx);
      return Promise.all(arg as Promise<unknown>[]);
    },
  };
  return db;
}

/** Seeds dummy rows: an active student, a deactivated student and an instructor, with child data. */
export function seed(db: FakeDb) {
  const created = new Date("2026-04-01T00:00:00.000Z");
  db.users.push(
    {
      id: "stu_active",
      email: "active-7@example.com",
      name: "B Active",
      password: "$2a$04$dummyhashdummyhashdummyhashdummyhashdummyhashdummyha",
      role: "STUDENT",
      avatar: null,
      createdAt: created,
      deactivatedAt: null,
      sessionVersion: 3,
    },
    {
      id: "stu_off",
      email: "off-7@example.com",
      name: "A Off",
      password: "$2a$04$dummyhashdummyhashdummyhashdummyhashdummyhashdummyhb",
      role: "STUDENT",
      avatar: null,
      createdAt: created,
      deactivatedAt: new Date("2026-09-01T00:00:00.000Z"),
      sessionVersion: 5,
    },
    {
      id: "ins_1",
      email: "instructor-7@example.com",
      name: "C Instructor",
      password: "$2a$04$dummyhashdummyhashdummyhashdummyhashdummyhashdummyhc",
      role: "INSTRUCTOR",
      avatar: null,
      createdAt: created,
      deactivatedAt: null,
      sessionVersion: 0,
    }
  );
  for (const userId of ["stu_active", "stu_off"]) {
    db.progress.push({
      id: `p_${userId}`,
      userId,
      completed: true,
      completedAt: new Date("2026-09-10T00:00:00.000Z"),
    });
    // Columns that the detail API must not return (answers, quizId, feedback, courseId, userId)
    // are included on purpose.
    db.quizAttempts.push({
      id: `q_${userId}`,
      userId,
      quizId: "quiz_dummy",
      score: 80,
      passed: true,
      answers: [0, 1, 2],
      createdAt: new Date("2026-09-11T00:00:00.000Z"),
      quiz: { title: "ダミー小テスト", type: "MINI" },
    });
    db.comments.push({ id: `c_${userId}`, userId });
    db.assignments.push({
      id: `a_${userId}`,
      userId,
      courseId: "course_dummy",
      title: "ダミー課題",
      status: "WORKING",
      deadline: null,
      feedback: "ダミーの講師コメント",
      createdAt: new Date("2026-09-12T00:00:00.000Z"),
      course: { name: "ダミーコース" },
    });
    db.notifications.push({ id: `n_${userId}`, userId });
  }
}

export function childCounts(db: FakeDb) {
  return {
    progress: db.progress.length,
    quizAttempts: db.quizAttempts.length,
    comments: db.comments.length,
    assignments: db.assignments.length,
    notifications: db.notifications.length,
    resets: db.resets.length,
    users: db.users.length,
  };
}

export function installFakePrisma(db: FakeDb) {
  (globalThis as unknown as { prisma: unknown }).prisma = db.client;
}

export type FakeSession = { user: { id?: string; role?: string } } | null;

/**
 * Replaces src/lib/auth.ts in the CommonJS module cache. Must run before the
 * route is imported. `getSession` is read on every call.
 */
export function installFakeAuth(getSession: () => FakeSession) {
  const authPath = path.join(process.cwd(), "src/lib/auth.ts");
  const ModuleCtor = Module as unknown as new (id: string) => {
    filename: string;
    loaded: boolean;
    exports: unknown;
  };
  const m = new ModuleCtor(authPath);
  m.filename = authPath;
  m.loaded = true;
  m.exports = {
    auth: async () => getSession(),
    handlers: {},
    signIn: async () => {
      throw new Error("signIn is not available in tests");
    },
    signOut: async () => {
      throw new Error("signOut is not available in tests");
    },
  };
  (Module as unknown as { _cache: Record<string, unknown> })._cache[authPath] = m;
}

export const INSTRUCTOR_SESSION: FakeSession = { user: { id: "ins_1", role: "INSTRUCTOR" } };
export const STUDENT_SESSION: FakeSession = { user: { id: "stu_active", role: "STUDENT" } };

export function params(id: string) {
  return { params: Promise.resolve({ id }) };
}
