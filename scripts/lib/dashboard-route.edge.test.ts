import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, INSTRUCTOR_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #32 GET /api/dashboard の追加観点（他人のデータ・直近 7 日の境界・例外時のログ・応答のキー）。
// DB・ネットワークなし。prisma は globalThis.prisma に置く偽物、NextAuth は installFakeAuth で差し替える。
// データはすべてダミー（example.com）。

type ProgressRow = { id: string; userId: string; lessonId: string; completed: boolean; completedAt: Date | null };
type NotificationRow = { id: string; userId: string; title: string; message: string; read: boolean; createdAt: Date };
type Call = { method: string; args: Record<string, unknown> };

const DAY = 24 * 3600_000;
const NOW = new Date("2026-09-29T12:00:00.000Z");
const ALICE = "stu_alice";
const BOB = "stu_bob";

const sessionOf = (id: string): FakeSession =>
  ({ user: { id, role: "STUDENT", email: `${id}@example.com`, name: `名前_${id}` } }) as unknown as FakeSession;

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
          { id: "l3", title: "レッスン3", order: 3 },
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
    sections: [{ id: "s2", order: 1, lessons: [{ id: "m1", title: "レッスンM1", order: 1 }] }],
  },
];
const lessonTitle: Record<string, string> = { l1: "レッスン1", l2: "レッスン2", l3: "レッスン3", m1: "レッスンM1" };
const lessonCourse: Record<string, string> = { l1: "STEP1", l2: "STEP1", l3: "STEP1", m1: "STEP2" };

let session: FakeSession;
let calls: Call[];
let progress: ProgressRow[];
let notifications: NotificationRow[];
let failOn: string | null;
let failError: Error;
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

function maybeFail(method: string) {
  if (failOn === method) throw failError;
}

const fakePrisma = {
  course: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "course.findMany", args });
      maybeFail("course.findMany");
      return structuredClone(COURSES);
    },
  },
  progress: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "progress.findMany", args });
      maybeFail("progress.findMany");
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
      maybeFail("notification.findMany");
      let rows = notifications.filter((r) => whereMatches(r, args.where as Record<string, unknown>));
      rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      return rows.map((r) => pick(r, args.select as Record<string, unknown> | undefined));
    },
    async count(args: Record<string, unknown>) {
      calls.push({ method: "notification.count", args });
      maybeFail("notification.count");
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
  session = sessionOf(ALICE);
  calls = [];
  failOn = null;
  failError = new Error("fake failure");
  const t = (ms: number) => new Date(NOW.getTime() - ms);
  progress = [
    // ちょうど 7 日前（含む）
    { id: "a1", userId: ALICE, lessonId: "l1", completed: true, completedAt: t(7 * DAY) },
    // 7 日と 1ms 前（含まない）
    { id: "a2", userId: ALICE, lessonId: "l2", completed: true, completedAt: t(7 * DAY + 1) },
    // Bob は最近たくさん完了している（Alice に混ざってはいけない）
    { id: "b1", userId: BOB, lessonId: "l3", completed: true, completedAt: t(60_000) },
    { id: "b2", userId: BOB, lessonId: "m1", completed: true, completedAt: t(120_000) },
  ];
  notifications = [
    { id: "na", userId: ALICE, title: "Alice宛て", message: "本文A", read: true, createdAt: t(3600_000) },
    { id: "nb1", userId: BOB, title: "Bob宛て1", message: "本文B1", read: false, createdAt: t(1000) },
    { id: "nb2", userId: BOB, title: "Bob宛て2", message: "本文B2", read: false, createdAt: t(2000) },
  ];
  for (let i = 0; i < 7; i++) {
    notifications.push({
      id: `nx${i}`,
      userId: BOB,
      title: `Bob古い${i}`,
      message: "古い本文",
      read: i % 2 === 0,
      createdAt: t((10 + i) * DAY),
    });
  }
});

