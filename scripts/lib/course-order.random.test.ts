import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { countCourseLessons, isCourseLocked, type CourseWithLessons } from "../../src/lib/course-lock";
import { pickInitialLesson } from "../../src/lib/initial-lesson";
import { NEXT_LESSONS_LIMIT, pickNextLessons } from "../../src/lib/student-dashboard";

// #47 P3 同じ order のコース・セクション・レッスンを乱数で作り、各ルートの結果を照合する。
// - 偽の prisma は orderBy を再現する。orderBy がない一覧は「DB では順序の保証がない」ので毎回シャッフルして返す
//   （件数を数えるだけのクエリが並び順に依存していないことも確かめる）
// - 期待値は、このテストの中で [order, id] で並べ直した「正解」から、ルートのコードを使わずに計算する
// DB・ネットワークなし。データはすべてダミー（id は cuid に似た英小文字と数字）。

type Row = Record<string, unknown>;
type LessonRow = { id: string; title: string; order: number; type: string; sectionId: string };
type SectionRow = { id: string; title: string; order: number; courseId: string; lessons: LessonRow[] };
type CourseRow = { id: string; name: string; description: string | null; icon: string; color: string; order: number; sections: SectionRow[] };
type ProgressRow = { id: string; userId: string; lessonId: string; completed: boolean; completedAt: Date | null };
type StudentRow = { id: string; email: string; name: string; avatar: string | null; role: "STUDENT"; createdAt: Date; deactivatedAt: Date | null };

const STUDENT_ID = (STUDENT_SESSION as { user: { id: string } }).user.id;
const OTHER_STUDENTS = ["stu_r1", "stu_r2", "stu_r3"];
const ITERATIONS = 150;

