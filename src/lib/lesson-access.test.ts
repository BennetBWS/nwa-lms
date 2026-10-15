import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COURSE_LOCKED_REASON,
  LOCKED_LESSON_VISIBLE_FIELDS,
  courseAccessFor,
  hideLockedLessonContent,
  lessonAccessFor,
  quizAccessFor,
  unlockedCourseIdsFor,
  type LessonAccessDb,
  type QuizAccessDb,
} from "./lesson-access";
import { COURSE_ORDER_BY } from "./course-order";

// #46 受講生がレッスンを使えるか（コースのロック）。DB なし：使う 3 メソッドだけの偽物。データはすべてダミー。

type Course = { id: string; order: number; lessons: string[] };
type Progress = { userId: string; lessonId: string; completed: boolean };
type Call = { method: string; args: Record<string, unknown> };
/** クイズ（#47 P5）。ミニテストは lessonId、修了テストは courseId のコース（両方・どちらもなしもありうる） */
type Quiz = { id: string; type: "MINI" | "FINAL"; lessonId: string | null; courseId: string | null };

const STUDENT = "stu_1";

let courses: Course[];
let progress: Progress[];
let calls: Call[];
let quizzes: Quiz[];

function makeDb(): LessonAccessDb & QuizAccessDb {
  const fake = {
    quiz: {
      async findUnique(args: Record<string, unknown>) {
        calls.push({ method: "quiz.findUnique", args });
        const id = (args.where as { id: string }).id;
        const q = quizzes.find((x) => x.id === id);
        if (!q) return null;
        const course = q.lessonId === null ? undefined : courses.find((c) => c.lessons.includes(q.lessonId as string));
        return { type: q.type, courseId: q.courseId, lesson: course ? { section: { courseId: course.id } } : null };
      },
    },
    lesson: {
      async findUnique(args: Record<string, unknown>) {
        calls.push({ method: "lesson.findUnique", args });
        const id = (args.where as { id: string }).id;
        const course = courses.find((c) => c.lessons.includes(id));
        return course ? { section: { courseId: course.id } } : null;
      },
    },
    course: {
      async findMany(args: Record<string, unknown>) {
        calls.push({ method: "course.findMany", args });
        // route と同じく order → id の順（偽物は orderBy の値を確かめるだけで、並べ替えはここで行う）
        return [...courses]
          .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((c) => ({ id: c.id, sections: [{ lessons: c.lessons.map((id) => ({ id })) }] }));
      },
    },
    progress: {
      async findMany(args: Record<string, unknown>) {
        calls.push({ method: "progress.findMany", args });
        const where = args.where as { userId: string; completed: boolean };
        return progress.filter((p) => p.userId === where.userId && p.completed === where.completed).map((p) => ({ lessonId: p.lessonId }));
      },
    },
  };
  return fake as unknown as LessonAccessDb & QuizAccessDb;
}

const done = (lessonId: string, userId = STUDENT): Progress => ({ userId, lessonId, completed: true });

beforeEach(() => {
  calls = [];
  progress = [];
  quizzes = [
    { id: "mini_a1", type: "MINI", lessonId: "a1", courseId: null },
    { id: "mini_b1", type: "MINI", lessonId: "b1", courseId: null },
    { id: "final_a", type: "FINAL", lessonId: null, courseId: "course_a" },
    { id: "final_b", type: "FINAL", lessonId: null, courseId: "course_b" },
    { id: "final_c", type: "FINAL", lessonId: null, courseId: "course_c" },
  ];
  courses = [
    { id: "course_a", order: 1, lessons: ["a1", "a2"] },
    { id: "course_b", order: 2, lessons: ["b1", "b2"] },
    { id: "course_c", order: 3, lessons: ["c1"] },
  ];
});

