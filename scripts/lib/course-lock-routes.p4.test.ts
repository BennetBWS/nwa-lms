import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { isCourseLocked, type LessonCounts } from "../../src/lib/course-lock";

// #47 P4 のテスト担当による追加（ロックの確認がある 4 つの API を、1 つの状態つきの偽 DB で横断して確かめる）。
// - POST /api/progress：何度・どの形で送ってもロックを外せない。完了を書くのは解放済みのコースだけ（書いた分は偽 DB に残る）
// - 403 のときに読む DB は、ロックの判定（レッスン・コース・進捗）だけ。書き込みはない。応答に他の情報が出ない
// - ロールは "INSTRUCTOR" と完全に一致するときだけ講師扱い（小文字・別のロール・ロールなしは受講生と同じくロックを確かめる）
// - GET /api/courses：ロック中のコースのレッスンの videoUrl・content・pdfUrl の値が、応答のどこにも出ない（乱数で照合）
// DB・ネットワークなし。prisma は globalThis.prisma に置く偽物（呼び出しを記録する）。NextAuth は installFakeAuth で差し替える。
// データはすべてダミー。

type Row = Record<string, unknown>;
type Call = { method: string; args: Row };
type LessonRow = {
  id: string;
  sectionId: string;
  title: string;
  type: string;
  videoUrl: string | null;
  content: string | null;
  pdfUrl: string | null;
  duration: string | null;
  order: number;
};
type SectionRow = { id: string; courseId: string; title: string; order: number; lessons: LessonRow[] };
type CourseRow = { id: string; name: string; description: string | null; order: number; icon: string; color: string; sections: SectionRow[] };
type ProgressRow = { userId: string; lessonId: string; completed: boolean };
type CommentRow = { id: string; lessonId: string; content: string };

const STUDENT = (STUDENT_SESSION as { user: { id: string } }).user.id;
const INSTRUCTOR = (INSTRUCTOR_SESSION as { user: { id: string } }).user.id;

let session: FakeSession;
let calls: Call[];
let courses: CourseRow[];
let progress: ProgressRow[];
let comments: CommentRow[];

const cmpId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedCourses = () => [...courses].sort((a, b) => a.order - b.order || cmpId(a.id, b.id));
const allLessons = () => courses.flatMap((c) => c.sections.flatMap((s) => s.lessons));
const courseOfLesson = (lessonId: string) => courses.find((c) => c.sections.some((s) => s.lessons.some((l) => l.id === lessonId)));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const fakePrisma = {
  lesson: {
    async findUnique(args: { where: { id: string }; select?: Row }) {
      calls.push({ method: "lesson.findUnique", args });
      const c = courseOfLesson(args.where.id);
      if (!c) return null;
      return args.select?.section ? { section: { courseId: c.id } } : { id: args.where.id };
    },
  },
  course: {
    async findMany(args: Row) {
      calls.push({ method: "course.findMany", args });
      if (args.include === undefined) {
        return sortedCourses().map((c) => ({ id: c.id, sections: c.sections.map((s) => ({ lessons: s.lessons.map((l) => ({ id: l.id })) })) }));
      }
      return clone(sortedCourses());
    },
    async findUnique(args: { where: { id: string } }) {
      calls.push({ method: "course.findUnique", args });
      const c = courses.find((x) => x.id === args.where.id);
      return c ? clone(c) : null;
    },
  },
  progress: {
    async findMany(args: { where: { userId: string; completed: boolean; lesson?: { section: { courseId: string } } } }) {
      calls.push({ method: "progress.findMany", args });
      const w = args.where;
      return progress
        .filter((p) => p.userId === w.userId && p.completed === w.completed)
        .filter((p) => !w.lesson || courseOfLesson(p.lessonId)?.id === w.lesson.section.courseId)
        .map((p) => ({ lessonId: p.lessonId }));
    },
    async upsert(args: { where: { userId_lessonId: { userId: string; lessonId: string } } }) {
      calls.push({ method: "progress.upsert", args });
      const { userId, lessonId } = args.where.userId_lessonId;
      const existing = progress.find((p) => p.userId === userId && p.lessonId === lessonId);
      if (existing) existing.completed = true;
      else progress.push({ userId, lessonId, completed: true });
      return { id: `p_${userId}_${lessonId}`, userId, lessonId, completed: true, completedAt: new Date("2026-10-14T00:00:00.000Z") };
    },
  },
  comment: {
    async findMany(args: { where: { lessonId: string } }) {
      calls.push({ method: "comment.findMany", args });
      return comments.filter((c) => c.lessonId === args.where.lessonId).map((c) => ({ ...c, createdAt: new Date(0), userId: STUDENT, user: { name: "ダミー", role: "STUDENT", deactivatedAt: null }, replies: [] }));
    },
  },
};

