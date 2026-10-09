import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { currentCourseOf, type CourseLessonTree } from "./student-current-course";
import { countCourseLessons, isCourseLocked } from "./course-lock";
import { summarizeCourses } from "./student-dashboard";

// #32 QA-2 の境界：レッスン 0 件のコースの位置、並び順の同値、入力を変えないこと、
// course-lock・student-dashboard の数え方との整合。データはすべてダミー。

const course = (id: string, lessonIdsBySection: string[][]): CourseLessonTree => ({
  id,
  name: `${id} ダミー`,
  sections: lessonIdsBySection.map((ids) => ({ lessons: ids.map((lid) => ({ id: lid })) })),
});

const id = (c: { id: string } | null) => (c === null ? null : c.id);

describe("currentCourseOf：レッスン 0 件のコースの位置", () => {
  const A = course("a", [["a1", "a2"]]);
  const B = course("b", [["b1"]]);
  const E1 = course("e1", []);
  const E2 = course("e2", [[], []]);

  it("先頭が空：飛ばして次のコース", () => {
    assert.equal(id(currentCourseOf([E1, A, B], new Set())), "a");
  });

  it("途中が空：前のコースを終えたら、空を飛ばして次のコース", () => {
    assert.equal(id(currentCourseOf([A, E2, B], new Set(["a1", "a2"]))), "b");
  });

  it("末尾が空：前のコースを全部終えたら null（空のコースは現在のコースにならない）", () => {
    assert.equal(currentCourseOf([A, B, E1], new Set(["a1", "a2", "b1"])), null);
  });

  it("空のセクションと中身のあるセクションが混ざったコースは、中身のレッスンで判定する", () => {
    const mixed = course("m", [[], ["m1"], []]);
    assert.equal(id(currentCourseOf([mixed], new Set())), "m");
    assert.equal(currentCourseOf([mixed], new Set(["m1"])), null);
  });

  it("空のコースだけなら null（画面では「—」。currentCourseLabel のテスト参照）", () => {
    assert.equal(currentCourseOf([E1, E2], new Set(["x"])), null);
  });
});

describe("currentCourseOf：完了の扱い", () => {
  const A = course("a", [["a1", "a2"]]);
  const B = course("b", [["b1", "b2"]]);

  it("他のコースのレッスンだけ完了：先頭のコースのまま", () => {
    assert.equal(id(currentCourseOf([A, B], new Set(["b1", "b2"]))), "a");
  });

  it("1 件だけ残っていても、そのコースが現在のコース", () => {
    assert.equal(id(currentCourseOf([A, B], new Set(["a1", "a2", "b1"]))), "b");
  });

  it("完了 id の大文字小文字・前後の空白は区別する（id は正規化しない）", () => {
    assert.equal(id(currentCourseOf([A], new Set(["A1", "a2", " a1"]))), "a");
  });

  it("同じ id が 2 つのコースにある異常データ：両方で完了とみなす（落ちない）", () => {
    const X = course("x", [["dup"]]);
    const Y = course("y", [["dup", "y2"]]);
    assert.equal(id(currentCourseOf([X, Y], new Set(["dup"]))), "y");
  });

  it("入力（courses と Set）を書き換えない", () => {
    const courses = [A, B];
    const done = new Set(["a1"]);
    const before = JSON.stringify(courses);
    currentCourseOf(courses, done);
    assert.equal(JSON.stringify(courses), before);
    assert.deepEqual(Array.from(done), ["a1"]);
  });
});

describe("currentCourseOf：並び順", () => {
  it("order が同じコースは、渡された順（DB の orderBy の結果）のまま見る", () => {
    const P = { ...course("p", [["p1"]]), order: 1 };
    const Q = { ...course("q", [["q1"]]), order: 1 };
    assert.equal(id(currentCourseOf([P, Q], new Set())), "p");
    assert.equal(id(currentCourseOf([Q, P], new Set())), "q");
  });
});

// 小さな乱数（再現できるよう固定の種）
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomCase(r: () => number, allowEmpty: boolean) {
  const n = 1 + Math.floor(r() * 5);
  const courses: CourseLessonTree[] = [];
  const done = new Set<string>();
  for (let c = 0; c < n; c++) {
    const sections: string[][] = [];
    const ns = Math.floor(r() * 3) + (allowEmpty ? 0 : 1);
    for (let s = 0; s < ns; s++) {
      const nl = Math.floor(r() * 3) + (allowEmpty ? 0 : 1);
      const ids: string[] = [];
      for (let l = 0; l < nl; l++) {
        const lid = `c${c}s${s}l${l}`;
        ids.push(lid);
        if (r() < 0.6) done.add(lid);
      }
      sections.push(ids);
    }
    courses.push(course(`c${c}`, sections));
  }
  return { courses, done };
}

/** course-lock の countCourseLessons の形（各レッスンに completed）に変える */
const withCompleted = (c: CourseLessonTree, done: ReadonlySet<string>) => ({
  sections: c.sections.map((s) => ({ lessons: s.lessons.map((l) => ({ completed: done.has(l.id) })) })),
});

describe("currentCourseOf：course-lock・student-dashboard の数え方との整合（乱数 500 件）", () => {
  it("現在のコース = countCourseLessons で「レッスンがあり全部は終えていない」最初のコース", () => {
    const r = rng(32);
    for (let i = 0; i < 500; i++) {
      const { courses, done } = randomCase(r, true);
      const expected =
        courses.find((c) => {
          const n = countCourseLessons(withCompleted(c, done));
          return n.totalLessons > 0 && n.completedLessons < n.totalLessons;
        }) ?? null;
      assert.equal(id(currentCourseOf(courses, done)), id(expected), JSON.stringify({ courses, done: Array.from(done) }));
    }
  });

  it("summarizeCourses の件数でも同じ（受講生ダッシュボードと同じ数え方）", () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const { courses, done } = randomCase(r, true);
      const nodes = courses.map((c, order) => ({
        id: c.id,
        name: c.name,
        icon: "",
        color: "",
        order,
        sections: c.sections.map((s, so) => ({ id: `${c.id}-${so}`, order: so, lessons: s.lessons.map((l, lo) => ({ id: l.id, title: l.id, order: lo })) })),
      }));
      const summary = summarizeCourses(nodes, done);
      const expected = summary.courses.find((c) => c.totalLessons > 0 && c.completedLessons < c.totalLessons) ?? null;
      assert.equal(id(currentCourseOf(courses, done)), id(expected), JSON.stringify({ courses, done: Array.from(done) }));
    }
  });

  it("空のコースがなければ、現在のコースは受講生側でロックされていない（前のコースをすべて終えている）", () => {
    const r = rng(99);
    for (let i = 0; i < 500; i++) {
      const { courses, done } = randomCase(r, false);
      const current = currentCourseOf(courses, done);
      if (current === null) continue;
      const idx = courses.findIndex((c) => c.id === current.id);
      const prev = idx > 0 ? countCourseLessons(withCompleted(courses[idx - 1], done)) : null;
      const cur = countCourseLessons(withCompleted(courses[idx], done));
      assert.equal(isCourseLocked(prev, cur), false, JSON.stringify({ courses, done: Array.from(done), current }));
    }
  });
});
