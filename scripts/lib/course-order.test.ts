import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { COURSE_ORDER_BY, LESSON_ORDER_BY, SECTION_ORDER_BY } from "../../src/lib/course-order";

// #47 P3 コース・セクション・レッスンの並び順を [order, id] に統一する（Tec 決定 G-a）。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数を記録する。course.findMany は orderBy を再現し、orderBy がなければ登録順のまま返す。
// 入れ子の sections / lessons も orderBy があればその順に並べる）。NextAuth は installFakeAuth で差し替える。
// データはすべてダミー。
// ソースを読む確認（orderBy の書き方・コース等を読む箇所の一覧）は course-order.static.test.ts にまとめている。

type Call = { method: string; args: Record<string, unknown> };
type Row = Record<string, unknown>;
type LessonRow = { id: string; title: string; order: number };
type SectionRow = { id: string; title: string; order: number; lessons: LessonRow[] };
type CourseRow = { id: string; name: string; description: string | null; icon: string; color: string; order: number; sections: SectionRow[] };
type ProgressRow = { id: string; userId: string; lessonId: string; completed: boolean; completedAt: Date | null };

const STUDENT_ID = (STUDENT_SESSION as { user: { id: string } }).user.id;

let session: FakeSession;
let calls: Call[];
let courses: CourseRow[];
let progress: ProgressRow[];