async function getAt(now: Date = NOW) {
  mock.timers.enable({ apis: ["Date"], now: now.getTime() });
  try {
    return await GET();
  } finally {
    mock.timers.reset();
  }
}

const callsOf = (method: string) => calls.filter((c) => c.method === method);

describe("GET /api/dashboard：他人のデータを返さない", () => {
  it("Alice の応答に Bob の完了・お知らせが混ざらない", async () => {
    const res = await getAt();
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.completedLessons, 2);
    assert.equal(body.unreadNotifications, 0);
    assert.deepEqual(
      body.notifications.map((n: { id: string }) => n.id),
      ["na"]
    );
    assert.doesNotMatch(text, /Bob宛て|本文B|stu_bob|nb1/);
    // Bob が完了した l3・m1 は Alice の Next Up に残る
    assert.deepEqual(
      body.nextLessons.map((n: { lessonId: string }) => n.lessonId),
      ["l3"]
    );
  });

  it("Bob でログインすると Bob の分だけ（通知は新しい順に 5 件、未読件数は全件から）", async () => {
    session = sessionOf(BOB);
    const body = await (await getAt()).json();
    assert.equal(body.completedLessons, 2);
    assert.deepEqual(
      body.notifications.map((n: { id: string }) => n.id),
      ["nb1", "nb2", "nx0", "nx1", "nx2"]
    );
    // 未読：nb1, nb2, nx1, nx3, nx5
    assert.equal(body.unreadNotifications, 5);
    assert.deepEqual(
      body.recentActivity.map((a: { lessonTitle: string }) => a.lessonTitle),
      ["レッスン3", "レッスンM1"]
    );
    assert.doesNotMatch(JSON.stringify(body), /Alice|本文A/);
  });

  it("講師（INSTRUCTOR）のセッションでも自分の userId に限定する", async () => {
    session = INSTRUCTOR_SESSION;
    const body = await (await getAt()).json();
    assert.equal(body.completedLessons, 0);
    assert.deepEqual(body.notifications, []);
    for (const c of calls.filter((c) => c.method !== "course.findMany")) {
      assert.equal((c.args.where as { userId?: string }).userId, "ins_1", c.method);
    }
  });

  it("where の userId はセッションの id そのもの（クエリ等から受け取らない）", async () => {
    await getAt();
    const scoped = calls.filter((c) => c.method !== "course.findMany");
    assert.equal(scoped.length, 4);
    for (const c of scoped) assert.equal((c.args.where as { userId: unknown }).userId, ALICE);
    // コース一覧は全員共通（userId で絞らない・ユーザーに関するものを select しない）
    const [course] = callsOf("course.findMany");
    assert.equal(course.args.where, undefined);
    assert.doesNotMatch(JSON.stringify(course.args), /user|password|email/i);
  });
});

describe("GET /api/dashboard：completedLast7Days", () => {
  it("ちょうど 7 日前は含み、7 日と 1ms 前は含まない", async () => {
    const body = await (await getAt()).json();
    assert.equal(body.completedLast7Days, 1);
  });

  it("1ms 進むと、ちょうど 7 日前だった完了も外れる", async () => {
    const body = await (await getAt(new Date(NOW.getTime() + 1))).json();
    assert.equal(body.completedLast7Days, 0);
  });

  it("集計用の progress.findMany は自分の完了済みだけ・件数制限なし・必要な列だけ", async () => {
    await getAt();
    const all = callsOf("progress.findMany").filter((c) => c.args.take === undefined);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].args.where, { userId: ALICE, completed: true });
    assert.deepEqual(all[0].args.select, { lessonId: true, completed: true, completedAt: true });
  });

  it("未完了（completed=false）の行は where で除かれ、数えない", async () => {
    progress.push({ id: "a3", userId: ALICE, lessonId: "l3", completed: false, completedAt: NOW });
    const body = await (await getAt()).json();
    assert.equal(body.completedLast7Days, 1);
    assert.equal(body.completedLessons, 2);
  });
});

