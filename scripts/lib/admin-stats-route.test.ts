import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #32 PR B GET /api/admin/stats。DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数を記録し、このルートが使う where（role / completed / parentId）と select（入れ子の sections / lessons /
// lesson / replies / user）だけを再現する。知らない条件・項目は例外）。NextAuth は installFakeAuth で差し替える。
// 集計の細かい定義は src/lib/admin-stats.test.ts で確かめる。データはすべてダミー（example.com）。

type Call = { method: string; args: Record<string, unknown> };
type Select = Record<string, unknown>;

const users = [
  { id: "stu_a", email: "a@example.com", name: "ダミー受講生A", role: "STUDENT", deactivatedAt: null as Date | null, password: "x" },
  { id: "stu_off", email: "off@example.com", name: "ダミー受講生B", role: "STUDENT", deactivatedAt: new Date("2026-09-01T00:00:00.000Z"), password: "x" },
  { id: "ins_1", email: "ins@example.com", name: "ダミー講師", role: "INSTRUCTOR", deactivatedAt: null as Date | null, password: "x" },
];
const courses = [
  { id: "c2", name: "STEP2 ダミー", order: 2, color: "#22C55E", sections: [{ lessons: [{ id: "l3" }] }] },
  { id: "c1", name: "STEP1 ダミー", order: 1, color: "#6366F1", sections: [{ lessons: [{ id: "l1" }, { id: "l2" }] }] },
];
const progress = [
  { userId: "stu_a", lessonId: "l1", completed: true, completedAt: new Date("2026-09-10T00:00:00.000Z") },
  { userId: "stu_a", lessonId: "l2", completed: true, completedAt: new Date("2026-10-01T00:00:00.000Z") },
  { userId: "stu_a", lessonId: "l3", completed: false, completedAt: null as Date | null },
  { userId: "stu_off", lessonId: "l1", completed: true, completedAt: new Date("2026-08-10T00:00:00.000Z") },
  { userId: "ins_1", lessonId: "l3", completed: true, completedAt: new Date("2026-10-01T00:00:00.000Z") },
];
const comments = [
  { id: "q1", userId: "stu_a", lessonId: "l1", parentId: null as string | null },
  { id: "q2", userId: "stu_off", lessonId: "l1", parentId: null as string | null },
  { id: "r1", userId: "ins_1", lessonId: "l1", parentId: "q2" },
  { id: "q3", userId: "stu_a", lessonId: "l2", parentId: null as string | null },
  { id: "r2", userId: "ins_1", lessonId: "l1", parentId: "q3" }, // 別レッスンの講師の返信（回答済みにしない）
];

let session: FakeSession;
let calls: Call[];
let failWith: unknown;
let logs: string[];
let GET: () => Promise<Response>;

function only(where: unknown, allowed: string[]) {
  const keys = Object.keys((where ?? {}) as object);
  for (const k of keys) if (!allowed.includes(k)) throw new Error(`fake prisma: unsupported condition ${k}`);
}

function assertSelect(select: unknown, expected: unknown) {
  assert.deepEqual(select, expected, "select が想定と違う（受講生の名前・メールを読まないこと）");
}

const fake = {
  user: {
    async findMany(args: { where?: { role?: string }; select?: Select }) {
      calls.push({ method: "user.findMany", args });
      if (failWith) throw failWith;
      only(args.where, ["role"]);
      assertSelect(args.select, { id: true, deactivatedAt: true });
      return users.filter((u) => args.where?.role === undefined || u.role === args.where.role).map((u) => ({ id: u.id, deactivatedAt: u.deactivatedAt }));
    },
  },
  course: {
    async findMany(args: { select?: Select; orderBy?: unknown }) {
      calls.push({ method: "course.findMany", args });
      assertSelect(args.select, { id: true, name: true, color: true, sections: { select: { lessons: { select: { id: true } } } } });
      assert.deepEqual(args.orderBy, [{ order: "asc" }, { id: "asc" }]);
      return [...courses].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(({ id, name, color, sections }) => ({ id, name, color, sections }));
    },
  },
  progress: {
    async findMany(args: { where?: { completed?: boolean }; select?: Select }) {
      calls.push({ method: "progress.findMany", args });
      only(args.where, ["completed"]);
      assertSelect(args.select, { userId: true, lessonId: true, completedAt: true });
      return progress
        .filter((p) => args.where?.completed === undefined || p.completed === args.where.completed)
        .map(({ userId, lessonId, completedAt }) => ({ userId, lessonId, completedAt }));
    },
  },
  comment: {
    async findMany(args: { where?: { parentId?: null }; select?: Select }) {
      calls.push({ method: "comment.findMany", args });
      only(args.where, ["parentId"]);
      assert.equal(args.where?.parentId, null);
      assertSelect(args.select, {
        lesson: { select: { id: true } },
        replies: { select: { lessonId: true, user: { select: { role: true } } } },
      });
      return comments
        .filter((c) => c.parentId === null)
        .map((c) => ({
          lesson: { id: c.lessonId },
          replies: comments
            .filter((r) => r.parentId === c.id)
            .map((r) => ({ lessonId: r.lessonId, user: { role: users.find((u) => u.id === r.userId)!.role } })),
        }));
    },
  },
};

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fake;
  installFakeAuth(() => session);
  ({ GET } = await import("../../src/app/api/admin/stats/route"));
});