let progressRoute: typeof import("../../src/app/api/progress/route");
let courseList: typeof import("../../src/app/api/courses/route");
let courseDetail: typeof import("../../src/app/api/courses/[courseId]/route");
let lessonComments: typeof import("../../src/app/api/comments/[lessonId]/route");

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  progressRoute = await import("../../src/app/api/progress/route");
  courseList = await import("../../src/app/api/courses/route");
  courseDetail = await import("../../src/app/api/courses/[courseId]/route");
  lessonComments = await import("../../src/app/api/comments/[lessonId]/route");
});

/** 値に印（SECRET_<lessonId>_<項目>）を入れたレッスン。応答の文字列にこの印が出たら漏れている */
const secret = (lessonId: string, field: string) => `SECRET_${lessonId}_${field}`;
function lesson(id: string, sectionId: string, order: number): LessonRow {
  return {
    id,
    sectionId,
    title: `ダミー${id}`,
    type: "VIDEO",
    videoUrl: `https://example.com/${secret(id, "videoUrl")}`,
    content: `本文 ${secret(id, "content")}`,
    pdfUrl: `https://example.com/${secret(id, "pdfUrl")}.pdf`,
    duration: "10:00",
    order,
  };
}
function course(id: string, order: number, lessonIds: string[][]): CourseRow {
  return {
    id,
    name: `コース${id}`,
    description: null,
    order,
    icon: "it",
    color: "#111111",
    sections: lessonIds.map((ids, si) => ({
      id: `${id}_s${si}`,
      courseId: id,
      title: `S${si}`,
      order: si,
      lessons: ids.map((lid, li) => lesson(lid, `${id}_s${si}`, li)),
    })),
  };
}

beforeEach(() => {
  session = STUDENT_SESSION;
  calls = [];
  progress = [];
  courses = [course("course_a", 1, [["a1", "a2"]]), course("course_b", 2, [["b1"], ["b2"]]), course("course_c", 3, [["c1"]])];
  comments = [
    { id: "q_b1", lessonId: "b1", content: "ロック中のレッスンの質問 SECRET_comment_b1" },
    { id: "q_a1", lessonId: "a1", content: "解放済みのレッスンの質問" },
  ];
});