describe("GET /api/dashboard：通知のクエリ", () => {
  it("notifications は createdAt の新しい順に 5 件、未読件数は read=false で数える", async () => {
    await getAt();
    const [n] = callsOf("notification.findMany");
    assert.deepEqual(n.args.orderBy, { createdAt: "desc" });
    assert.equal(n.args.take, 5);
    const [cnt] = callsOf("notification.count");
    assert.deepEqual(cnt.args.where, { userId: ALICE, read: false });
  });
});

describe("GET /api/dashboard：応答に余計な情報を含めない", () => {
  it("トップレベルのキーは決まったものだけ", async () => {
    const body = await (await getAt()).json();
    assert.deepEqual(Object.keys(body).sort(), [
      "activeCourses",
      "completedLast7Days",
      "completedLessons",
      "courses",
      "nextLessons",
      "notifications",
      "overallProgress",
      "recentActivity",
      "totalLessons",
      "unreadNotifications",
    ]);
  });

  it("weeklyHours・userId・password・email・role・セッションの名前を含まない", async () => {
    const text = await (await getAt()).text();
    for (const re of [/weeklyHours/, /userId/, /password/i, /email/i, /"role"/, /@example\.com/, /名前_/, new RegExp(ALICE)]) {
      assert.doesNotMatch(text, re);
    }
  });

  it("courses の要素は集計済みの列だけ（sections やレッスン一覧を返さない）", async () => {
    const body = await (await getAt()).json();
    for (const c of body.courses) {
      assert.deepEqual(Object.keys(c).sort(), [
        "color",
        "completedLessons",
        "icon",
        "id",
        "name",
        "order",
        "progress",
        "totalLessons",
      ]);
    }
  });

  it("recentActivity の completedAt は ISO 文字列（画面の相対時刻で読める）", async () => {
    const body = await (await getAt()).json();
    for (const a of body.recentActivity) {
      assert.match(a.completedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it("活動・通知が 0 件なら空配列と 0（null にしない）", async () => {
    progress = [];
    notifications = [];
    const body = await (await getAt()).json();
    assert.deepEqual(body.recentActivity, []);
    assert.deepEqual(body.notifications, []);
    assert.equal(body.unreadNotifications, 0);
    assert.equal(body.completedLast7Days, 0);
    assert.equal(body.completedLessons, 0);
    // 何も完了していなければ最初のコースの最初から
    assert.deepEqual(
      body.nextLessons.map((n: { lessonId: string }) => n.lessonId),
      ["l1", "l2", "l3"]
    );
  });
});

describe("GET /api/dashboard：DB 例外", () => {
  for (const method of ["course.findMany", "progress.findMany", "notification.findMany", "notification.count"]) {
    it(`${method} が失敗したら 500、応答にもログにも個人情報を出さない`, async () => {
      failOn = method;
      // Prisma の例外メッセージに値が含まれた場合を想定したダミー
      failError = new Error("db down");
      const logged = mock.method(console, "error", () => {});
      const res = await getAt();
      const logs = logged.mock.calls.map((c) => c.arguments);
      logged.mock.restore();

      assert.equal(res.status, 500);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { error: "Internal server error" });
      assert.doesNotMatch(text, /db down|stack|stu_/);

      assert.ok(logs.length >= 1);
      const flat = logs
        .flat()
        .map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a)))
        .join("\n");
      // ルートはセッション情報（userId・メール・名前）をログに足さない
      assert.doesNotMatch(flat, new RegExp(ALICE));
      assert.doesNotMatch(flat, /@example\.com|名前_/);
    });
  }

  it("auth() 自体が例外を投げても 500（DB を読まない）", async () => {
    const original = session;
    const logged = mock.method(console, "error", () => {});
    // installFakeAuth の getSession から投げさせる
    session = new Proxy({} as object, {
      get() {
        throw new Error("auth broken");
      },
    }) as unknown as FakeSession;
    const res = await getAt();
    logged.mock.restore();
    session = original;
    assert.equal(res.status, 500);
    assert.equal(calls.length, 0);
  });
});