beforeEach(() => {
  session = INSTRUCTOR_SESSION;
  calls = [];
  failWith = undefined;
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    mock.method(console, level, (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });
  }
  mock.method(globalThis, "fetch", async () => {
    throw new Error("network access is not allowed in tests");
  });
});

afterEach(() => {
  mock.restoreAll();
});

describe("GET /api/admin/stats：権限", () => {
  for (const [label, s] of [
    ["未ログイン", null],
    ["受講生", STUDENT_SESSION],
    ["role なし", { user: { id: "x" } }],
  ] as Array<[string, FakeSession]>) {
    it(`${label}は 403 で、DB を読まない`, async () => {
      session = s;
      const res = await GET();
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: "Forbidden" });
      assert.deepEqual(calls, []);
    });
  }
});

describe("GET /api/admin/stats：200", () => {
  it("4 本の読み取りだけで、集計値とコース名・色を返す（受講生の名前・メール・id を含めない）", async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(calls.map((c) => c.method).sort(), ["comment.findMany", "course.findMany", "progress.findMany", "user.findMany"]);
    assert.deepEqual((calls.find((c) => c.method === "user.findMany")!.args as { where: unknown }).where, { role: "STUDENT" });
    assert.deepEqual((calls.find((c) => c.method === "progress.findMany")!.args as { where: unknown }).where, { completed: true });

    assert.deepEqual(Object.keys(body).sort(), ["cards", "distribution", "generatedAt", "monthly", "timeZone"]);
    assert.equal(body.timeZone, "Asia/Tokyo");
    assert.ok(!Number.isNaN(Date.parse(body.generatedAt)), "generatedAt が日時でない");
    // 有効な受講生は stu_a だけ。進捗 2/3 → 67%。c1 を修了。未回答は q1 と q3（q3 は別レッスンの講師の返信だけ）
    assert.deepEqual(body.cards, { activeStudents: 1, avgProgressPercent: 67, openQuestions: 2, completions: 1 });
    assert.equal(body.monthly.length, 6);
    for (const m of body.monthly) assert.deepEqual(Object.keys(m).sort(), ["activeStudents", "completions", "month"]);
    assert.deepEqual(body.distribution, [
      { courseId: "c1", name: "STEP1 ダミー", color: "#6366F1", students: 0 },
      { courseId: "c2", name: "STEP2 ダミー", color: "#22C55E", students: 1 },
      { courseId: null, name: "全コース修了", color: "#94A3B8", students: 0 },
    ]);

    const json = JSON.stringify(body);
    for (const u of users) {
      for (const v of [u.id, u.email, u.name]) assert.ok(!json.includes(v), `応答に受講生の情報（${v}）が含まれている`);
    }
  });
});

describe("GET /api/admin/stats：500", () => {
  it("DB のエラーは汎用の本文で返し、ログにはエラー名だけを出す", async () => {
    failWith = Object.assign(new Error("connection failed for a@example.com"), { name: "PrismaClientInitializationError" });
    const res = await GET();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.ok(logs.length > 0, "ログが出ていない");
    for (const l of logs) assert.ok(!l.includes("example.com") && !l.includes("connection failed"), `ログに詳細が出ている: ${l}`);
    assert.ok(logs.some((l) => l.includes("PrismaClientInitializationError")), "エラー名がログにない");
  });
});