function sortRows<R extends Row>(rows: R[], orderBy: unknown): R[] {
  if (orderBy === undefined) return [...rows]; // orderBy なしは登録順（DB では順序の保証なし）
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const entries = Object.entries(k);
      if (entries.length !== 1) throw new Error("fake prisma: orderBy の要素は 1 キーだけ");
      const [field, dir] = entries[0];
      const av = a[field] as string | number;
      const bv = b[field] as string | number;
      if (av === bv) continue;
      const cmp = av < bv ? -1 : 1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

/** include / select の入れ子の sections・lessons の orderBy を再現する（項目は絞らずに返す） */
function nestedSpec(args: Row | undefined, key: string): Row | undefined {
  const holder = (args?.include ?? args?.select) as Row | undefined;
  const v = holder?.[key];
  return v && typeof v === "object" ? (v as Row) : undefined;
}

function shapeCourse(c: CourseRow, args: Row | undefined): Row {
  const sectionSpec = nestedSpec(args, "sections");
  const lessonSpec = nestedSpec(sectionSpec, "lessons");
  const sections = sortRows(c.sections as unknown as Row[], sectionSpec?.orderBy).map((s) => ({
    ...s,
    lessons: sortRows((s as unknown as SectionRow).lessons as unknown as Row[], lessonSpec?.orderBy).map((l) => ({
      ...l,
      // 管理画面の受講生詳細（detailCourseSelect）が読む、レッスンごとの完了行。このテストでは空
      progress: [],
    })),
    _count: { lessons: (s as unknown as SectionRow).lessons.length },
  }));
  return { ...c, sections, _count: { sections: c.sections.length } };
}

function record(method: string, args: unknown) {
  calls.push({ method, args: (args ?? {}) as Record<string, unknown> });
}

const fakePrisma = {
  course: {
    async findMany(args: Row) {
      record("course.findMany", args);
      return sortRows(courses as unknown as Row[], args?.orderBy).map((c) => shapeCourse(c as unknown as CourseRow, args));
    },
    async findUnique(args: Row & { where: { id: string } }) {
      record("course.findUnique", args);
      const c = courses.find((x) => x.id === args.where.id);
      return c ? shapeCourse(c, args) : null;
    },
  },
  progress: {
    async findMany(args: Row & { where?: { userId?: string } }) {
      record("progress.findMany", args);
      // 最近の学習（select.lesson あり）はこのテストでは使わない
      if ((args.select as Row | undefined)?.lesson) return [];
      return progress.filter((p) => p.completed && (args.where?.userId === undefined || p.userId === args.where.userId));
    },
  },
  user: {
    async findMany(args: Row) {
      record("user.findMany", args);
      return [];
    },
    async findFirst(args: Row & { where: { id: string } }) {
      record("user.findFirst", args);
      return { id: args.where.id, email: "stu@example.com", name: "ダミー受講生", createdAt: new Date("2026-09-01T00:00:00.000Z"), deactivatedAt: null };
    },
  },
  lesson: {
    async count(args: Row) {
      record("lesson.count", args);
      return courses.reduce((n, c) => n + c.sections.reduce((m, s) => m + s.lessons.length, 0), 0);
    },
  },
  comment: {
    async findMany(args: Row) {
      record("comment.findMany", args);
      return [];
    },
  },
  notification: {
    async findMany(args: Row) {
      record("notification.findMany", args);
      return [];
    },
    async count(args: Row) {
      record("notification.count", args);
      return 0;
    },
  },
  quiz: {
    async findMany(args: Row) {
      record("quiz.findMany", args);
      // 確認テストの一覧にどのコースも出るように、各コースに受験できる修了テストを 1 件ずつ置く（ダミー）
      return courses.map((c) => ({
        id: `q_${c.id}`,
        title: "修了テスト",
        type: "FINAL",
        courseId: c.id,
        lessonId: null,
        lesson: null,
        questions: [{ options: ["ダミーA", "ダミーB"], correctIndex: 0 }],
        // クイズ管理の一覧（#81 Q1）が読む受験記録の件数
        _count: { attempts: 0 },
      }));
    },
  },
  quizAttempt: {
    async findMany(args: Row) {
      record("quizAttempt.findMany", args);
      return [];
    },
  },
  assignment: {
    async findMany(args: Row) {
      record("assignment.findMany", args);
      return [];
    },
  },
};

type RouteCase = {
  /** src/app/api からの相対パス */
  file: string;
  session: FakeSession;
  call: () => Promise<Response>;
  /** 入れ子で並べる（orderBy が必要な）もの */
  nested: Array<"sections" | "lessons">;
};

let ROUTES: RouteCase[];

/** ロックの判定だけに使う読み方（lesson-access の loadCourseLocks。レッスンの id を数えるだけで、並びは COURSE_ORDER_BY だけが効く） */
const LOCK_SELECT = { id: true, sections: { select: { lessons: { select: { id: true } } } } };
function isLockOnlyRead(args: Row): boolean {
  return args.include === undefined && JSON.stringify(args.select) === JSON.stringify(LOCK_SELECT);
}
let courseDetail: typeof import("../../src/app/api/courses/[courseId]/route");

function idParams<K extends string>(key: K, id: string) {
  return { params: Promise.resolve({ [key]: id } as Record<K, string>) };
}

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  const courseList = await import("../../src/app/api/courses/route");
  courseDetail = await import("../../src/app/api/courses/[courseId]/route");
  const dashboard = await import("../../src/app/api/dashboard/route");
  const adminStats = await import("../../src/app/api/admin/stats/route");
  const adminStudents = await import("../../src/app/api/admin/students/route");
  const adminStudentDetail = await import("../../src/app/api/admin/students/[id]/route");
  const adminCourses = await import("../../src/app/api/admin/courses/route");
  const quizzes = await import("../../src/app/api/quizzes/route");
  const comments = await import("../../src/app/api/comments/route");
  const adminQuizzes = await import("../../src/app/api/admin/quizzes/route");
  ROUTES = [
    { file: "courses/route.ts", session: STUDENT_SESSION, call: () => courseList.GET(), nested: ["sections", "lessons"] },
    {
      file: "courses/[courseId]/route.ts",
      session: STUDENT_SESSION,
      call: () => courseDetail.GET(new Request("http://localhost/api/courses/c_a"), idParams("courseId", "c_a")),
      nested: ["sections", "lessons"],
    },
    { file: "dashboard/route.ts", session: STUDENT_SESSION, call: () => dashboard.GET(), nested: ["sections", "lessons"] },
    { file: "admin/stats/route.ts", session: INSTRUCTOR_SESSION, call: () => adminStats.GET(), nested: [] },
    {
      file: "admin/students/route.ts",
      session: INSTRUCTOR_SESSION,
      call: () => adminStudents.GET(new Request("http://localhost/api/admin/students")),
      nested: [],
    },
    {
      file: "admin/students/[id]/route.ts",
      session: INSTRUCTOR_SESSION,
      call: () => adminStudentDetail.GET(new Request("http://localhost/api/admin/students/stu_x"), idParams("id", "stu_x")),
      nested: [],
    },
    { file: "admin/courses/route.ts", session: INSTRUCTOR_SESSION, call: () => adminCourses.GET(), nested: ["sections"] },
    { file: "quizzes/route.ts", session: STUDENT_SESSION, call: () => quizzes.GET(), nested: [] },
    {
      file: "comments/route.ts",
      session: STUDENT_SESSION,
      call: () => comments.GET(new Request("http://localhost/api/comments")),
      nested: [],
    },
    // 末尾に足す（ROUTES[0]・[2]・[7]・[8] を位置で参照するテストがあるため）
    { file: "admin/quizzes/route.ts", session: INSTRUCTOR_SESSION, call: () => adminQuizzes.GET(), nested: [] },
  ];
});