function post(body: unknown) {
  return progressRoute.POST(
    new Request("http://localhost/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}
const detail = (id: string) => courseDetail.GET(new Request(`http://localhost/api/courses/${id}`), { params: Promise.resolve({ courseId: id }) });
const commentsOf = (id: string) =>
  lessonComments.GET(new Request(`http://localhost/api/comments/${encodeURIComponent(id)}`), { params: Promise.resolve({ lessonId: id }) });

const methods = () => calls.map((c) => c.method);
const writes = () => calls.filter((c) => !/\.(findUnique|findMany|findFirst|count)$/.test(c.method));
const LOCK_READS = ["course.findMany", "lesson.findUnique", "progress.findMany"];

/** 講師以外として扱われるべきセッション（ロールの綴り違い・別のロール・ロールなし） */
const NON_INSTRUCTOR_SESSIONS: Array<[string, FakeSession]> = [
  ["STUDENT", STUDENT_SESSION],
  ["小文字の instructor", { user: { id: STUDENT, role: "instructor" } }],
  ["Instructor", { user: { id: STUDENT, role: "Instructor" } }],
  ["前後に空白のある INSTRUCTOR", { user: { id: STUDENT, role: " INSTRUCTOR " } }],
  ["ADMIN", { user: { id: STUDENT, role: "ADMIN" } }],
  ["空文字", { user: { id: STUDENT, role: "" } }],
  ["ロールなし", { user: { id: STUDENT } }],
];

describe("POST /api/progress：ロックを外す経路が残っていない", () => {
  it("ロック中のコースのどのレッスンに何度送っても 403 で、進捗が 1 件も増えない", async () => {
    for (let i = 0; i < 3; i++) {
      for (const lessonId of ["b1", "b2", "c1"]) {
        const res = await post({ lessonId });
        assert.equal(res.status, 403, `${i + 1} 回目 ${lessonId} の status ${res.status}`);
      }
    }
    assert.deepEqual(progress, [], "ロック中のコースに進捗が書かれた");
    assert.deepEqual(writes(), [], "書き込みが呼ばれた");
  });

  it("同時に 20 件送っても、すべて 403 で書き込まない", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => post({ lessonId: i % 2 ? "b1" : "c1" })));
    assert.deepEqual(results.map((r) => r.status), Array(20).fill(403));
    assert.deepEqual(progress, [], "進捗が書かれた");
  });

  it("前のコースの一部だけ終えても次のコースは 403 のまま。全部終えると 200 で、その次のコースはまだ 403", async () => {
    assert.equal((await post({ lessonId: "a1" })).status, 200);
    assert.equal((await post({ lessonId: "b1" })).status, 403, "a1 だけで course_b が解放された");
    assert.equal((await post({ lessonId: "a2" })).status, 200);
    assert.equal((await post({ lessonId: "b1" })).status, 200, "course_a を全部終えても course_b が解放されない");
    assert.equal((await post({ lessonId: "c1" })).status, 403, "course_b の途中で course_c が解放された");
    assert.deepEqual(progress.map((p) => p.lessonId).sort(), ["a1", "a2", "b1"], "書かれた進捗が違う");
  });

  it("lessonId の別の形（空白・大文字・パス・配列・__proto__ 経由）では、ロック中のレッスンに書けない", async () => {
    const bodies: unknown[] = [
      { lessonId: " b1" },
      { lessonId: "b1 " },
      { lessonId: "B1" },
      { lessonId: "b1\u0000" },
      { lessonId: "../b1" },
      { lessonId: ["b1"] },
      { lessonId: { id: "b1" } },
      { lessonId: "b1", lessonIds: ["b1"] },
      '{"__proto__":{"lessonId":"b1"}}',
      '{"lessonId":"a1","lessonId":"b1"}',
    ];
    for (const body of bodies) {
      calls = [];
      const res = await post(body);
      assert.ok([400, 403, 404].includes(res.status), `${JSON.stringify(body)} の status ${res.status}`);
      assert.deepEqual(progress, [], `${JSON.stringify(body)} で進捗が書かれた`);
    }
  });

  it("body の userId・completed は使わない（自分の userId で完了を書く）", async () => {
    const res = await post({ lessonId: "a1", userId: INSTRUCTOR, completed: false });
    assert.equal(res.status, 200, `status ${res.status}`);
    assert.deepEqual(progress, [{ userId: STUDENT, lessonId: "a1", completed: true }]);
  });

  it("存在しないレッスンは 404 で、ロックの状態も書き込みもない応答（本文は固定）", async () => {
    const res = await post({ lessonId: "missing" });
    assert.equal(res.status, 404, `status ${res.status}`);
    assert.deepEqual(await res.json(), { error: "Lesson not found" });
    assert.deepEqual(methods(), ["lesson.findUnique"], "レッスンがないのにコース・進捗を読んでいる");
  });

  for (const [label, s] of NON_INSTRUCTOR_SESSIONS) {
    it(`ロールが ${label} のセッションは受講生と同じくロックを確かめ、403 で書き込まない`, async () => {
      session = s;
      const res = await post({ lessonId: "c1" });
      assert.equal(res.status, 403, `status ${res.status}`);
      assert.deepEqual(progress, [], "ロック中のコースに進捗が書かれた");
    });
  }

  it("403 のとき読むのはロックの判定だけ（レッスン・コース・自分の進捗）で、本文は固定", async () => {
    const res = await post({ lessonId: "b2" });
    assert.equal(res.status, 403, `status ${res.status}`);
    assert.deepEqual(await res.json(), { error: "Forbidden", reason: "course_locked" });
    assert.deepEqual([...methods()].sort(), LOCK_READS);
    for (const c of calls.filter((x) => x.method === "progress.findMany")) {
      assert.deepEqual((c.args as { where: unknown }).where, { userId: STUDENT, completed: true }, "自分以外の進捗を読んでいる");
    }
  });

  it("講師はロック中のコースにも書ける（ロックの判定を読まない）", async () => {
    session = INSTRUCTOR_SESSION;
    const res = await post({ lessonId: "c1" });
    assert.equal(res.status, 200, `status ${res.status}`);
    assert.deepEqual(methods(), ["lesson.findUnique", "progress.upsert"]);
    assert.deepEqual(progress, [{ userId: INSTRUCTOR, lessonId: "c1", completed: true }]);
  });

  it("講師の完了は、受講生のロックを外さない（講師の進捗で受講生が解放されない）", async () => {
    session = INSTRUCTOR_SESSION;
    for (const id of ["a1", "a2", "b1", "c1"]) assert.equal((await post({ lessonId: id })).status, 200);
    session = STUDENT_SESSION;
    assert.equal((await post({ lessonId: "b1" })).status, 403);
    assert.equal((await detail("course_b")).status, 403);
  });
});

