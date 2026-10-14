import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #47 P3 で並び順だけを変えた 3 つのルート（これまでルートのテストがなかった）の、応答の形・認証・他人のデータを確かめる。
// - GET /api/courses、GET /api/courses/[courseId]、GET /api/admin/courses
// - 応答の項目は変えていない（並び順だけ）ことを、項目の一覧で固定する
//   （#47 P4 で /api/courses に locked を足し、受講生のロック中のコースのレッスンを許可リストの項目だけにした。
//   /api/courses/[courseId] は受講生のロック中のコースを 403 course_locked にした）
// - 未ログイン・ロール違いは DB を読む前に拒否する
// - 他の受講生の進捗が自分の completed に混ざらない（userId で絞る）
// 偽の prisma は、Prisma の include の結果と同じ形（項目を足さない）を返す。DB・ネットワークなし。データはすべてダミー。

type Row = Record<string, unknown>;
type Call = { method: string; args: Row };

const STUDENT_ID = (STUDENT_SESSION as { user: { id: string } }).user.id;
const OTHER_ID = "stu_other";

const lesson = (id: string, sectionId: string, order: number) => ({
  id,
  sectionId,
  title: `ダミー${id}`,
  type: "VIDEO",
  videoUrl: null,
  content: null,
  pdfUrl: null,
  duration: null,
  order,
});
const COURSES = [
  {
    id: "c_1",
    name: "ダミーコース1",
    description: null,
    order: 1,
    icon: "it",
    color: "#111111",
    sections: [{ id: "s_1", courseId: "c_1", title: "S1", order: 1, lessons: [lesson("l_1", "s_1", 1), lesson("l_2", "s_1", 2)] }],
  },
  {
    id: "c_2",
    name: "ダミーコース2",
    description: "説明",
    order: 2,
    icon: "html",
    color: "#222222",
    sections: [
      { id: "s_2", courseId: "c_2", title: "S2", order: 1, lessons: [lesson("l_3", "s_2", 1)] },
      { id: "s_3", courseId: "c_2", title: "S3", order: 2, lessons: [] },
    ],
  },
];
const PROGRESS = [
  { userId: STUDENT_ID, lessonId: "l_1", completed: true },
  { userId: STUDENT_ID, lessonId: "l_2", completed: false },
  // 他の受講生の完了。自分の応答に混ざってはいけない
  { userId: OTHER_ID, lessonId: "l_2", completed: true },
  { userId: OTHER_ID, lessonId: "l_3", completed: true },
];

let session: FakeSession;
let calls: Call[];

const fakePrisma = {
  course: {
    async findMany(args: Row) {
      calls.push({ method: "course.findMany", args });
      if (args.include === undefined) {
        // ロックの判定（lesson-access。#47 P4）：id とレッスンの id だけ
        return COURSES.map((c) => ({ id: c.id, sections: c.sections.map((sec) => ({ lessons: sec.lessons.map((l) => ({ id: l.id })) })) }));
      }
      const include = args.include as { sections: { include: Row } };
      return COURSES.map((c) => {
        const { sections, ...scalar } = c;
        if ("_count" in include) {
          // /api/admin/courses：sections（_count.lessons つき）と _count.sections
          return {
            ...scalar,
            sections: sections.map(({ lessons, ...s }) => ({ ...s, _count: { lessons: lessons.length } })),
            _count: { sections: sections.length },
          };
        }
        return { ...scalar, sections: sections.map((s) => ({ ...s, lessons: s.lessons.map((l) => ({ ...l })) })) };
      });
    },
    async findUnique(args: Row & { where: { id: string } }) {
      calls.push({ method: "course.findUnique", args });
      const c = COURSES.find((x) => x.id === args.where.id);
      return c ? { ...c, sections: c.sections.map((s) => ({ ...s, lessons: s.lessons.map((l) => ({ ...l })) })) } : null;
    },
  },
  progress: {
    async findMany(args: Row & { where: { userId: string; completed: boolean } }) {
      calls.push({ method: "progress.findMany", args });
      return PROGRESS.filter((p) => p.userId === args.where.userId && p.completed === args.where.completed).map((p) => ({ lessonId: p.lessonId }));
    },
  },
};