// ───────────── 乱数（シード固定で再現できるようにする） ─────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rand: () => number = mulberry32(1);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
function shuffle<T>(xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
const usedIds = new Set<string>();
function cuidLike(): string {
  for (;;) {
    let s = "c";
    for (let i = 0; i < 24; i++) s += ID_CHARS[int(0, ID_CHARS.length - 1)];
    if (!usedIds.has(s)) {
      usedIds.add(s);
      return s;
    }
  }
}

// ───────────── データ ─────────────

let courses: CourseRow[] = [];
let progress: ProgressRow[] = [];
let students: StudentRow[] = [];
let session: FakeSession = STUDENT_SESSION;
type Call = { method: string; args: Row };
let calls: Call[] = [];

const byOrderThenId = (a: { order: number; id: string }, b: { order: number; id: string }) =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 正解の並び（[order, id]） */
function oracleCourses(): CourseRow[] {
  return [...courses].sort(byOrderThenId).map((c) => ({
    ...c,
    sections: [...c.sections].sort(byOrderThenId).map((s) => ({ ...s, lessons: [...s.lessons].sort(byOrderThenId) })),
  }));
}

function generate() {
  usedIds.clear();
  const nCourses = int(1, 5);
  courses = [];
  for (let ci = 0; ci < nCourses; ci++) {
    const courseId = cuidLike();
    const sections: SectionRow[] = [];
    // 0 セクション・0 レッスンのコースもときどき作る（course-lock と currentCourseOf の扱いの違いも含めて照合する）
    const nSections = int(0, 3);
    for (let si = 0; si < nSections; si++) {
      const sectionId = cuidLike();
      const lessons: LessonRow[] = [];
      const nLessons = int(0, 3);
      for (let li = 0; li < nLessons; li++) {
        lessons.push({ id: cuidLike(), title: `L${ci}-${si}-${li}`, order: int(1, 2), type: "VIDEO", sectionId });
      }
      sections.push({ id: sectionId, title: `S${ci}-${si}`, order: int(1, 2), courseId, lessons });
    }
    // order は 1〜2 なので、同じ order のコースがよくできる
    courses.push({ id: courseId, name: `ダミーコース${ci}`, description: null, icon: "it", color: "#123456", order: int(1, 2), sections });
  }
  // 登録順（DB の物理順の代わり）はばらばら
  courses = shuffle(courses).map((c) => ({ ...c, sections: shuffle(c.sections).map((s) => ({ ...s, lessons: shuffle(s.lessons) })) }));

  const ordered = oracleCourses();
  const lessonIdsInOrder = ordered.map((c) => c.sections.flatMap((s) => s.lessons.map((l) => l.id)));
  progress = [];
  students = [STUDENT_ID, ...OTHER_STUDENTS].map((id, i) => ({
    id,
    email: `${id}@example.com`,
    name: `ダミー受講生${i}`,
    avatar: null,
    role: "STUDENT" as const,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    deactivatedAt: null,
  }));
  let n = 0;
  for (const s of students) {
    const done = new Set<string>();
    if (rand() < 0.6) {
      // 正解の順で先頭から k コースを終え、次のコースの一部を終える（ロックの境目を作る）
      const k = int(0, ordered.length);
      for (let i = 0; i < k; i++) lessonIdsInOrder[i].forEach((id) => done.add(id));
      if (k < ordered.length) lessonIdsInOrder[k].forEach((id) => rand() < 0.5 && done.add(id));
    } else {
      lessonIdsInOrder.flat().forEach((id) => rand() < 0.35 && done.add(id));
    }
    for (const lessonId of Array.from(done)) {
      progress.push({ id: `p${n++}`, userId: s.id, lessonId, completed: true, completedAt: new Date("2026-10-01T00:00:00.000Z") });
    }
  }
}

// ───────────── 偽の prisma ─────────────

function sortRows<R extends Row>(rows: R[], orderBy: unknown): R[] {
  if (orderBy === undefined) return shuffle(rows); // 順序の保証なし
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

function spec(args: Row | undefined, key: string): Row | undefined {
  const holder = (args?.include ?? args?.select) as Row | undefined;
  const v = holder?.[key];
  return v && typeof v === "object" ? (v as Row) : v === true ? {} : undefined;
}

function shapeLesson(l: LessonRow, args: Row | undefined): Row {
  const out: Row = { ...l };
  const p = spec(args, "progress");
  if (p) {
    const where = (p.where ?? {}) as { userId?: string; completed?: boolean };
    out.progress = progress
      .filter((r) => r.lessonId === l.id && (where.userId === undefined || r.userId === where.userId) && (where.completed === undefined || r.completed === where.completed))
      .map((r) => ({ completedAt: r.completedAt }));
  }
  return out;
}

function shapeCourse(c: CourseRow, args: Row | undefined): Row {
  const sSpec = spec(args, "sections");
  const lSpec = spec(sSpec, "lessons");
  const sections = sortRows(c.sections as unknown as Row[], sSpec?.orderBy).map((s) => {
    const sec = s as unknown as SectionRow;
    return {
      ...sec,
      lessons: sortRows(sec.lessons as unknown as Row[], lSpec?.orderBy).map((l) => shapeLesson(l as unknown as LessonRow, lSpec)),
      _count: { lessons: sec.lessons.length },
    };
  });
  return { ...c, sections, _count: { sections: c.sections.length } };
}

function record(method: string, args: unknown) {
  calls.push({ method, args: (args ?? {}) as Row });
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
      if ((args.select as Row | undefined)?.lesson) return []; // ダッシュボードの最近の学習は使わない
      return shuffle(progress.filter((p) => p.completed && (args.where?.userId === undefined || p.userId === args.where.userId)));
    },
  },
  user: {
    async findMany(args: Row & { where?: { role?: string; deactivatedAt?: unknown } }) {
      record("user.findMany", args);
      const rows = students.filter((s) => args.where?.role === undefined || s.role === args.where.role);
      return sortRows(rows as unknown as Row[], args.orderBy).map((s) => ({
        ...s,
        progress: progress.filter((p) => p.userId === s.id && p.completed).map((p) => ({ completedAt: p.completedAt, lessonId: p.lessonId })),
      }));
    },
    async findFirst(args: Row & { where: { id: string } }) {
      record("user.findFirst", args);
      return students.find((s) => s.id === args.where.id) ?? null;
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
      // どのコースも一覧に出るように、各コースに受験できる修了テストを 1 件ずつ置く
      return shuffle(
        courses.map((c) => ({
          id: `q_${c.id}`,
          title: "修了テスト",
          type: "FINAL",
          courseId: c.id,
          lessonId: null,
          lesson: null,
          questions: [{ options: ["ダミーA", "ダミーB"], correctIndex: 0 }],
        }))
      );
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

// ───────────── ルート ─────────────

type Routes = {
  courseList: () => Promise<Response>;
  courseDetail: (id: string) => Promise<Response>;
  dashboard: () => Promise<Response>;
  quizzes: () => Promise<Response>;
  comments: () => Promise<Response>;
  adminCourses: () => Promise<Response>;
  adminStats: () => Promise<Response>;
  adminStudents: () => Promise<Response>;
  adminStudentDetail: (id: string) => Promise<Response>;
};
let R: Routes;

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  const courseList = await import("../../src/app/api/courses/route");
  const courseDetail = await import("../../src/app/api/courses/[courseId]/route");
  const dashboard = await import("../../src/app/api/dashboard/route");
  const quizzes = await import("../../src/app/api/quizzes/route");
  const comments = await import("../../src/app/api/comments/route");
  const adminCourses = await import("../../src/app/api/admin/courses/route");
  const adminStats = await import("../../src/app/api/admin/stats/route");
  const adminStudents = await import("../../src/app/api/admin/students/route");
  const adminStudentDetail = await import("../../src/app/api/admin/students/[id]/route");
  R = {
    courseList: () => courseList.GET(),
    courseDetail: (id) =>
      courseDetail.GET(new Request(`http://localhost/api/courses/${id}`), { params: Promise.resolve({ courseId: id }) }),
    dashboard: () => dashboard.GET(),
    quizzes: () => quizzes.GET(),
    comments: () => comments.GET(new Request("http://localhost/api/comments")),
    adminCourses: () => adminCourses.GET(),
    adminStats: () => adminStats.GET(),
    adminStudents: () => adminStudents.GET(new Request("http://localhost/api/admin/students")),
    adminStudentDetail: (id) =>
      adminStudentDetail.GET(new Request(`http://localhost/api/admin/students/${id}`), { params: Promise.resolve({ id }) }),
  };
});

async function json<T>(res: Promise<Response>, label: string): Promise<T> {
  const r = await res;
  assert.equal(r.status, 200, `${label} が 200 を返さない（status ${r.status}）`);
  return (await r.json()) as T;
}

// ───────────── 正解（ルートのコードを使わずに計算する） ─────────────

function completedOf(userId: string): Set<string> {
  return new Set(progress.filter((p) => p.userId === userId && p.completed).map((p) => p.lessonId));
}

function oracleLocks(ordered: CourseRow[], done: Set<string>): boolean[] {
  const counts = ordered.map((c) => {
    const ids = c.sections.flatMap((s) => s.lessons.map((l) => l.id));
    return { total: ids.length, done: ids.filter((id) => done.has(id)).length };
  });
  // 前のコースを全部終えておらず（前が 0 件も含む）、このコースが未着手ならロック。先頭はロックしない
  return counts.map((c, i) => i > 0 && !(counts[i - 1].total > 0 && counts[i - 1].done >= counts[i - 1].total) && c.done === 0);
}

/** 並び順で、レッスンがあって未完了のレッスンを含む最初のコース（currentCourseOf の定義） */
function oracleCurrentCourse(ordered: CourseRow[], done: Set<string>): string | null {
  for (const c of ordered) {
    const ids = c.sections.flatMap((s) => s.lessons.map((l) => l.id));
    if (ids.length > 0 && ids.some((id) => !done.has(id))) return c.id;
  }
  return null;
}

/** locks を渡すと、ロック中のコースを選ばない（#78 PR A。/api/dashboard の Next Up） */
function oracleNextLessons(ordered: CourseRow[], done: Set<string>, locks: boolean[] = []): string[] {
  const c = ordered
    .map((course, i) => {
      const ids = course.sections.flatMap((s) => s.lessons.map((l) => l.id));
      return { course, ids, done: ids.filter((id) => done.has(id)).length, locked: locks[i] === true };
    })
    .filter((x) => !x.locked);
  const active =
    c.find((x) => x.done > 0 && x.done < x.ids.length) ?? c.find((x) => x.done < x.ids.length) ?? c[0];
  if (!active) return [];
  return active.ids.filter((id) => !done.has(id)).slice(0, NEXT_LESSONS_LIMIT);
}

type ApiLesson = { id: string; completed: boolean };
type ApiCourse = { id: string; sections: Array<{ id: string; lessons: ApiLesson[] }> } & CourseWithLessons;

const tree = (cs: Array<{ id: string; sections: Array<{ id: string; lessons: Array<{ id: string }> }> }>) =>
  cs.map((c) => ({ id: c.id, sections: c.sections.map((s) => ({ id: s.id, lessons: s.lessons.map((l) => l.id) })) }));

describe("乱数データ（同じ order のコース・セクション・レッスンが多い）で、全ルートの並び・ロック・次のレッスンが一致する", () => {
  it(`${ITERATIONS} 通りのデータで照合する`, async () => {
    // ロックを考えない Next Up とずれた（ロック中のコースを飛ばした）回数。照合が空振りしていないことの確認に使う
    let nextUpSkippedLocked = 0;
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      rand = mulberry32(seed);
      generate();
      const ordered = oracleCourses();
      const expectedIds = ordered.map((c) => c.id);
      const me = completedOf(STUDENT_ID);
      const expectedLocks = oracleLocks(ordered, me);
      const ctx = `seed ${seed}`;

      // ── 受講生の画面 ──
      session = STUDENT_SESSION;
      const list = await json<ApiCourse[]>(R.courseList(), `${ctx} /api/courses`);
      assert.deepEqual(tree(list), tree(ordered), `${ctx}: /api/courses の並び（コース・セクション・レッスン）が [order, id] でない`);
      // コース一覧（page.tsx の CourseList と同じ式）
      const listLocks = list.map((c, i) => isCourseLocked(i > 0 ? countCourseLessons(list[i - 1]) : null, countCourseLessons(c)));
      assert.deepEqual(listLocks, expectedLocks, `${ctx}: コース一覧のロック表示が正解と違う`);

      // /api/courses の locked（#47 P4）も正解と一致する
      assert.deepEqual(
        (list as Array<{ locked?: unknown }>).map((c) => c.locked),
        expectedLocks,
        `${ctx}: /api/courses の locked が正解と違う`
      );

      for (let i = 0; i < ordered.length; i++) {
        const c = ordered[i];
        if (expectedLocks[i]) {
          // ロック中のコースの詳細は 403 course_locked（#47 P4）
          const res = await R.courseDetail(c.id);
          assert.equal(res.status, 403, `${ctx}: ロック中の /api/courses/${c.id} が 403 でない`);
          assert.deepEqual(await res.json(), { error: "Forbidden", reason: "course_locked" }, `${ctx}: 403 の本文が違う`);
          continue;
        }
        const detail = await json<ApiCourse>(R.courseDetail(c.id), `${ctx} /api/courses/${c.id}`);
        assert.deepEqual(tree([detail]), tree([c]), `${ctx}: /api/courses/[courseId] の並びが一覧と違う`);
      }

      const dash = await json<{
        courses: Array<{ id: string; completedLessons: number; totalLessons: number; locked?: unknown }>;
        nextLessons: Array<{ lessonId: string; courseId: string }>;
      }>(R.dashboard(), `${ctx} /api/dashboard`);
      assert.deepEqual(dash.courses.map((c) => c.id), expectedIds, `${ctx}: ダッシュボードのコースの並びが違う`);
      // /api/dashboard の locked（#78 PR A。画面のカリキュラム欄はこれを表示するだけ）
      assert.deepEqual(dash.courses.map((c) => c.locked), expectedLocks, `${ctx}: /api/dashboard の locked が正解と違う`);
      assert.deepEqual(
        dash.nextLessons.map((l) => l.lessonId),
        oracleNextLessons(ordered, me, expectedLocks),
        `${ctx}: 次のレッスン（Next Up）が正解と違う`
      );
      if (JSON.stringify(dash.nextLessons.map((l) => l.lessonId)) !== JSON.stringify(oracleNextLessons(ordered, me))) nextUpSkippedLocked++;

      // Next Up はロック中のコースを指さない（#78 PR A）。先頭は、そのコースを開いたときに最初に表示されるレッスン
      // （LessonView の pickInitialLesson）と同じ
      for (const l of dash.nextLessons) {
        assert.equal(expectedLocks[expectedIds.indexOf(l.courseId)], false, `${ctx}: Next Up がロック中のコース ${l.courseId} を指している`);
      }
      if (dash.nextLessons.length > 0) {
        const first = dash.nextLessons[0];
        const detail = await json<ApiCourse>(R.courseDetail(first.courseId), `${ctx} /api/courses/${first.courseId}`);
        const initial = pickInitialLesson<ApiLesson>(detail.sections, (l) => l.completed === true);
        assert.equal(initial?.id, first.lessonId, `${ctx}: Next Up の先頭と、コースを開いたときの最初のレッスンが違う`);
      }

      // ── サーバーの判定 ──
      const quiz = await json<{ courses: Array<{ id: string; locked: boolean }> }>(R.quizzes(), `${ctx} /api/quizzes`);
      assert.deepEqual(
        quiz.courses.map((c) => [c.id, c.locked]),
        ordered.map((c, i) => [c.id, expectedLocks[i]]),
        `${ctx}: 確認テストの一覧の並び・ロックが正解と違う`
      );

      calls = [];
      await json<unknown>(R.comments(), `${ctx} /api/comments`);
      const commentCall = calls.find((c) => c.method === "comment.findMany");
      assert.ok(commentCall, `${ctx}: comment.findMany が呼ばれていない`);
      const and = (commentCall.args.where as { AND: Array<{ OR?: Array<Record<string, unknown>> }> }).AND;
      const lockFilter = and.find((w) => Array.isArray(w.OR));
      assert.ok(lockFilter, `${ctx}: 質問一覧にロックの絞り込みがない`);
      const courseFilter = lockFilter.OR.find(
        (w) => Array.isArray((w as { lesson?: { section?: { courseId?: { in?: unknown } } } }).lesson?.section?.courseId?.in)
      ) as { lesson: { section: { courseId: { in: string[] } } } } | undefined;
      assert.ok(courseFilter, `${ctx}: 質問一覧のロックの絞り込みに lesson.section.courseId.in がない`);
      const unlocked = courseFilter.lesson.section.courseId.in;
      assert.deepEqual(unlocked, expectedIds.filter((_, i) => !expectedLocks[i]), `${ctx}: 質問一覧の解放済みコースが画面のロック表示と違う`);

      // ── 管理画面 ──
      session = INSTRUCTOR_SESSION;
      const adminCourses = await json<Array<{ id: string; sections: Array<{ id: string }> }>>(R.adminCourses(), `${ctx} /api/admin/courses`);
      assert.deepEqual(
        adminCourses.map((c) => ({ id: c.id, sections: c.sections.map((s) => s.id) })),
        ordered.map((c) => ({ id: c.id, sections: c.sections.map((s) => s.id) })),
        `${ctx}: 管理画面のコース・セクションの並びが違う`
      );

      const expectedCurrent = new Map(students.map((s) => [s.id, oracleCurrentCourse(ordered, completedOf(s.id))]));
      const adminList = await json<Array<{ id: string; currentCourse: { id: string } | null }>>(R.adminStudents(), `${ctx} /api/admin/students`);
      for (const s of adminList) {
        assert.equal(s.currentCourse?.id ?? null, expectedCurrent.get(s.id), `${ctx}: 生徒管理の一覧の ${s.id} の現在のコースが違う`);
      }
      const detail = await json<{ currentCourse: { id: string } | null; courseProgress?: Array<{ courseId: string }> }>(
        R.adminStudentDetail(STUDENT_ID),
        `${ctx} /api/admin/students/[id]`
      );
      assert.equal(detail.currentCourse?.id ?? null, expectedCurrent.get(STUDENT_ID), `${ctx}: 受講生詳細の現在のコースが違う`);

      const stats = await json<{ distribution: Array<{ courseId: string | null; students: number }> }>(R.adminStats(), `${ctx} /api/admin/stats`);
      const nonEmpty = ordered.filter((c) => c.sections.some((s) => s.lessons.length > 0)).map((c) => c.id);
      assert.deepEqual(stats.distribution.map((d) => d.courseId), [...nonEmpty, null], `${ctx}: Distribution の並びが違う`);
      for (const d of stats.distribution) {
        const n = Array.from(expectedCurrent.values()).filter((v) => v === d.courseId).length;
        assert.equal(d.students, n, `${ctx}: Distribution の ${d.courseId ?? "全コース修了"} の人数が、生徒管理の現在のコースと違う`);
      }
    }
    assert.ok(nextUpSkippedLocked > 0, "Next Up がロック中のコースを飛ばす場面を照合できていない");
  });
});