describe("GET /api/courses/[courseId]・GET /api/comments/[lessonId]：403 の中身", () => {
  it("コースの詳細の 403 は、ロックの判定（コースの一覧と自分の進捗）だけを読む。本文にコースの情報を含めない", async () => {
    const res = await detail("course_b");
    assert.equal(res.status, 403, `status ${res.status}`);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "Forbidden", reason: "course_locked" });
    assert.doesNotMatch(text, /SECRET_|course_b|b1/, "403 の本文にコースの情報が出ている");
    assert.deepEqual([...methods()].sort(), ["course.findMany", "progress.findMany"]);
    const lockRead = calls.find((c) => c.method === "course.findMany");
    assert.ok(lockRead, "course.findMany が呼ばれていない");
    assert.equal(lockRead.args.include, undefined, "ロックの判定でレッスンの中身まで読んでいる");
  });

  it("質問タブの 403 は、ロックの判定だけを読み、質問を読まない。本文に質問を含めない", async () => {
    const res = await commentsOf("b1");
    assert.equal(res.status, 403, `status ${res.status}`);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "Forbidden", reason: "course_locked" });
    assert.doesNotMatch(text, /SECRET_|q_b1/, "403 の本文に質問が出ている");
    assert.deepEqual([...methods()].sort(), LOCK_READS);
  });

  for (const [label, s] of NON_INSTRUCTOR_SESSIONS) {
    it(`ロールが ${label} のセッションは、コースの詳細・質問タブとも 403`, async () => {
      session = s;
      assert.equal((await detail("course_c")).status, 403, "コースの詳細が 403 でない");
      assert.equal((await commentsOf("c1")).status, 403, "質問タブが 403 でない");
      assert.ok(!methods().includes("course.findUnique") && !methods().includes("comment.findMany"), "403 なのに中身を読んでいる");
    });
  }

  it("講師はコースの詳細・質問タブともロックを見ずに 200（中身を返す）", async () => {
    session = INSTRUCTOR_SESSION;
    const d = await detail("course_c");
    assert.equal(d.status, 200, `status ${d.status}`);
    assert.match(await d.text(), /SECRET_c1_videoUrl/, "講師にレッスンの中身を返していない");
    const q = await commentsOf("b1");
    assert.equal(q.status, 200, `status ${q.status}`);
    assert.deepEqual((await q.json()).map((c: { id: string }) => c.id), ["q_b1"]);
    assert.ok(!methods().includes("lesson.findUnique"), "講師でロックの判定のためにレッスンを読んでいる");
    assert.ok(!methods().includes("course.findMany"), "講師でロックの判定のためにコースの一覧を読んでいる");
  });

  it("受講生が前のコースを終えれば、詳細は 200 でレッスンの中身を返し、質問タブも 200", async () => {
    progress = [
      { userId: STUDENT, lessonId: "a1", completed: true },
      { userId: STUDENT, lessonId: "a2", completed: true },
    ];
    const d = await detail("course_b");
    assert.equal(d.status, 200, `status ${d.status}`);
    assert.match(await d.text(), /SECRET_b1_content/);
    assert.equal((await commentsOf("b1")).status, 200);
  });
});