describe("lessonAccessFor", () => {
  it("レッスンがなければ not_found で、コースと進捗を読まない", async () => {
    assert.equal(await lessonAccessFor(makeDb(), STUDENT, "missing"), "not_found");
    assert.deepEqual(calls.map((c) => c.method), ["lesson.findUnique"]);
  });

  it("最初のコースのレッスンは、何も終えていなくても ok", async () => {
    assert.equal(await lessonAccessFor(makeDb(), STUDENT, "a1"), "ok");
  });

  it("前のコースが未完了で未着手のコースは locked", async () => {
    progress = [done("a1")];
    assert.equal(await lessonAccessFor(makeDb(), STUDENT, "b1"), "locked");
    assert.equal(await lessonAccessFor(makeDb(), STUDENT, "c1"), "locked");
  });

  it("前のコースを全部終えれば次のコースは ok（その次は locked のまま）", async () => {
    progress = [done("a1"), done("a2")];
    assert.equal(await lessonAccessFor(makeDb(), STUDENT, "b2"), "ok");
    assert.equal(await lessonAccessFor(makeDb(), STUDENT, "c1"), "locked");
  });

  it("前のコースが未完了でも、このコースに完了が 1 件あれば ok", async () => {
    progress = [done("b1")];
    assert.equal(await lessonAccessFor(makeDb(), STUDENT, "b2"), "ok");
  });

  it("他の受講生の進捗は使わない", async () => {
    progress = [done("a1", "stu_other"), done("a2", "stu_other")];
    assert.equal(await lessonAccessFor(makeDb(), STUDENT, "b1"), "locked");
  });

  it("並びは order の順（配列の順ではない）", async () => {
    courses = [
      { id: "course_b", order: 2, lessons: ["b1"] },
      { id: "course_a", order: 1, lessons: ["a1"] },
    ];
    assert.equal(await lessonAccessFor(makeDb(), STUDENT, "a1"), "ok");
    assert.equal(await lessonAccessFor(makeDb(), STUDENT, "b1"), "locked");
  });

  it("読む項目と条件は必要な分だけ", async () => {
    await lessonAccessFor(makeDb(), STUDENT, "b1");
    assert.deepEqual(calls[0].args, { where: { id: "b1" }, select: { section: { select: { courseId: true } } } });
    const course = calls.find((c) => c.method === "course.findMany");
    assert.ok(course, "course.findMany が呼ばれていない");
    assert.equal(course.args.orderBy, COURSE_ORDER_BY, "orderBy が共通の定数 COURSE_ORDER_BY（同じ参照）でない");
    assert.deepEqual(course.args, {
      orderBy: [{ order: "asc" }, { id: "asc" }],
      select: { id: true, sections: { select: { lessons: { select: { id: true } } } } },
    });
    const prog = calls.find((c) => c.method === "progress.findMany");
    assert.ok(prog, "progress.findMany が呼ばれていない");
    assert.deepEqual(prog.args, { where: { userId: STUDENT, completed: true }, select: { lessonId: true } });
  });
});

describe("unlockedCourseIdsFor（#47 P4）", () => {
  it("何も終えていなければ最初のコースだけ", async () => {
    assert.deepEqual(await unlockedCourseIdsFor(makeDb(), STUDENT), ["course_a"]);
  });

  it("前のコースを全部終えれば次のコースも、完了が 1 件あるコースも解放（表示順）", async () => {
    progress = [done("a1"), done("a2"), done("c1")];
    assert.deepEqual(await unlockedCourseIdsFor(makeDb(), STUDENT), ["course_a", "course_b", "course_c"]);
  });

  it("レッスンを読まず、コースは COURSE_ORDER_BY で並べ、進捗は自分の完了だけを読む", async () => {
    await unlockedCourseIdsFor(makeDb(), STUDENT);
    assert.deepEqual(calls.map((c) => c.method).sort(), ["course.findMany", "progress.findMany"]);
    const course = calls.find((c) => c.method === "course.findMany");
    assert.ok(course, "course.findMany が呼ばれていない");
    assert.equal(course.args.orderBy, COURSE_ORDER_BY, "orderBy が COURSE_ORDER_BY でない");
    const prog = calls.find((c) => c.method === "progress.findMany");
    assert.ok(prog, "progress.findMany が呼ばれていない");
    assert.deepEqual(prog.args.where, { userId: STUDENT, completed: true });
  });
});

describe("courseAccessFor（#47 P4）", () => {
  it("コースがなければ not_found（レッスンは読まない）", async () => {
    assert.equal(await courseAccessFor(makeDb(), STUDENT, "course_missing"), "not_found");
    assert.ok(!calls.some((c) => c.method.startsWith("lesson.")), "レッスンを読んでいる");
  });

  it("最初のコースは ok、前のコースが未完了で未着手のコースは locked", async () => {
    progress = [done("a1")];
    assert.equal(await courseAccessFor(makeDb(), STUDENT, "course_a"), "ok");
    assert.equal(await courseAccessFor(makeDb(), STUDENT, "course_b"), "locked");
    assert.equal(await courseAccessFor(makeDb(), STUDENT, "course_c"), "locked");
  });

  it("前のコースを全部終えれば ok、このコースに完了が 1 件あっても ok", async () => {
    progress = [done("a1"), done("a2"), done("c1")];
    assert.equal(await courseAccessFor(makeDb(), STUDENT, "course_b"), "ok");
    assert.equal(await courseAccessFor(makeDb(), STUDENT, "course_c"), "ok");
  });

  it("他の受講生の進捗は使わない", async () => {
    progress = [done("a1", "stu_other"), done("a2", "stu_other")];
    assert.equal(await courseAccessFor(makeDb(), STUDENT, "course_b"), "locked");
  });
});

