import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #32 GET /api/dashboard。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数を記録し、where の userId・completedAt・orderBy・select を最低限だけ再現する）。
// NextAuth は installFakeAuth で差し替える。データはすべてダミー。

type ProgressRow = { id: string; userId: string; lessonId: string; completed: boolean; completedAt: Date | null };
type NotificationRow = { id: string; userId: string; title: string; message: string; read: boolean; createdAt: Date };
type Call = { method: string; args: Record<string, unknown> };

const DAY = 24 * 3600_000;
const USER = "stu_active";
const OTHER = "stu_other";

const lessonTitle: Record<string, string> = {
  l1: "レッスン1",
  l2: "レッスン2",
  l3: "レッスン3",
  l4: "レッスン4",
  m1: "レッスンM1",
};
const lessonCourse: Record<string, string> = { l1: "STEP1", l2: "STEP1", l3: "STEP1", l4: "STEP1", m1: "STEP2" };

const COURSES = [
  {
    id: "c1",
    name: "STEP1",
    icon: "it",
    color: "#111111",
    order: 1,
    sections: [
      {
        id: "s1",
        order: 1,
        lessons: [
          { id: "l1", title: "レッスン1", order: 1 },
          { id: "l2", title: "レッスン2", order: 2 },
        ],
      },
      {
        id: "s2",
        order: 2,
        lessons: [
          { id: "l3", title: "レッスン3", order: 1 },
          { id: "l4", title: "レッスン4", order: 2 },
        ],
      },
    ],
  },
  {
    id: "c2",
    name: "STEP2",
    icon: "html",
    color: "#222222",
    order: 2,
    sections: [{ id: "s3", order: 1, lessons: [{ id: "m1", title: "レッスンM1", order: 1 }] }],
  },
];

let session: FakeSession;
let calls: Call[];
let progress: ProgressRow[];
let notifications: NotificationRow[];
let failNext: boolean;
let GET: () => Promise<Response>;

function whereMatches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("not" in c && c.not === null) return row[k] !== null && row[k] !== undefined;
      throw new Error(`fake prisma: unsupported condition ${k}`);
    }
    return row[k] === cond;
  });
}

function pick(row: Record<string, unknown>, select: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) if (v === true) out[k] = row[k];
  return out;
}

const fakePrisma = {
  course: {
    async findMany(args: Record<string, unknown>) {
      if (failNext) throw new Error("fake failure");
      calls.push({ method: "course.findMany", args });
      return structuredClone(COURSES);
    },
  },
  progress: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "progress.findMany", args });
      let rows = progress.filter((r) => whereMatches(r, args.where as Record<string, unknown>));
      if (Array.isArray(args.orderBy)) {
        rows = [...rows].sort(
          (a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0) || (a.id < b.id ? 1 : -1)
        );
      }
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      const select = args.select as Record<string, unknown>;
      return rows.map((r) => {
        const out = pick(r, select);
        if (select.lesson) {
          out.lesson = { title: lessonTitle[r.lessonId], section: { course: { name: lessonCourse[r.lessonId] } } };
        }
        return out;
      });
    },
  },
  notification: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "notification.findMany", args });
      return notifications
        .filter((r) => whereMatches(r, args.where as Record<string, unknown>))
        .map((r) => pick(r, args.select as Record<string, unknown> | undefined));
    },
    async count(args: Record<string, unknown>) {
      calls.push({ method: "notification.count", args });
      return notifications.filter((r) => whereMatches(r, args.where as Record<string, unknown>)).length;
    },
  },
};

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ GET } = await import("../../src/app/api/dashboard/route"));
});

beforeEach(() => {
  session = STUDENT_SESSION;
  calls = [];
  failNext = false;
  const now = Date.now();
  progress = [
    { id: "p1", userId: USER, lessonId: "l1", completed: true, completedAt: new Date(now - 10 * DAY) },
    { id: "p2", userId: USER, lessonId: "l3", completed: true, completedAt: new Date(now - 1 * DAY) },
    // 完了済みだが completedAt が NULL（先頭に来てはいけない）
    { id: "p3", userId: USER, lessonId: "l2", completed: true, completedAt: null },
    { id: "p4", userId: USER, lessonId: "l4", completed: false, completedAt: null },
    { id: "p9", userId: OTHER, lessonId: "m1", completed: true, completedAt: new Date(now - 60_000) },
  ];
  notifications = [
    { id: "n1", userId: USER, title: "お知らせ1", message: "本文1", read: false, createdAt: new Date(now - 3600_000) },
    { id: "n2", userId: USER, title: "お知らせ2", message: "本文2", read: true, createdAt: new Date(now - 2 * DAY) },
    { id: "n9", userId: OTHER, title: "他人宛て", message: "他人の本文", read: false, createdAt: new Date(now) },
  ];
});