// 同じ order の 2 コース（c_b を先に登録）と、その次のコース。
// [order, id] なら c_a → c_b → c_c。c_a だけ全部終えた受講生には c_c がロック（c_b が未完了）。
// 登録順（c_b → c_a → c_c）で並べると c_c の前が c_a になり、c_c が解放済みに見えてしまう。
function seedTiedCourses() {
  courses = [
    {
      id: "c_b",
      name: "STEP1 ダミーB",
      description: null,
      icon: "it",
      color: "#111111",
      order: 1,
      sections: [{ id: "s_b", title: "B", order: 1, lessons: [{ id: "lb1", title: "B1", order: 1 }] }],
    },
    {
      id: "c_a",
      name: "STEP1 ダミーA",
      description: null,
      icon: "it",
      color: "#222222",
      order: 1,
      sections: [
        // 同じ order のセクション・レッスンも登録順と id 順を逆にしておく
        { id: "s_a2", title: "A2", order: 1, lessons: [{ id: "la3", title: "A3", order: 1 }, { id: "la2", title: "A2", order: 1 }] },
        { id: "s_a1", title: "A1", order: 1, lessons: [{ id: "la1", title: "A1", order: 1 }] },
      ],
    },
    {
      id: "c_c",
      name: "STEP2 ダミーC",
      description: null,
      icon: "html",
      color: "#333333",
      order: 2,
      sections: [{ id: "s_c", title: "C", order: 1, lessons: [{ id: "lc1", title: "C1", order: 1 }] }],
    },
  ];
  progress = ["la1", "la2", "la3"].map((lessonId, i) => ({
    id: `p${i}`,
    userId: STUDENT_ID,
    lessonId,
    completed: true,
    completedAt: new Date("2026-10-01T00:00:00.000Z"),
  }));
}

beforeEach(() => {
  calls = [];
  seedTiedCourses();
});

describe("course-order の定数", () => {
  it("コース・セクション・レッスンとも [order asc, id asc]", () => {
    const expected = [{ order: "asc" }, { id: "asc" }];
    assert.deepEqual(COURSE_ORDER_BY, expected);
    assert.deepEqual(SECTION_ORDER_BY, expected);
    assert.deepEqual(LESSON_ORDER_BY, expected);
  });
});

describe("各ルートが共通の定数で並べる", () => {
  it("コースを読むルートは、course.findMany の orderBy に COURSE_ORDER_BY（同じ参照）を渡す", async () => {
    for (const r of ROUTES) {
      calls = [];
      session = r.session;
      const res = await r.call();
      assert.equal(res.status, 200, `${r.file} が 200 を返さない（status ${res.status}）`);
      const courseCalls = calls.filter((c) => c.method === "course.findMany" || c.method === "course.findUnique");
      assert.ok(courseCalls.length > 0, `${r.file} がコースを読んでいない`);
      // 入れ子の並びが要るのは、画面に出すコースを読む呼び出し。
      // ロックの判定（lesson-access の courseAccessFor。#47 P4）はレッスンの id を数えるだけ（LOCK_SELECT）なので、入れ子の orderBy を求めない
      const contentCalls = courseCalls.filter((c) => !isLockOnlyRead(c.args));
      for (const c of courseCalls) {
        if (c.method === "course.findMany") {
          assert.equal(c.args.orderBy, COURSE_ORDER_BY, `${r.file} の course.findMany が COURSE_ORDER_BY を使っていない`);
        }
        const sectionSpec = nestedSpec(c.args, "sections");
        const lessonSpec = nestedSpec(sectionSpec, "lessons");
        const needsNested = contentCalls.includes(c);
        if (needsNested && r.nested.includes("sections")) {
          assert.equal(sectionSpec?.orderBy, SECTION_ORDER_BY, `${r.file} の sections が SECTION_ORDER_BY を使っていない`);
        } else if (sectionSpec?.orderBy !== undefined) {
          assert.equal(sectionSpec.orderBy, SECTION_ORDER_BY, `${r.file} の sections の orderBy が SECTION_ORDER_BY でない`);
        }
        if (needsNested && r.nested.includes("lessons")) {
          assert.equal(lessonSpec?.orderBy, LESSON_ORDER_BY, `${r.file} の lessons が LESSON_ORDER_BY を使っていない`);
        } else if (lessonSpec?.orderBy !== undefined) {
          assert.equal(lessonSpec.orderBy, LESSON_ORDER_BY, `${r.file} の lessons の orderBy が LESSON_ORDER_BY でない`);
        }
      }
      if (r.nested.length > 0) {
        assert.ok(contentCalls.length > 0, `${r.file} がロックの判定以外でコースを読んでいない（入れ子の並びを確かめられない）`);
      }
    }
  });

  it("/api/courses と /api/courses/[courseId] は、同じ order のセクション・レッスンを id 順で返す", async () => {
    session = STUDENT_SESSION;
    const list = (await (await ROUTES[0].call()).json()) as Array<{ id: string; sections: Array<{ id: string; lessons: Array<{ id: string }> }> }>;
    assert.deepEqual(list.map((c) => c.id), ["c_a", "c_b", "c_c"]);
    const a = list.find((c) => c.id === "c_a");
    assert.ok(a, "c_a が一覧にない");
    assert.deepEqual(a.sections.map((s) => s.id), ["s_a1", "s_a2"]);
    assert.deepEqual(a.sections[1].lessons.map((l) => l.id), ["la2", "la3"]);

    const detail = (await (await ROUTES[1].call()).json()) as { sections: Array<{ id: string; lessons: Array<{ id: string }> }> };
    assert.deepEqual(detail.sections.map((s) => s.id), ["s_a1", "s_a2"]);
    assert.deepEqual(detail.sections[1].lessons.map((l) => l.id), ["la2", "la3"]);
  });
});