describe("pickNextLessons は、受け取ったセクション・レッスンの並びに依存せず [order, id] で選ぶ", () => {
  it(`${ITERATIONS} 通りのデータで、セクション・レッスンをシャッフルして渡しても正解と同じ`, () => {
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      rand = mulberry32(seed);
      generate();
      const ordered = oracleCourses();
      // コースの並びは route が決める（[order, id]）。セクション・レッスンだけをばらばらにして渡す
      const input = ordered.map((c) => ({ ...c, sections: shuffle(c.sections).map((sec) => ({ ...sec, lessons: shuffle(sec.lessons) })) }));
      for (const s of students) {
        const done = completedOf(s.id);
        assert.deepEqual(
          pickNextLessons(input, done).map((l) => l.lessonId),
          oracleNextLessons(ordered, done),
          `seed ${seed} ${s.id}: 次のレッスンが [order, id] の正解と違う`
        );
      }
    }
  });
});

describe("乱数データの作り方の確認（照合が空振りしていない）", () => {
  it("同じ order のコース・セクション・レッスン、登録順と [order, id] の順が違うデータ、ロック中のコースが実際に作られる", () => {
    let tiedCourses = 0;
    let tiedLessons = 0;
    let reordered = 0;
    let locked = 0;
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      rand = mulberry32(seed);
      generate();
      const ordered = oracleCourses();
      const orders = courses.map((c) => c.order);
      if (new Set(orders).size < orders.length) tiedCourses++;
      if (ordered.some((c) => c.sections.some((s) => new Set(s.lessons.map((l) => l.order)).size < s.lessons.length))) tiedLessons++;
      if (courses.map((c) => c.id).join() !== ordered.map((c) => c.id).join()) reordered++;
      if (oracleLocks(ordered, completedOf(STUDENT_ID)).some(Boolean)) locked++;
    }
    assert.ok(tiedCourses > ITERATIONS / 4, `同じ order のコースが少ない（${tiedCourses}）`);
    assert.ok(tiedLessons > ITERATIONS / 4, `同じ order のレッスンが少ない（${tiedLessons}）`);
    assert.ok(reordered > ITERATIONS / 4, `登録順と [order, id] の順が違うデータが少ない（${reordered}）`);
    assert.ok(locked > ITERATIONS / 10, `ロック中のコースがあるデータが少ない（${locked}）`);
  });
});