const callsOf = (method: string) => calls.filter((c) => c.method === method);

describe("GET /api/dashboard：認証", () => {
  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    const res = await GET();
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  it("user.id のないセッションも 401", async () => {
    session = { user: { role: "STUDENT" } };
    const res = await GET();
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
});

describe("GET /api/dashboard：レスポンス", () => {
  it("weeklyHours と userId を返さない", async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.ok(!("weeklyHours" in body));
    assert.doesNotMatch(text, /weeklyHours/);
    assert.doesNotMatch(text, /userId/);
    assert.doesNotMatch(text, new RegExp(USER));
  });

  it("集計・直近 7 日・Next Up を返す", async () => {
    const body = await (await GET()).json();
    assert.equal(body.completedLessons, 3);
    assert.equal(body.totalLessons, 5);
    assert.equal(body.activeCourses, 1);
    assert.equal(body.overallProgress, 60);
    // 10 日前・completedAt NULL は数えない
    assert.equal(body.completedLast7Days, 1);
    assert.deepEqual(
      body.courses.map((c: { id: string; progress: number }) => [c.id, c.progress]),
      [
        ["c1", 75],
        ["c2", 0],
      ]
    );
    assert.deepEqual(body.nextLessons, [{ lessonId: "l4", title: "レッスン4", courseId: "c1", courseName: "STEP1" }]);
  });

  it("recentActivity は completedAt の新しい順で、NULL の行は含まない", async () => {
    const body = await (await GET()).json();
    assert.deepEqual(
      body.recentActivity.map((a: { lessonTitle: string }) => a.lessonTitle),
      ["レッスン3", "レッスン1"]
    );
    assert.deepEqual(Object.keys(body.recentActivity[0]).sort(), ["completedAt", "courseName", "lessonTitle"]);
  });

  it("notifications は id / title / message / read / createdAt だけ", async () => {
    const body = await (await GET()).json();
    assert.equal(body.notifications.length, 2);
    for (const n of body.notifications) {
      assert.deepEqual(Object.keys(n).sort(), ["createdAt", "id", "message", "read", "title"]);
    }
    assert.equal(body.unreadNotifications, 1);
  });

  it("読み込みに失敗したら 500（0 で埋めた集計を返さない）", async () => {
    failNext = true;
    const logged = mock.method(console, "error", () => {});
    const res = await GET();
    logged.mock.restore();
    assert.equal(logged.mock.callCount(), 1);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ["error"]);
  });
});

describe("GET /api/dashboard：クエリの指定", () => {
  it("progress・notification の where はすべて自分の userId に限定", async () => {
    await GET();
    const scoped = [...callsOf("progress.findMany"), ...callsOf("notification.findMany"), ...callsOf("notification.count")];
    assert.equal(scoped.length, 4);
    for (const c of scoped) {
      assert.equal((c.args.where as { userId?: string }).userId, USER, c.method);
    }
  });

  it("recentActivity は completedAt が NULL でない行を新しい順に 5 件", async () => {
    await GET();
    const activity = callsOf("progress.findMany").find((c) => c.args.take !== undefined);
    assert.ok(activity);
    assert.deepEqual(activity.args.where, { userId: USER, completed: true, completedAt: { not: null } });
    assert.deepEqual(activity.args.orderBy, [{ completedAt: "desc" }, { id: "desc" }]);
    assert.equal(activity.args.take, 5);
  });

  it("notifications は select で userId を外している", async () => {
    await GET();
    const [n] = callsOf("notification.findMany");
    assert.deepEqual(n.args.select, { id: true, title: true, message: true, read: true, createdAt: true });
  });

  it("sections と lessons を order → id の順で並べ、lessons は title も読む", async () => {
    await GET();
    const [c] = callsOf("course.findMany");
    const select = c.args.select as {
      sections: { orderBy: unknown; select: { lessons: { orderBy: unknown; select: Record<string, boolean> } } };
    };
    assert.deepEqual(c.args.orderBy, { order: "asc" });
    assert.deepEqual(select.sections.orderBy, [{ order: "asc" }, { id: "asc" }]);
    assert.deepEqual(select.sections.select.lessons.orderBy, [{ order: "asc" }, { id: "asc" }]);
    assert.deepEqual(select.sections.select.lessons.select, { id: true, title: true, order: true });
  });
});