describe("quizAccessFor（#47 P5）", () => {
  it("クイズがなければ not_found で、コースと進捗を読まない", async () => {
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "quiz_missing"), "not_found");
    assert.deepEqual(calls.map((c) => c.method), ["quiz.findUnique"]);
  });

  it("レッスンにもコースにも属さないクイズは not_found で、コースと進捗を読まない", async () => {
    quizzes.push({ id: "orphan", type: "FINAL", lessonId: null, courseId: null });
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "orphan"), "not_found");
    assert.deepEqual(calls.map((c) => c.method), ["quiz.findUnique"]);
  });

  it("courseId のコースがなければ not_found", async () => {
    quizzes.push({ id: "final_gone", type: "FINAL", lessonId: null, courseId: "course_missing" });
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "final_gone"), "not_found");
  });

  it("修了テストは courseId のコース、ミニテストはレッスンのコースのロックに従う", async () => {
    progress = [done("a1")];
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "final_a"), "ok");
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "mini_a1"), "ok");
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "final_b"), "locked");
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "mini_b1"), "locked");
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "final_c"), "locked");
  });

  it("前のコースを全部終えれば次のコースのクイズは ok", async () => {
    progress = [done("a1"), done("a2")];
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "final_b"), "ok");
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "mini_b1"), "ok");
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "final_c"), "locked");
  });

  it("コースは一覧と同じく種類で決める（FINAL は courseId だけ、MINI はレッスンのコースだけを見る）", async () => {
    quizzes.push({ id: "final_lesson_b_course_a", type: "FINAL", lessonId: "b1", courseId: "course_a" });
    quizzes.push({ id: "final_lesson_a_course_c", type: "FINAL", lessonId: "a1", courseId: "course_c" });
    quizzes.push({ id: "mini_lesson_b_course_a", type: "MINI", lessonId: "b1", courseId: "course_a" });
    quizzes.push({ id: "mini_lesson_a_course_c", type: "MINI", lessonId: "a1", courseId: "course_c" });
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "final_lesson_b_course_a"), "ok");
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "final_lesson_a_course_c"), "locked");
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "mini_lesson_b_course_a"), "locked");
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "mini_lesson_a_course_c"), "ok");
  });

  it("courseId のない FINAL・レッスンのない MINI は not_found で、コースと進捗を読まない", async () => {
    quizzes.push({ id: "final_lesson_only", type: "FINAL", lessonId: "a1", courseId: null });
    quizzes.push({ id: "mini_course_only", type: "MINI", lessonId: null, courseId: "course_a" });
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "final_lesson_only"), "not_found");
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "mini_course_only"), "not_found");
    assert.deepEqual(calls.map((c) => c.method), ["quiz.findUnique", "quiz.findUnique"]);
  });

  it("他の受講生の進捗は使わない", async () => {
    progress = [done("a1", "stu_other"), done("a2", "stu_other")];
    assert.equal(await quizAccessFor(makeDb(), STUDENT, "final_b"), "locked");
  });

  it("クイズはコースを決める列だけを読む（問題・選択肢・正解・受験記録は読まない）", async () => {
    await quizAccessFor(makeDb(), STUDENT, "final_b");
    assert.deepEqual(calls[0].args, {
      where: { id: "final_b" },
      select: { type: true, courseId: true, lesson: { select: { section: { select: { courseId: true } } } } },
    });
    assert.doesNotMatch(JSON.stringify(calls[0].args), /questions|options|correctIndex|attempts/, "クイズの中身を読んでいる");
    assert.ok(!calls.some((c) => c.method.startsWith("lesson.")), "レッスンを別に読んでいる");
    const course = calls.find((c) => c.method === "course.findMany");
    assert.ok(course, "course.findMany が呼ばれていない");
    assert.equal(course.args.orderBy, COURSE_ORDER_BY, "orderBy が COURSE_ORDER_BY でない");
  });
});

describe("hideLockedLessonContent・COURSE_LOCKED_REASON（#47 P4）", () => {
  it("残す項目だけにし、videoUrl・content・pdfUrl を除く（元のオブジェクトは変えない）", () => {
    const lesson = {
      id: "l1",
      sectionId: "s1",
      title: "ダミー",
      type: "VIDEO",
      videoUrl: "https://example.com/v",
      content: "ダミー本文",
      pdfUrl: "https://example.com/p.pdf",
      duration: "10:00",
      order: 1,
      completed: false,
    };
    const out = hideLockedLessonContent(lesson);
    assert.deepEqual(out, { id: "l1", sectionId: "s1", title: "ダミー", type: "VIDEO", duration: "10:00", order: 1, completed: false });
    assert.equal(lesson.videoUrl, "https://example.com/v", "元のオブジェクトが変わった");
  });

  it("値が null でも項目ごと除く", () => {
    const out = hideLockedLessonContent({ id: "l1", videoUrl: null, content: null, pdfUrl: null });
    assert.deepEqual(Object.keys(out), ["id"]);
  });

  it("一覧にない項目（将来 Lesson に足す本文系の列など）は出さない（許可リスト）", () => {
    const out = hideLockedLessonContent({ id: "l1", completed: true, transcript: "ダミー書き起こし", attachmentUrl: "https://example.com/a" });
    assert.deepEqual(out, { id: "l1", completed: true });
  });

  it("残す項目と理由の値", () => {
    assert.deepEqual([...LOCKED_LESSON_VISIBLE_FIELDS], ["id", "sectionId", "title", "type", "duration", "order", "completed"]);
    assert.equal(COURSE_LOCKED_REASON, "course_locked");
  });
});
