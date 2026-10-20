import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCourseGates, unlockedCourseIdsOf, type CourseGateCourse } from "./course-gate";
import { isCourseLocked, type LessonCounts } from "./course-lock";

// #78 PR A コースのロックの判定（course-gate.ts）。今の規則（course-lock の isCourseLocked）と同じ結果になることを確かめる。
// DB なし。データはすべてダミー。

const course = (id: string, lessonIds: string[][]): CourseGateCourse => ({
  id,
  sections: lessonIds.map((ls) => ({ lessons: ls.map((l) => ({ id: l })) })),
});

const lockedOf = (courses: CourseGateCourse[], done: string[]) =>
  computeCourseGates({ courses, completedLessonIds: new Set(done) }).map((g) => [g.courseId, g.locked]);

describe("computeCourseGates（今の規則）", () => {
  const courses = [course("c1", [["l1", "l2"]]), course("c2", [["l3"], ["l4"]]), course("c3", [["l5"]])];

  it("何も終えていなければ最初のコースだけ開いている", () => {
    assert.deepEqual(lockedOf(courses, []), [["c1", false], ["c2", true], ["c3", true]]);
  });

  it("前のコースを全部終えれば次が開く", () => {
    assert.deepEqual(lockedOf(courses, ["l1", "l2"]), [["c1", false], ["c2", false], ["c3", true]]);
  });

  it("前のコースが途中でも、このコースを 1 件でも終えていれば開いている（開始済みは維持）", () => {
    assert.deepEqual(lockedOf(courses, ["l1", "l5"]), [["c1", false], ["c2", true], ["c3", false]]);
  });

  it("レッスンのない前のコースは終えたことにならない（#41 の扱いのまま）", () => {
    assert.deepEqual(lockedOf([course("c1", []), course("c2", [["l1"]])], []), [["c1", false], ["c2", true]]);
    assert.deepEqual(lockedOf([course("c1", [[]]), course("c2", [])], []), [["c1", false], ["c2", true]]);
  });

  it("最初のコースはレッスンがなくても開いている", () => {
    assert.deepEqual(lockedOf([course("c1", [])], []), [["c1", false]]);
  });

  it("どのコースにもない完了は数えない", () => {
    assert.deepEqual(lockedOf(courses, ["zzz"]), [["c1", false], ["c2", true], ["c3", true]]);
  });

  it("コースがなければ空", () => {
    assert.deepEqual(lockedOf([], ["l1"]), []);
  });

  it("unlockedCourseIdsOf は開いているコースの id を並びのまま返す", () => {
    const gates = computeCourseGates({ courses, completedLessonIds: new Set(["l1", "l5"]) });
    assert.deepEqual(unlockedCourseIdsOf(gates), ["c1", "c3"]);
    assert.deepEqual(unlockedCourseIdsOf([]), []);
  });
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

describe("computeCourseGates と isCourseLocked の照合（乱数）", () => {
  it("2000 通りのコース構成（レッスン 0 件のコース・空のセクション・どのコースにもない完了を含む）で全く同じ結果になる", () => {
    const rand = rng(78);
    const pick = (n: number) => Math.floor(rand() * n);
    let coursesChecked = 0;
    let lockedSeen = 0;
    let zeroLessonPrevSeen = 0;
    for (let trial = 0; trial < 2000; trial++) {
      const nCourses = pick(7); // 0〜6
      const courses: CourseGateCourse[] = [];
      const allLessons: string[] = [];
      for (let ci = 0; ci < nCourses; ci++) {
        const sections: string[][] = [];
        const nSections = pick(4); // 0〜3（0 ならレッスン 0 件のコース）
        for (let si = 0; si < nSections; si++) {
          const lessons = Array.from({ length: pick(4) }, (_, li) => `t${trial}_c${ci}_s${si}_l${li}`);
          sections.push(lessons);
          allLessons.push(...lessons);
        }
        courses.push(course(`t${trial}_course_${ci}`, sections));
      }
      // 完了の割合を試行ごとに変える（全部終えた・何もしていない、の両端も出す）
      const ratio = rand();
      const done = new Set(allLessons.filter(() => rand() < ratio));
      if (rand() < 0.3) done.add(`t${trial}_unknown`);

      // 期待値：今の規則（course-lock の isCourseLocked。画面が使っていた式と同じ）
      const expected: Array<[string, boolean]> = [];
      let prev: LessonCounts | null = null;
      for (const c of courses) {
        const lessons = c.sections.flatMap((s) => s.lessons.map((l) => l.id));
        const counts: LessonCounts = { totalLessons: lessons.length, completedLessons: lessons.filter((l) => done.has(l)).length };
        expected.push([c.id, isCourseLocked(prev, counts)]);
        if (prev !== null && prev.totalLessons === 0) zeroLessonPrevSeen++;
        prev = counts;
      }

      const gates = computeCourseGates({ courses, completedLessonIds: done });
      assert.deepEqual(
        gates.map((g) => [g.courseId, g.locked]),
        expected,
        `trial ${trial}: ${JSON.stringify({ courses, done: Array.from(done) })}`
      );
      assert.deepEqual(
        unlockedCourseIdsOf(gates),
        expected.filter(([, locked]) => !locked).map(([id]) => id),
        `trial ${trial}: unlockedCourseIdsOf が一致しない`
      );
      coursesChecked += expected.length;
      lockedSeen += expected.filter(([, locked]) => locked).length;
    }
    assert.ok(coursesChecked > 3000, `照合したコースが少ない: ${coursesChecked}`);
    assert.ok(lockedSeen > 0 && lockedSeen < coursesChecked, `locked と ok の両方を照合できていない: ${lockedSeen}/${coursesChecked}`);
    assert.ok(zeroLessonPrevSeen > 0, "前のコースのレッスンが 0 件の場面を照合できていない");
  });
});
