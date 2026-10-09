import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { currentCourseOf, lessonIdsOf, type CourseLessonTree } from "./student-current-course";

// #32 QA-2：現在のコース = 並び順で全レッスンを終えていない最初のコース。データはすべてダミー。

const course = (id: string, lessonIdsBySection: string[][]): CourseLessonTree => ({
  id,
  name: `${id.toUpperCase()} ダミー`,
  sections: lessonIdsBySection.map((ids) => ({ lessons: ids.map((lid) => ({ id: lid })) })),
});

const COURSES = [
  course("s1", [["l1", "l2"], ["l3"]]),
  course("empty", []),
  course("emptySections", [[], []]),
  course("s2", [["l4"]]),
  course("s3", [["l5", "l6"]]),
];

describe("lessonIdsOf", () => {
  it("sections と lessons の順のまま id を並べる", () => {
    assert.deepEqual(lessonIdsOf(COURSES[0]), ["l1", "l2", "l3"]);
    assert.deepEqual(lessonIdsOf(COURSES[1]), []);
    assert.deepEqual(lessonIdsOf(COURSES[2]), []);
  });
});

describe("currentCourseOf", () => {
  it("進捗がなければ最初のコース", () => {
    assert.deepEqual(currentCourseOf(COURSES, new Set()), { id: "s1", name: "S1 ダミー" });
  });

  it("途中まで終えたコースはそのコースのまま", () => {
    assert.deepEqual(currentCourseOf(COURSES, new Set(["l1", "l3"])), { id: "s1", name: "S1 ダミー" });
  });

  it("全レッスンを終えたコースは次へ。レッスン 0 件のコースは飛ばす", () => {
    assert.deepEqual(currentCourseOf(COURSES, new Set(["l1", "l2", "l3"])), { id: "s2", name: "S2 ダミー" });
  });

  it("後ろのコースだけ終えていても、前のコースが残っていれば前のコース", () => {
    assert.deepEqual(currentCourseOf(COURSES, new Set(["l4", "l5", "l6"])), { id: "s1", name: "S1 ダミー" });
  });

  it("すべて終えていれば null（全コース修了）", () => {
    assert.equal(currentCourseOf(COURSES, new Set(["l1", "l2", "l3", "l4", "l5", "l6"])), null);
  });

  it("ほかのコースの id が混ざっていても影響しない", () => {
    assert.deepEqual(currentCourseOf(COURSES, new Set(["l1", "l2", "l3", "x9"])), { id: "s2", name: "S2 ダミー" });
  });

  it("コースがない・レッスンのあるコースがないときは null", () => {
    assert.equal(currentCourseOf([], new Set()), null);
    assert.equal(currentCourseOf([COURSES[1], COURSES[2]], new Set()), null);
  });

  it("渡された順に見る（並べ替えない）", () => {
    const reversed = [COURSES[4], COURSES[3], COURSES[0]];
    assert.deepEqual(currentCourseOf(reversed, new Set()), { id: "s3", name: "S3 ダミー" });
  });

  it("返すのは id と name だけ", () => {
    const withExtra = [{ ...course("s9", [["z1"]]), color: "#000", description: "x" }];
    const got = currentCourseOf(withExtra, new Set());
    assert.ok(got !== null, "コースが返っていない");
    assert.deepEqual(Object.keys(got).sort(), ["id", "name"]);
  });
});