let courseList: typeof import("../../src/app/api/courses/route");
let courseDetail: typeof import("../../src/app/api/courses/[courseId]/route");
let adminCourses: typeof import("../../src/app/api/admin/courses/route");

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  courseList = await import("../../src/app/api/courses/route");
  courseDetail = await import("../../src/app/api/courses/[courseId]/route");
  adminCourses = await import("../../src/app/api/admin/courses/route");
});

beforeEach(() => {
  calls = [];
  session = STUDENT_SESSION;
});

const detail = (id: string) =>
  courseDetail.GET(new Request(`http://localhost/api/courses/${id}`), { params: Promise.resolve({ courseId: id }) });

const keys = (o: unknown) => Object.keys(o as Row).sort();
const COURSE_KEYS = ["color", "description", "icon", "id", "name", "order", "progress", "sections"];
/** /api/courses の 1 コース（#47 P4 で locked を足した） */
const LIST_COURSE_KEYS = [...COURSE_KEYS, "locked"].sort();
const SECTION_KEYS = ["courseId", "id", "lessons", "order", "title"];
const LESSON_KEYS = ["completed", "content", "duration", "id", "order", "pdfUrl", "sectionId", "title", "type", "videoUrl"];
/** /api/courses の、受講生のロック中のコースのレッスン（LOCKED_LESSON_VISIBLE_FIELDS の項目だけ。#47 P4） */
const LOCKED_LESSON_KEYS = ["completed", "duration", "id", "order", "sectionId", "title", "type"];

type ApiCourse = { id: string; progress: number; sections: Array<{ id: string; lessons: Array<{ id: string; completed: boolean }> }> };

