import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { COURSE_ORDER_BY, LESSON_ORDER_BY, SECTION_ORDER_BY } from "../../src/lib/course-order";
import { countCourseLessons, isCourseLocked, type CourseWithLessons } from "../../src/lib/course-lock";

// #47 P3 コース・セクション・レッスンの並び順を [order, id] に統一する（Tec 決定 G-a）。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数を記録する。course.findMany は orderBy を再現し、orderBy がなければ登録順のまま返す。
// 入れ子の sections / lessons も orderBy があればその順に並べる）。NextAuth は installFakeAuth で差し替える。
// データはすべてダミー。

type Call = { method: string; args: Record<string, unknown> };
type Row = Record<string, unknown>;
type LessonRow = { id: string; title: string; order: number };
type SectionRow = { id: string; title: string; order: number; lessons: LessonRow[] };
type CourseRow = { id: string; name: string; description: string | null; icon: string; color: string; order: number; sections: SectionRow[] };
type ProgressRow = { id: string; userId: string; lessonId: string; completed: boolean; completedAt: Date | null };

const ROOT = join(__dirname, "..", "..");
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
      return [];
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

function idParams<K extends string>(key: K, id: string) {
  return { params: Promise.resolve({ [key]: id } as Record<K, string>) };
}

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  const courseList = await import("../../src/app/api/courses/route");
  const courseDetail = await import("../../src/app/api/courses/[courseId]/route");
  const dashboard = await import("../../src/app/api/dashboard/route");
  const adminStats = await import("../../src/app/api/admin/stats/route");
  const adminStudents = await import("../../src/app/api/admin/students/route");
  const adminStudentDetail = await import("../../src/app/api/admin/students/[id]/route");
  const adminCourses = await import("../../src/app/api/admin/courses/route");
  const quizzes = await import("../../src/app/api/quizzes/route");
  const comments = await import("../../src/app/api/comments/route");
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
      for (const c of courseCalls) {
        if (c.method === "course.findMany") {
          assert.equal(c.args.orderBy, COURSE_ORDER_BY, `${r.file} の course.findMany が COURSE_ORDER_BY を使っていない`);
        }
        const sectionSpec = nestedSpec(c.args, "sections");
        const lessonSpec = nestedSpec(sectionSpec, "lessons");
        if (r.nested.includes("sections")) {
          assert.equal(sectionSpec?.orderBy, SECTION_ORDER_BY, `${r.file} の sections が SECTION_ORDER_BY を使っていない`);
        } else if (sectionSpec?.orderBy !== undefined) {
          assert.equal(sectionSpec.orderBy, SECTION_ORDER_BY, `${r.file} の sections の orderBy が SECTION_ORDER_BY でない`);
        }
        if (r.nested.includes("lessons")) {
          assert.equal(lessonSpec?.orderBy, LESSON_ORDER_BY, `${r.file} の lessons が LESSON_ORDER_BY を使っていない`);
        } else if (lessonSpec?.orderBy !== undefined) {
          assert.equal(lessonSpec.orderBy, LESSON_ORDER_BY, `${r.file} の lessons の orderBy が LESSON_ORDER_BY でない`);
        }
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

    // コース一覧の画面（page.tsx の CourseList と同じ式）
    const list = (await (await ROUTES[0].call()).json()) as Array<{ id: string } & CourseWithLessons>;
    const screenList = list.map((c, i) => ({
      id: c.id,
      locked: isCourseLocked(i > 0 ? countCourseLessons(list[i - 1]) : null, countCourseLessons(c)),
    }));

    // ダッシュボードのカリキュラム欄（page.tsx と同じ式。件数は API の courses をそのまま使う）
    const dash = (await (await ROUTES[2].call()).json()) as {
      courses: Array<{ id: string; completedLessons: number; totalLessons: number }>;
    };
    const screenDash = dash.courses.map((c, i) => ({ id: c.id, locked: isCourseLocked(i > 0 ? dash.courses[i - 1] : null, c) }));

    const expected = [
      { id: "c_a", locked: false },
      { id: "c_b", locked: false },
      { id: "c_c", locked: true },
    ];
    assert.deepEqual(screenList, expected);
    assert.deepEqual(screenDash, expected);

    // サーバー：質問一覧で受講生に見せるコース（unlockedCourseIds）
    calls = [];
    await ROUTES[8].call();
    const commentCall = calls.find((c) => c.method === "comment.findMany");
    assert.ok(commentCall, "comment.findMany が呼ばれていない");
    const and = (commentCall.args.where as { AND: Array<{ OR?: Array<Record<string, unknown>> }> }).AND;
    const lockFilter = and.find((w) => Array.isArray(w.OR));
    assert.ok(lockFilter, "ロックの絞り込み（OR）がない");
    const unlocked = (lockFilter.OR[1] as { lesson: { section: { courseId: { in: string[] } } } }).lesson.section.courseId.in;
    assert.deepEqual(
      unlocked,
      expected.filter((e) => !e.locked).map((e) => e.id),
      "unlockedCourseIds が画面のロック表示と一致しない"
    );

    // サーバー：確認テストの一覧のロック（buildQuizCourses。クイズがないのでコースは出ないことがある）
    const quizBody = (await (await ROUTES[7].call()).json()) as { courses: Array<{ id: string; locked: boolean }> };
    for (const c of quizBody.courses) {
      const e = expected.find((x) => x.id === c.id);
      assert.ok(e, `確認テストの一覧に知らないコース ${c.id}`);
      assert.equal(c.locked, e.locked, `確認テストの一覧の ${c.id} のロックが画面と一致しない`);
    }
  });
});

describe("並び順の書き方の取りこぼしがない（ソースの確認）", () => {
  function listTs(dir: string): string[] {
    const out: string[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) out.push(...listTs(p));
      else if (/\.tsx?$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) out.push(p);
    }
    return out;
  }

  it("src に order だけで並べる orderBy（同点を決めない書き方）がない", () => {
    const offenders = listTs(join(ROOT, "src")).filter((f) => /orderBy:\s*\{\s*order\s*:/.test(readFileSync(f, "utf8")));
    assert.deepEqual(offenders.map((f) => relative(ROOT, f)), [], "orderBy: { order: ... } が残っている");
  });

  it("API でコース・セクション・レッスンを読むルートは、すべてこのテストの対象に入っている", () => {
    const apiDir = join(ROOT, "src", "app", "api");
    const readers = listTs(apiDir)
      .filter((f) => /prisma\.(course|section|lesson)\.find(Many|First|Unique)\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(apiDir, f).split("\\").join("/"))
      .sort();
    assert.deepEqual(readers, ROUTES.map((r) => r.file).sort(), "コース等を読むルートの一覧が変わった。ROUTES に加えて並び順を確かめる");
  });
});
