import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lessonAccessFor, type LessonAccessDb } from "./lesson-access";
import { isCourseLocked, type LessonCounts } from "./course-lock";

// #46 lessonAccessFor が course-lock.ts の isCourseLocked（画面のロック表示）と同じ判定になることを、
// 乱数（シード固定）で作ったコース・進捗で照合する。DB なし。データはすべてダミー。

type Course = { id: string; order: number; sections: string[][] };
type Progress = { userId: string; lessonId: string; completed: boolean };

const STUDENT = "stu_1";

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

function makeDb(courses: Course[], progress: Progress[]): LessonAccessDb {
  const sorted = () => [...courses].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const fake = {
    lesson: {
      async findUnique(args: { where: { id: string } }) {
        const c = courses.find((x) => x.sections.some((s) => s.includes(args.where.id)));
        return c ? { section: { courseId: c.id } } : null;
      },
    },
    course: {
      async findMany() {
        return sorted().map((c) => ({ id: c.id, sections: c.sections.map((s) => ({ lessons: s.map((id) => ({ id })) })) }));
      },
    },
    progress: {
      async findMany(args: { where: { userId: string; completed: boolean } }) {
        return progress.filter((p) => p.userId === args.where.userId && p.completed === args.where.completed).map((p) => ({ lessonId: p.lessonId }));
      },
    },
  };
  return fake as unknown as LessonAccessDb;
}

/** 期待値：order → id の順に並べ、直前のコースの件数と isCourseLocked で判定する */
function expectedLocked(courses: Course[], progress: Progress[]): Map<string, boolean> {
  const done = new Set(progress.filter((p) => p.userId === STUDENT && p.completed).map((p) => p.lessonId));
  const sorted = [...courses].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = new Map<string, boolean>();
  let prev: LessonCounts | null = null;
  for (const c of sorted) {
    const lessons = c.sections.flat();
    const counts = { totalLessons: lessons.length, completedLessons: lessons.filter((l) => done.has(l)).length };
    const locked = isCourseLocked(prev, counts);
    for (const l of lessons) out.set(l, locked);
    prev = counts;
  }
  return out;
}

describe("lessonAccessFor と isCourseLocked の照合（乱数）", () => {
  it("300 通りのコース構成（レッスン 0 件のコース・同じ order・他人の進捗・completed: false を含む）で一致する", async () => {
    const rand = rng(46);
    const pick = (n: number) => Math.floor(rand() * n);
    let checked = 0;
    let lockedSeen = 0;
    for (let trial = 0; trial < 300; trial++) {
      const nCourses = 1 + pick(5);
      const courses: Course[] = [];
      const allLessons: string[] = [];
      for (let ci = 0; ci < nCourses; ci++) {
        const sections: string[][] = [];
        const nSections = pick(3); // 0〜2（0 ならレッスン 0 件のコース）
        for (let si = 0; si < nSections; si++) {
          const lessons = Array.from({ length: pick(3) }, (_, li) => `t${trial}_c${ci}_s${si}_l${li}`);
          sections.push(lessons);
          allLessons.push(...lessons);
        }
        courses.push({ id: `t${trial}_course_${String.fromCharCode(97 + pick(26))}${ci}`, order: pick(3), sections });
      }
      const progress: Progress[] = [];
      for (const l of allLessons) {
        const r = rand();
        if (r < 0.4) progress.push({ userId: STUDENT, lessonId: l, completed: true });
        else if (r < 0.5) progress.push({ userId: STUDENT, lessonId: l, completed: false });
        else if (r < 0.7) progress.push({ userId: "stu_other", lessonId: l, completed: true });
      }
      const expected = expectedLocked(courses, progress);
      const db = makeDb(courses, progress);
      for (const l of allLessons) {
        const actual = await lessonAccessFor(db, STUDENT, l);
        const want = expected.get(l) ? "locked" : "ok";
        assert.equal(actual, want, `trial ${trial} lesson ${l}: ${JSON.stringify({ courses, progress })}`);
        checked++;
        if (want === "locked") lockedSeen++;
      }
      assert.equal(await lessonAccessFor(db, STUDENT, `t${trial}_missing`), "not_found");
    }
    assert.ok(checked > 300, `照合したレッスンが少ない: ${checked}`);
    assert.ok(lockedSeen > 0 && lockedSeen < checked, `locked と ok の両方を照合できていない: ${lockedSeen}/${checked}`);
  });
});
