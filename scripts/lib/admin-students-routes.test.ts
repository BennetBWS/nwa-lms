import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_STUDENT_DETAIL_KEYS } from "../../src/lib/admin-student-detail";
import {
  INSTRUCTOR_SESSION,
  STUDENT_SESSION,
  childCounts,
  createFakeDb,
  installFakeAuth,
  installFakePrisma,
  params,
  seed,
  type FakeDb,
  type FakeSession,
} from "./student-routes.test-helpers";

// #7: admin student APIs (deactivate / reactivate / list / detail / invite) with
// soft deactivation. No DB (in-memory fake on globalThis.prisma), no NextAuth
// (auth stub in the module cache), no network. All data are dummies.

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let session: FakeSession;
let db: FakeDb;
let deactivate: Handler;
let reactivate: Handler;
let detail: Handler;
let list: (req: Request) => Promise<Response>;
let invite: (req: Request) => Promise<Response>;
let logs: { level: string; text: string }[];

const put = () => new Request("http://localhost/api/admin/students/x", { method: "PUT" });
const get = (qs = "") => new Request(`http://localhost/api/admin/students${qs}`);
const inviteReq = (body: unknown) =>
  new Request("http://localhost/api/admin/students/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const DESTRUCTIVE_RE = /\.(delete|deleteMany)$/;

before(async () => {
  db = createFakeDb();
  installFakePrisma(db);
  installFakeAuth(() => session);
  ({ PUT: deactivate } = await import("../../src/app/api/admin/students/[id]/deactivate/route"));
  ({ PUT: reactivate } = await import("../../src/app/api/admin/students/[id]/reactivate/route"));
  ({ GET: detail } = await import("../../src/app/api/admin/students/[id]/route"));
  ({ GET: list } = await import("../../src/app/api/admin/students/route"));
  ({ POST: invite } = await import("../../src/app/api/admin/students/invite/route"));
});

beforeEach(() => {
  // Reset the shared fake in place (the routes hold a reference to db.client).
  for (const k of ["users", "resets", "progress", "quizAttempts", "comments", "assignments", "notifications", "courses", "calls"] as const) {
    db[k].length = 0;
  }
  db.createError = undefined;
  seed(db);
  db.resets.push(
    { id: "r1", userId: "stu_active", token: "tok-active-unused", expiresAt: new Date(Date.now() + 3600_000), used: false },
    { id: "r2", userId: "stu_active", token: "tok-active-used", expiresAt: new Date(Date.now() + 3600_000), used: true },
    { id: "r3", userId: "ins_1", token: "tok-ins-unused", expiresAt: new Date(Date.now() + 3600_000), used: false }
  );
  session = INSTRUCTOR_SESSION;
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    mock.method(console, level, (...args: unknown[]) => {
      logs.push({ level, text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
    });
  }
  mock.method(globalThis, "fetch", async () => {
    throw new Error("network access is not allowed in tests");
  });
});

afterEach(() => {
  mock.restoreAll();
});

const user = (id: string) => db.users.find((u) => u.id === id)!;

describe("authorization (all admin student APIs)", () => {
  for (const [label, s] of [
    ["unauthenticated", null],
    ["student session", STUDENT_SESSION],
    ["session without role", { user: { id: "x" } }],
  ] as const) {
    it(`${label}: 403 and the DB is not touched`, async () => {
      session = s as FakeSession;
      const responses = [
        await deactivate(put(), params("stu_active")),
        await reactivate(put(), params("stu_off")),
        await detail(get(), params("stu_active")),
        await list(get()),
        await invite(inviteReq({ email: "new-7@example.com", name: "New" })),
      ];
      for (const res of responses) {
        assert.equal(res.status, 403);
        assert.deepEqual(await res.json(), { error: "Forbidden" });
      }
      assert.deepEqual(db.calls, [], "no DB access before the role check");
      assert.equal(user("stu_active").deactivatedAt, null);
      assert.notEqual(user("stu_off").deactivatedAt, null);
    });
  }
});

describe("PUT /api/admin/students/[id]/deactivate", () => {
  it("soft-deactivates: 200 with status, keeps all related data, calls no delete", async () => {
    const before = childCounts(db);
    const res = await deactivate(put(), params("stu_active"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, "stu_active");
    assert.equal(body.status, "deactivated");
    assert.match(body.deactivatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(Object.keys(body).sort(), ["deactivatedAt", "id", "status"]);

    assert.deepEqual(childCounts(db), before, "no row is removed");
    assert.ok(!db.calls.some((c) => DESTRUCTIVE_RE.test(c.method)), JSON.stringify(db.calls.map((c) => c.method)));
    assert.equal(user("stu_active").sessionVersion, 4);
    // Unused tokens of this student are invalidated; others untouched.
    assert.equal(db.resets.find((r) => r.id === "r1")!.used, true);
    assert.equal(db.resets.find((r) => r.id === "r3")!.used, false);
    // Fixed log text only.
    assert.deepEqual(logs, [{ level: "info", text: "[admin] student deactivated" }]);
  });

  it("second deactivation: 200, same deactivatedAt, sessionVersion not bumped, no log", async () => {
    const first = await (await deactivate(put(), params("stu_active"))).json();
    logs.length = 0;
    await new Promise((r) => setTimeout(r, 5));
    const second = await (await deactivate(put(), params("stu_active"))).json();
    assert.deepEqual(second, first);
    assert.equal(user("stu_active").sessionVersion, 4);
    assert.deepEqual(logs, []);
  });

  it("deactivate -> reactivate -> deactivate: sessionVersion +1 per deactivation, data kept", async () => {
    const before = childCounts(db);
    await deactivate(put(), params("stu_active"));
    assert.equal(user("stu_active").sessionVersion, 4);
    const r = await reactivate(put(), params("stu_active"));
    assert.deepEqual(await r.json(), { id: "stu_active", status: "active", deactivatedAt: null });
    assert.equal(user("stu_active").sessionVersion, 4, "reactivation does not bump");
    await deactivate(put(), params("stu_active"));
    await deactivate(put(), params("stu_active"));
    assert.equal(user("stu_active").sessionVersion, 5);
    assert.deepEqual(childCounts(db), before);
    assert.ok(!db.calls.some((c) => DESTRUCTIVE_RE.test(c.method)));
  });

  it("instructor id: 404 (same body as an unknown id), nothing changed", async () => {
    const ins = await deactivate(put(), params("ins_1"));
    const unknown = await deactivate(put(), params("does-not-exist"));
    assert.equal(ins.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(await ins.text(), await unknown.text());
    assert.equal(user("ins_1").deactivatedAt, null);
    assert.equal(user("ins_1").sessionVersion, 0);
    assert.equal(db.resets.find((r) => r.id === "r3")!.used, false);
    assert.deepEqual(logs, []);
  });

  it("DB error: 500 with a generic body; the error message is not logged", async () => {
    const userModel = db.client.user as { findUnique: unknown };
    const original = userModel.findUnique;
    userModel.findUnique = async () => {
      throw Object.assign(new Error("boom off-7@example.com"), { code: "P1001" });
    };
    try {
      const res = await deactivate(put(), params("stu_active"));
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.ok(!logs.some((l) => l.text.includes("off-7@example.com")), JSON.stringify(logs));
    } finally {
      userModel.findUnique = original;
    }
  });
});

describe("PUT /api/admin/students/[id]/reactivate", () => {
  it("clears deactivatedAt only (sessionVersion, password, tokens unchanged)", async () => {
    const pw = user("stu_off").password;
    const res = await reactivate(put(), params("stu_off"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: "stu_off", status: "active", deactivatedAt: null });
    assert.equal(user("stu_off").deactivatedAt, null);
    assert.equal(user("stu_off").sessionVersion, 5);
    assert.equal(user("stu_off").password, pw);
    assert.ok(!db.calls.some((c) => c.method.startsWith("passwordReset.")));
    assert.deepEqual(logs, [{ level: "info", text: "[admin] student reactivated" }]);
  });

  it("already active: 200, idempotent, no log", async () => {
    const res = await reactivate(put(), params("stu_active"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: "stu_active", status: "active", deactivatedAt: null });
    assert.deepEqual(logs, []);
  });

  it("instructor id / unknown id: 404", async () => {
    for (const id of ["ins_1", "does-not-exist"]) {
      const res = await reactivate(put(), params(id));
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "Student not found" });
    }
    assert.ok(!db.calls.some((c) => c.method === "user.updateMany"));
  });
});

describe("GET /api/admin/students (list)", () => {
  const EXPECTED_KEYS = [
    "avatar",
    "completedLessons",
    "createdAt",
    "currentCourse",
    "deactivatedAt",
    "email",
    "id",
    "lastActive",
    "name",
    "status",
    "totalLessons",
  ];

  it("no status: active students only; existing fields kept, status/deactivatedAt added", async () => {
    const res = await list(get());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.map((s: { id: string }) => s.id), ["stu_active"]);
    const s = body[0];
    assert.deepEqual(Object.keys(s).sort(), EXPECTED_KEYS);
    assert.equal(s.status, "active");
    assert.equal(s.deactivatedAt, null);
    // Fields used by AdminDashboard (src/app/page.tsx): id, name, totalLessons, completedLessons, lastActive.
    assert.equal(s.name, "B Active");
    assert.equal(s.totalLessons, 10);
    assert.equal(s.completedLessons, 1);
    assert.equal(s.lastActive, "2026-09-10T00:00:00.000Z");
    // No course in the fake DB: null (shown as "—" because there is no lesson to finish).
    assert.equal(s.currentCourse, null);
    assert.ok(!("password" in s) && !("sessionVersion" in s) && !("role" in s));
  });

  it("status=active is the same as no status", async () => {
    assert.equal(await (await list(get("?status=active"))).text(), await (await list(get())).text());
  });

  it("status=deactivated: deactivated students only, ISO deactivatedAt", async () => {
    const body = await (await list(get("?status=deactivated"))).json();
    assert.equal(body.length, 1);
    assert.equal(body[0].id, "stu_off");
    assert.equal(body[0].status, "deactivated");
    assert.equal(body[0].deactivatedAt, "2026-09-01T00:00:00.000Z");
    assert.deepEqual(Object.keys(body[0]).sort(), EXPECTED_KEYS);
  });

  it("status=all: all students (never instructors), ordered by name", async () => {
    const body = await (await list(get("?status=all"))).json();
    assert.deepEqual(body.map((s: { id: string; status: string }) => [s.id, s.status]), [
      ["stu_off", "deactivated"],
      ["stu_active", "active"],
    ]);
  });

  for (const qs of ["?status=", "?status=ACTIVE", "?status=inactive", "?status=all%20", "?status=deleted"]) {
    it(`invalid ${qs}: 400 and no student query`, async () => {
      const res = await list(get(qs));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "status must be one of: active, deactivated, all" });
      assert.ok(!db.calls.some((c) => c.method === "user.findMany"));
    });
  }

  it("a student deactivated via the API disappears from the default list and appears in deactivated", async () => {
    await deactivate(put(), params("stu_active"));
    assert.deepEqual(await (await list(get())).json(), []);
    const off = await (await list(get("?status=deactivated"))).json();
    assert.deepEqual(off.map((s: { id: string }) => s.id).sort(), ["stu_active", "stu_off"]);
  });
});