describe("GET /api/courses：応答の形（#47 P3 で変わっていない。P4 で locked を足した）", () => {
  it("コース・セクション・レッスンの項目と、completed・progress・locked の値（受講生）", async () => {
    const res = await courseList.GET();
    assert.equal(res.status, 200, `status ${res.status}`);
    assert.equal(res.headers.get("Cache-Control"), "private, max-age=0, stale-while-revalidate=60");
    const body = (await res.json()) as Array<ApiCourse & { locked: unknown }>;
    assert.ok(Array.isArray(body), "配列でない");
    assert.deepEqual(body.map((c) => c.id), ["c_1", "c_2"]);
    // c_1 は 1/2 完了なので、未着手の c_2 はロック中
    assert.deepEqual(body.map((c) => c.locked), [false, true]);
    for (const c of body) {
      assert.deepEqual(keys(c), LIST_COURSE_KEYS, `${c.id} の項目が違う`);
      for (const s of c.sections) {
        assert.deepEqual(keys(s), SECTION_KEYS, `${s.id} の項目が違う`);
        for (const l of s.lessons) assert.deepEqual(keys(l), c.locked ? LOCKED_LESSON_KEYS : LESSON_KEYS, `${l.id} の項目が違う`);
      }
    }
    assert.deepEqual(
      body.flatMap((c) => c.sections.flatMap((s) => s.lessons.map((l) => [l.id, l.completed]))),
      [
        ["l_1", true],
        ["l_2", false],
        ["l_3", false],
      ],
      "completed が自分の完了だけになっていない（他の受講生の完了が混ざっている）"
    );
    assert.deepEqual(body.map((c) => c.progress), [50, 0]);
  });

  it("Lesson に将来列が増えても、ロック中のコースのレッスンには出さない（許可リスト）", async () => {
    const target = COURSES[1].sections[0].lessons[0] as Row;
    target.transcript = "SECRET_future_column";
    try {
      const res = await courseList.GET();
      assert.equal(res.status, 200, `status ${res.status}`);
      const text = await res.text();
      assert.ok(!text.includes("SECRET_future_column"), "ロック中のコースのレッスンに、許可リストにない列が出ている");
      const body = JSON.parse(text) as Array<ApiCourse & { locked: unknown }>;
      assert.equal(body[1].locked, true, "c_2 がロック中になっていない");
      for (const l of body[1].sections[0].lessons) assert.deepEqual(keys(l), LOCKED_LESSON_KEYS, `${l.id} の項目が違う`);
    } finally {
      delete target.transcript;
    }
  });

  it("講師には、どのコースも locked: false で、レッスンの項目を除かない", async () => {
    session = INSTRUCTOR_SESSION;
    const body = (await (await courseList.GET()).json()) as Array<ApiCourse & { locked: unknown }>;
    assert.deepEqual(body.map((c) => c.locked), [false, false]);
    for (const c of body) {
      assert.deepEqual(keys(c), LIST_COURSE_KEYS, `${c.id} の項目が違う`);
      for (const s of c.sections) for (const l of s.lessons) assert.deepEqual(keys(l), LESSON_KEYS, `${l.id} の項目が違う`);
    }
  });

  it("受講生でも、前のコースを全部終えれば locked: false で、レッスンの項目を除かない", async () => {
    PROGRESS.push({ userId: STUDENT_ID, lessonId: "l_2", completed: true });
    try {
      const body = (await (await courseList.GET()).json()) as Array<ApiCourse & { locked: unknown }>;
      assert.deepEqual(body.map((c) => c.locked), [false, false]);
      for (const c of body) for (const s of c.sections) for (const l of s.lessons) assert.deepEqual(keys(l), LESSON_KEYS, `${l.id} の項目が違う`);
    } finally {
      PROGRESS.pop();
    }
  });

  it("進捗は自分の userId で、完了だけを読む", async () => {
    await courseList.GET();
    const p = calls.find((c) => c.method === "progress.findMany");
    assert.ok(p, "progress.findMany が呼ばれていない");
    assert.deepEqual(p.args.where, { userId: STUDENT_ID, completed: true });
  });

  it("未ログインは 401 で、DB を読まない", async () => {
    for (const s of [null, { user: {} }] as FakeSession[]) {
      session = s;
      calls = [];
      const res = await courseList.GET();
      assert.equal(res.status, 401, `session ${JSON.stringify(s)} で 401 にならない`);
      assert.deepEqual(calls, [], "未ログインで DB を読んでいる");
    }
  });
});