// ───────────── GET /api/courses の除外（入れ子のどこにも出ない） ─────────────

const HIDDEN = ["videoUrl", "content", "pdfUrl"] as const;

/** 値の中のすべてのキー（入れ子を含む） */
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  }
  return out;
}

type ApiCourse = { id: string; locked: boolean; sections: Array<{ lessons: Array<Row & { id: string; completed: boolean }> }> };

/** 受講生にとっての正解のロック（order → id の順。isCourseLocked） */
function expectedLocks(userId: string): Map<string, boolean> {
  const done = new Set(progress.filter((p) => p.userId === userId && p.completed).map((p) => p.lessonId));
  const out = new Map<string, boolean>();
  let prev: LessonCounts | null = null;
  for (const c of sortedCourses()) {
    const ids = c.sections.flatMap((s) => s.lessons.map((l) => l.id));
    const counts = { totalLessons: ids.length, completedLessons: ids.filter((id) => done.has(id)).length };
    out.set(c.id, isCourseLocked(prev, counts));
    prev = counts;
  }
  return out;
}

/** 応答の検査：ロック中のコースは、入れ子のどこにも除く項目のキーも値の印もない。解放済みは全部ある */
async function checkList(res: Response, ctx: string, wantLocks: Map<string, boolean> | null) {
  assert.equal(res.status, 200, `${ctx}: status ${res.status}`);
  const text = await res.text();
  const body = JSON.parse(text) as ApiCourse[];
  assert.deepEqual(body.map((c) => c.id), sortedCourses().map((c) => c.id), `${ctx}: コースの並びが違う`);
  for (const c of body) {
    const locked = wantLocks ? wantLocks.get(c.id) === true : false;
    assert.equal(c.locked, locked, `${ctx}: ${c.id} の locked が違う`);
    const lessonIds = c.sections.flatMap((s) => s.lessons.map((l) => l.id));
    const keys = allKeys(c);
    for (const f of HIDDEN) {
      if (locked) {
        assert.ok(!keys.includes(f), `${ctx}: ロック中の ${c.id} に ${f} のキーがある`);
        for (const id of lessonIds) assert.ok(!text.includes(secret(id, f)), `${ctx}: ロック中の ${id} の ${f} の値が応答に出ている`);
      } else {
        for (const id of lessonIds) assert.ok(text.includes(secret(id, f)), `${ctx}: 解放済みの ${id} の ${f} が応答にない`);
      }
    }
    for (const s of c.sections) {
      for (const l of s.lessons) {
        for (const k of ["id", "title", "type", "completed"]) assert.ok(k in l, `${ctx}: ${l.id} に ${k} がない（画面のロック計算に要る）`);
      }
    }
  }
}