describe("GET /api/admin/students/[id] (detail)", () => {
  it("deactivated student: 200 with status and ISO deactivatedAt; related data still returned", async () => {
    const res = await detail(get(), params("stu_off"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, "stu_off");
    assert.equal(body.email, "off-7@example.com");
    assert.equal(body.status, "deactivated");
    assert.equal(body.deactivatedAt, "2026-09-01T00:00:00.000Z");
    assert.deepEqual(body.quizAttempts.map((q: { id: string }) => q.id), ["q_stu_off"]);
    assert.deepEqual(body.assignments.map((a: { id: string }) => a.id), ["a_stu_off"]);
    for (const k of ["id", "email", "name", "createdAt", "courseProgress", "quizAttempts", "assignments"]) {
      assert.ok(k in body, `${k} is kept`);
    }
    assert.ok(!("password" in body) && !("sessionVersion" in body), "password / sessionVersion are not returned");
  });

  it("active student: status active, deactivatedAt null", async () => {
    const body = await (await detail(get(), params("stu_active"))).json();
    assert.equal(body.status, "active");
    assert.equal(body.deactivatedAt, null);
  });

  it("instructor id / unknown id: 404 with the same body; no related data queried", async () => {
    const ins = await detail(get(), params("ins_1"));
    const unknown = await detail(get(), params("does-not-exist"));
    assert.equal(ins.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(await ins.text(), await unknown.text());
    assert.ok(!db.calls.some((c) => /^(course|quizAttempt|assignment)\./.test(c.method)));
  });
});

describe("POST /api/admin/students/invite", () => {
  it("new email: 201 (unchanged behavior)", async () => {
    const res = await invite(inviteReq({ email: "new-7@example.com", name: "New Student" }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.email, "new-7@example.com");
    assert.equal(typeof body.password, "string");
    assert.equal(db.users.at(-1)!.role, "STUDENT");
  });

  it("active student email: 409 EXISTS without userId; no user created", async () => {
    const res = await invite(inviteReq({ email: "active-7@example.com", name: "X" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "EXISTS");
    assert.ok(!("userId" in body));
    assert.ok(!("password" in body));
    assert.ok(!db.calls.some((c) => c.method === "user.create"));
  });

  it("deactivated student email: 409 DEACTIVATED with userId; no user created, still deactivated", async () => {
    const res = await invite(inviteReq({ email: "off-7@example.com", name: "X" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "DEACTIVATED");
    assert.equal(body.userId, "stu_off");
    assert.ok(!("password" in body));
    assert.ok(!db.calls.some((c) => c.method === "user.create" || c.method === "user.updateMany"));
    assert.notEqual(user("stu_off").deactivatedAt, null);
  });

  it("instructor email: 409 EXISTS without userId (the instructor id is not revealed)", async () => {
    const res = await invite(inviteReq({ email: "instructor-7@example.com", name: "X" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "EXISTS");
    assert.ok(!("userId" in body));
    assert.ok(!JSON.stringify(body).includes("ins_1"));
  });

  it("P2002 from create (concurrent invite): 409 EXISTS, not 500, nothing logged", async () => {
    db.createError = Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), {
      code: "P2002",
    });
    const res = await invite(inviteReq({ email: "race-7@example.com", name: "X" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "EXISTS");
    assert.ok(!("userId" in body));
    assert.deepEqual(logs, []);
  });

  it("other DB error from create: 500 (not 409)", async () => {
    db.createError = Object.assign(new Error("connection lost"), { code: "P1001" });
    const res = await invite(inviteReq({ email: "err-7@example.com", name: "X" }));
    assert.equal(res.status, 500);
  });
});

// ---- #32: currentCourse in the list, whitelisted detail ----

/** Two courses (STEP1: l1, l2 / STEP2: l3) plus an empty one between them; dummies only. */
function seedCourses() {
  db.courses.push(
    {
      id: "c2",
      name: "STEP2 ダミー",
      order: 3,
      color: "#EF4444",
      description: "説明（返さない）",
      sections: [{ id: "s2", title: "セクション", lessons: [{ id: "l3", title: "L3" }] }],
    },
    {
      id: "c1",
      name: "STEP1 ダミー",
      order: 1,
      color: "#6366F1",
      description: "説明（返さない）",
      sections: [
        { id: "s1a", title: "セクションA", lessons: [{ id: "l1", title: "L1" }] },
        { id: "s1b", title: "セクションB", lessons: [{ id: "l2", title: "L2" }] },
      ],
    },
    { id: "c_empty", name: "空のコース", order: 2, color: "#000000", description: null, sections: [] }
  );
  // Replace the seeded progress (no lessonId) with progress on real lessons.
  db.progress.length = 0;
  db.progress.push(
    // stu_active: finished STEP1 -> current course is STEP2 (the empty course is skipped)
    { id: "pa1", userId: "stu_active", lessonId: "l1", completed: true, completedAt: new Date("2026-09-01T00:00:00.000Z") },
    { id: "pa2", userId: "stu_active", lessonId: "l2", completed: true, completedAt: new Date("2026-09-04T00:00:00.000Z") },
    // stu_off: started STEP1 only; an incomplete row does not count
    { id: "po1", userId: "stu_off", lessonId: "l1", completed: true, completedAt: new Date("2026-08-01T00:00:00.000Z") },
    { id: "po2", userId: "stu_off", lessonId: "l2", completed: false, completedAt: null }
  );
}

describe("GET /api/admin/students (list): currentCourse (#32)", () => {
  it("first course (by order) not finished; { id, name } only", async () => {
    seedCourses();
    const body = await (await list(get("?status=all"))).json();
    const byId = Object.fromEntries(body.map((s: { id: string; currentCourse: unknown }) => [s.id, s.currentCourse]));
    assert.deepEqual(byId, {
      stu_active: { id: "c2", name: "STEP2 ダミー" },
      stu_off: { id: "c1", name: "STEP1 ダミー" },
    });
  });

  it("all courses finished: null", async () => {
    seedCourses();
    db.progress.push({ id: "pa3", userId: "stu_active", lessonId: "l3", completed: true, completedAt: new Date("2026-09-08T00:00:00.000Z") });
    const body = await (await list(get())).json();
    assert.equal(body[0].id, "stu_active");
    assert.equal(body[0].currentCourse, null);
  });

  it("reads courses once, in order, with lesson ids only (no user data)", async () => {
    seedCourses();
    await list(get("?status=all"));
    const calls = db.calls.filter((c) => c.method === "course.findMany");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args[0], {
      select: { id: true, name: true, sections: { select: { lessons: { select: { id: true } } } } },
      orderBy: { order: "asc" },
    });
    const users = db.calls.find((c) => c.method === "user.findMany");
    assert.ok(users, "user.findMany was not called");
    const progressSelect = (users.args[0] as { select: { progress: unknown } }).select.progress;
    assert.deepEqual(progressSelect, {
      where: { completed: true },
      select: { completedAt: true, lessonId: true },
      orderBy: { completedAt: "desc" },
    });
  });

  it("existing fields are unchanged by the course data", async () => {
    seedCourses();
    const body = await (await list(get())).json();
    assert.equal(body[0].completedLessons, 2);
    assert.equal(body[0].lastActive, "2026-09-04T00:00:00.000Z");
  });
});

describe("GET /api/admin/students/[id] (detail): whitelist (#32)", () => {
  /** every key in a JSON value */
  function allKeys(v: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(v)) for (const x of v) allKeys(x, out);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        out.add(k);
        allKeys(x, out);
      }
    }
    return out;
  }

  it("top-level keys match the whitelist exactly", async () => {
    seedCourses();
    const body = await (await detail(get(), params("stu_active"))).json();
    assert.deepEqual(Object.keys(body).sort(), [...ADMIN_STUDENT_DETAIL_KEYS]);
  });

  it("no answers / userId / quizId / feedback / avatar / password / sessionVersion anywhere (the fake returns them)", async () => {
    seedCourses();
    const res = await detail(get(), params("stu_active"));
    assert.equal(res.status, 200);
    const text = await res.text();
    const keys = allKeys(JSON.parse(text));
    for (const k of ["answers", "userId", "quizId", "feedback", "avatar", "password", "sessionVersion", "role", "description", "color"]) {
      assert.ok(!keys.has(k), `${k} is in the detail response`);
    }
    for (const s of ["ダミーの講師コメント", "$2a$04$", "quiz_dummy", "説明（返さない）"]) {
      assert.ok(!text.includes(s), `${s} is in the detail response`);
    }
  });

  it("quiz attempts and assignments: allowed fields only", async () => {
    const body = await (await detail(get(), params("stu_active"))).json();
    assert.deepEqual(body.quizAttempts, [
      { id: "q_stu_active", quizTitle: "ダミー小テスト", quizType: "MINI", score: 80, passed: true, createdAt: "2026-09-11T00:00:00.000Z" },
    ]);
    assert.deepEqual(body.assignments, [
      { id: "a_stu_active", title: "ダミー課題", courseName: "ダミーコース", status: "WORKING", deadline: null, createdAt: "2026-09-12T00:00:00.000Z" },
    ]);
  });

  it("courseProgress per course (in order) with lastCompletedAt, and currentCourse", async () => {
    seedCourses();
    const body = await (await detail(get(), params("stu_off"))).json();
    assert.deepEqual(body.courseProgress, [
      { courseId: "c1", courseName: "STEP1 ダミー", totalLessons: 2, completedLessons: 1, lastCompletedAt: "2026-08-01T00:00:00.000Z" },
      { courseId: "c_empty", courseName: "空のコース", totalLessons: 0, completedLessons: 0, lastCompletedAt: null },
      { courseId: "c2", courseName: "STEP2 ダミー", totalLessons: 1, completedLessons: 0, lastCompletedAt: null },
    ]);
    assert.deepEqual(body.currentCourse, { id: "c1", name: "STEP1 ダミー" });
    const active = await (await detail(get(), params("stu_active"))).json();
    assert.deepEqual(active.currentCourse, { id: "c2", name: "STEP2 ダミー" });
  });

  it("queries select only allowed columns; progress is scoped to this student", async () => {
    await detail(get(), params("stu_active"));
    const of = (m: string) => db.calls.find((c) => c.method === m)?.args[0] as Record<string, unknown> | undefined;
    const userArgs = of("user.findFirst");
    assert.ok(userArgs, "user.findFirst was not called");
    assert.deepEqual(userArgs.select, { id: true, email: true, name: true, createdAt: true, deactivatedAt: true });
    const quizArgs = of("quizAttempt.findMany");
    assert.ok(quizArgs, "quizAttempt.findMany was not called");
    assert.ok(!("include" in quizArgs), "quizAttempt uses include");
    assert.ok(!("answers" in (quizArgs.select as object)), "quizAttempt selects answers");
    const assignArgs = of("assignment.findMany");
    assert.ok(assignArgs, "assignment.findMany was not called");
    assert.ok(!("include" in assignArgs), "assignment uses include");
    assert.ok(!("feedback" in (assignArgs.select as object)), "assignment selects feedback");
    const courseArgs = of("course.findMany");
    assert.ok(courseArgs, "course.findMany was not called");
    assert.match(JSON.stringify(courseArgs), /"where":\{"userId":"stu_active","completed":true\}/);
  });

  it("DB error: 500 with a generic body", async () => {
    const quizModel = db.client.quizAttempt as { findMany: unknown };
    const original = quizModel.findMany;
    quizModel.findMany = async () => {
      throw new Error("boom active-7@example.com");
    };
    try {
      const res = await detail(get(), params("stu_active"));
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
    } finally {
      quizModel.findMany = original;
    }
  });
});