describe("GET /api/courses/[courseId]：応答の形・認証・他人のデータ", () => {
  it("コースの項目と、completed・progress の値", async () => {
    const res = await detail("c_1");
    assert.equal(res.status, 200, `status ${res.status}`);
    assert.equal(res.headers.get("Cache-Control"), "private, max-age=0, stale-while-revalidate=60");
    const body = (await res.json()) as ApiCourse;
    assert.deepEqual(keys(body), COURSE_KEYS);
    assert.deepEqual(keys(body.sections[0]), SECTION_KEYS);
    assert.deepEqual(keys(body.sections[0].lessons[0]), LESSON_KEYS);
    assert.deepEqual(body.sections[0].lessons.map((l) => [l.id, l.completed]), [
      ["l_1", true],
      ["l_2", false],
    ]);
    assert.equal(body.progress, 50);
  });

  it("他の受講生だけが完了したレッスンは completed: false（進捗は自分の userId とコースで絞る）", async () => {
    // c_1 を全部終えて c_2 を解放した受講生（#47 P4 で、ロック中の c_2 は 403 になったため）
    PROGRESS.push({ userId: STUDENT_ID, lessonId: "l_2", completed: true });
    try {
      const body = (await (await detail("c_2")).json()) as ApiCourse;
      assert.deepEqual(body.sections.flatMap((s) => s.lessons.map((l) => [l.id, l.completed])), [["l_3", false]]);
      assert.equal(body.progress, 0);
      const p = calls.find((c) => c.method === "progress.findMany" && "lesson" in (c.args.where as Row));
      assert.ok(p, "コースで絞った progress.findMany が呼ばれていない");
      assert.deepEqual(p.args.where, { userId: STUDENT_ID, completed: true, lesson: { section: { courseId: "c_2" } } });
    } finally {
      PROGRESS.pop();
    }
  });

  it("受講生のロック中のコースは 403 course_locked で、コースの中身を読まない（#47 P4）", async () => {
    const res = await detail("c_2");
    assert.equal(res.status, 403, `status ${res.status}`);
    assert.deepEqual(await res.json(), { error: "Forbidden", reason: "course_locked" });
    assert.ok(!calls.some((c) => c.method === "course.findUnique"), "ロック中なのにコースの中身を読んでいる");
    assert.ok(
      !calls.some((c) => c.method === "progress.findMany" && "lesson" in (c.args.where as Row)),
      "ロック中なのにコースの進捗を読んでいる"
    );
  });

  it("講師はロックを見ない（受講生にはロック中の c_2 も 200 で、ロックの判定を読まない）", async () => {
    session = INSTRUCTOR_SESSION;
    const res = await detail("c_2");
    assert.equal(res.status, 200, `status ${res.status}`);
    assert.ok(!calls.some((c) => c.method === "course.findMany"), "講師でロックの判定を読んでいる");
  });

  it("ロールのないセッションは受講生と同じくロックを確かめる", async () => {
    session = { user: { id: STUDENT_ID } };
    assert.equal((await detail("c_2")).status, 403);
  });

  it("存在しないコースは 404（受講生・講師とも）", async () => {
    for (const s of [STUDENT_SESSION, INSTRUCTOR_SESSION]) {
      session = s;
      const res = await detail("c_none");
      assert.equal(res.status, 404, `status ${res.status}`);
      assert.deepEqual(await res.json(), { error: "Course not found" });
    }
  });

  it("未ログインは 401 で、DB を読まない", async () => {
    session = null;
    const res = await detail("c_1");
    assert.equal(res.status, 401, `status ${res.status}`);
    assert.deepEqual(calls, [], "未ログインで DB を読んでいる");
  });

  it("DB のエラーは 500（本文にエラーの中身を出さない）", async () => {
    const orig = fakePrisma.course.findUnique;
    fakePrisma.course.findUnique = async () => {
      throw new Error("dummy-db-failure");
    };
    const origError = console.error;
    console.error = () => {};
    try {
      const res = await detail("c_1");
      assert.equal(res.status, 500, `status ${res.status}`);
      const text = await res.text();
      assert.ok(!text.includes("dummy-db-failure"), "エラーの中身が応答に出ている");
    } finally {
      fakePrisma.course.findUnique = orig;
      console.error = origError;
    }
  });
});

describe("GET /api/admin/courses：応答の形・権限", () => {
  it("講師には、コース・セクション（_count つき）と sectionCount・lessonCount を返す", async () => {
    session = INSTRUCTOR_SESSION;
    const res = await adminCourses.GET();
    assert.equal(res.status, 200, `status ${res.status}`);
    const body = (await res.json()) as Array<Row & { sections: Row[] }>;
    assert.deepEqual(body.map((c) => c.id), ["c_1", "c_2"]);
    for (const c of body) {
      assert.deepEqual(keys(c), ["_count", "color", "description", "icon", "id", "lessonCount", "name", "order", "sectionCount", "sections"], `${c.id} の項目が違う`);
      for (const s of c.sections) assert.deepEqual(keys(s), ["_count", "courseId", "id", "order", "title"], `${s.id} の項目が違う`);
    }
    assert.deepEqual(body.map((c) => [c.sectionCount, c.lessonCount]), [
      [1, 2],
      [2, 1],
    ]);
  });

  it("受講生・未ログイン・ロールなしは 403 で、DB を読まない", async () => {
    for (const s of [STUDENT_SESSION, null, { user: { id: "x" } }] as FakeSession[]) {
      session = s;
      calls = [];
      const res = await adminCourses.GET();
      assert.equal(res.status, 403, `session ${JSON.stringify(s)} で 403 にならない`);
      assert.deepEqual(calls, [], "講師以外で DB を読んでいる");
    }
  });
});