describe("GET /api/courses：ロック中のコースから本文・動画・資料を除く", () => {
  it("受講生：ロック中のコースは、キーも値もどこにも出ない（解放済みはそのまま）", async () => {
    progress = [{ userId: STUDENT, lessonId: "a1", completed: true }];
    await checkList(await courseList.GET(), "受講生", expectedLocks(STUDENT));
  });

  for (const [label, s] of NON_INSTRUCTOR_SESSIONS.slice(1)) {
    it(`ロールが ${label} のセッションも受講生と同じく除く`, async () => {
      session = s;
      await checkList(await courseList.GET(), label, expectedLocks(STUDENT));
    });
  }

  it("講師：どのコースも locked: false で、すべての項目を返す", async () => {
    session = INSTRUCTOR_SESSION;
    await checkList(await courseList.GET(), "講師", null);
  });

  it("他の受講生の完了では、自分の一覧のロックは外れない", async () => {
    progress = [
      { userId: "stu_other", lessonId: "a1", completed: true },
      { userId: "stu_other", lessonId: "a2", completed: true },
      { userId: "stu_other", lessonId: "b1", completed: true },
    ];
    const body = (await (await courseList.GET()).json()) as ApiCourse[];
    assert.deepEqual(body.map((c) => [c.id, c.locked]), [
      ["course_a", false],
      ["course_b", true],
      ["course_c", true],
    ]);
  });

  /** 再現できるよう、シード固定の簡単な乱数（mulberry32） */
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("乱数の 200 通りの構成で、locked が isCourseLocked と一致し、ロック中のコースだけ除く。詳細・完了・質問タブの 403 も一致する", async () => {
    const rand = rng(4747);
    const pick = (n: number) => Math.floor(rand() * n);
    let lockedSeen = 0;
    let total = 0;
    for (let trial = 0; trial < 200; trial++) {
      courses = Array.from({ length: 1 + pick(4) }, (_, ci) => {
        const id = `t${trial}_${String.fromCharCode(97 + pick(26))}${ci}`;
        return course(
          id,
          pick(3),
          Array.from({ length: pick(3) }, (_, si) => Array.from({ length: pick(3) }, (_, li) => `${id}_s${si}_l${li}`))
        );
      });
      progress = [];
      for (const l of allLessons()) {
        const r = rand();
        if (r < 0.35) progress.push({ userId: STUDENT, lessonId: l.id, completed: true });
        else if (r < 0.45) progress.push({ userId: STUDENT, lessonId: l.id, completed: false });
        else if (r < 0.6) progress.push({ userId: "stu_other", lessonId: l.id, completed: true });
      }
      const want = expectedLocks(STUDENT);
      const ctx = `trial ${trial}: ${JSON.stringify({ courses: courses.map((c) => ({ id: c.id, order: c.order, lessons: c.sections.map((s) => s.lessons.map((l) => l.id)) })), progress })}`;
      session = STUDENT_SESSION;
      await checkList(await courseList.GET(), ctx, want);

      for (const c of sortedCourses()) {
        const locked = want.get(c.id) === true;
        total++;
        if (locked) lockedSeen++;
        assert.equal((await detail(c.id)).status, locked ? 403 : 200, `${ctx}: /api/courses/${c.id}`);
        const first = c.sections.flatMap((s) => s.lessons)[0];
        if (!first) continue;
        assert.equal((await commentsOf(first.id)).status, locked ? 403 : 200, `${ctx}: /api/comments/${first.id}`);
        const before = progress.length;
        const res = await post({ lessonId: first.id });
        assert.equal(res.status, locked ? 403 : 200, `${ctx}: POST /api/progress ${first.id}`);
        if (locked) assert.equal(progress.length, before, `${ctx}: ロック中に進捗が書かれた`);
        // 完了を書いた（解放済みのコース）ので、ロックの正解を計算し直す
        expectedLocks(STUDENT).forEach((v, k) => want.set(k, v));
      }
    }
    assert.ok(total > 200, `照合したコースが少ない: ${total}`);
    assert.ok(lockedSeen > 0 && lockedSeen < total, `ロック中と解放済みの両方を照合できていない: ${lockedSeen}/${total}`);
  });
});

describe("見えない文字", () => {
  it("このファイルのソースに見えない文字・全角空白を直接書いていない", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(__filename, "utf8");
    assert.doesNotMatch(text, new RegExp("[\\u00A0\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u3000\\uFEFF]", "u"));
  });
});