describe("同じ order の 2 コースで、画面のロック表示とサーバーの判定が一致する", () => {
  it("/api/courses・/api/dashboard から画面と同じ式で計算したロックと、/api/comments・/api/quizzes の判定が一致する", async () => {
    session = STUDENT_SESSION;

    // コース一覧の画面（page.tsx の CourseList は /api/courses の locked を表示するだけ。#78 PR A）
    const list = (await (await ROUTES[0].call()).json()) as Array<{ id: string; locked?: unknown }>;
    const screenList = list.map((c) => ({ id: c.id, locked: c.locked }));

    // ダッシュボードのカリキュラム欄（page.tsx は /api/dashboard の locked を表示するだけ。#78 PR A）
    const dash = (await (await ROUTES[2].call()).json()) as {
      courses: Array<{ id: string; locked?: unknown }>;
    };
    const screenDash = dash.courses.map((c) => ({ id: c.id, locked: c.locked }));

    const expected = [
      { id: "c_a", locked: false },
      { id: "c_b", locked: false },
      { id: "c_c", locked: true },
    ];
    assert.deepEqual(screenList, expected);
    assert.deepEqual(screenDash, expected);

    // サーバー：/api/courses/[courseId]（#47 P4）は、画面がロック表示するコースだけ 403
    for (const e of expected) {
      const res = await courseDetail.GET(new Request(`http://localhost/api/courses/${e.id}`), idParams("courseId", e.id));
      assert.equal(res.status, e.locked ? 403 : 200, `/api/courses/${e.id} の status が画面のロック表示と一致しない`);
    }

    // サーバー：質問一覧で受講生に見せるコース（unlockedCourseIds）
    calls = [];
    await ROUTES[8].call();
    const commentCall = calls.find((c) => c.method === "comment.findMany");
    assert.ok(commentCall, "comment.findMany が呼ばれていない");
    const and = (commentCall.args.where as { AND: Array<{ OR?: Array<Record<string, unknown>> }> }).AND;
    const lockFilter = and.find((w) => Array.isArray(w.OR));
    assert.ok(lockFilter, "ロックの絞り込み（OR）がない");
    const courseFilter = lockFilter.OR.find(
      (w) => Array.isArray((w as { lesson?: { section?: { courseId?: { in?: unknown } } } }).lesson?.section?.courseId?.in)
    ) as { lesson: { section: { courseId: { in: string[] } } } } | undefined;
    assert.ok(courseFilter, "ロックの絞り込み（OR）に lesson.section.courseId.in がない");
    const unlocked = courseFilter.lesson.section.courseId.in;
    assert.deepEqual(
      unlocked,
      expected.filter((e) => !e.locked).map((e) => e.id),
      "質問一覧の解放済みコースが画面のロック表示と一致しない"
    );

    // サーバー：確認テストの一覧のロック（buildQuizCourses。偽 prisma は各コースに修了テストを 1 件置く）
    const quizBody = (await (await ROUTES[7].call()).json()) as { courses: Array<{ id: string; locked: boolean }> };
    assert.ok(quizBody.courses.length > 0, "確認テストの一覧にコースが出ていない（ロックの照合が空振りする）");
    assert.deepEqual(
      quizBody.courses.map((c) => ({ id: c.id, locked: c.locked })),
      expected,
      "確認テストの一覧の並び・ロックが画面と一致しない"
    );
  });
});

describe("クイズ管理の一覧（#81 Q1）も [order, id] のコース順", () => {
  it("同じ order の 2 コースの修了テストを、c_a → c_b → c_c の順に返す（登録順の c_b → c_a ではない）", async () => {
    session = INSTRUCTOR_SESSION;
    const route = ROUTES.find((r) => r.file === "admin/quizzes/route.ts");
    assert.ok(route, "ROUTES に admin/quizzes/route.ts がない");
    const res = await route.call();
    assert.equal(res.status, 200, "クイズ管理の一覧が 200 を返さない");
    const body = (await res.json()) as { quizzes: Array<{ courseId: string | null }> };
    assert.deepEqual(body.quizzes.map((q) => q.courseId), ["c_a", "c_b", "c_c"], "クイズ管理の一覧のコースの並びが [order, id] でない");
  });
});
