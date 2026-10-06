import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countCourseLessons, isCourseLocked } from "./course-lock";

// #32 コースのロック表示（ダッシュボードのカリキュラム欄とコース一覧で共通）

const c = (completedLessons: number, totalLessons: number) => ({ completedLessons, totalLessons });

describe("isCourseLocked", () => {
  it("最初のコース（prev が null）はロックしない", () => {
    assert.equal(isCourseLocked(null, c(0, 10)), false);
    assert.equal(isCourseLocked(null, c(0, 0)), false);
  });

  it("前のコースが未完了で、このコースが未着手ならロック", () => {
    assert.equal(isCourseLocked(c(0, 10), c(0, 5)), true);
    assert.equal(isCourseLocked(c(9, 10), c(0, 5)), true);
    // 299/300 は % では 100 と表示されるが未完了
    assert.equal(isCourseLocked(c(299, 300), c(0, 5)), true);
  });

  it("前のコースにレッスンがない場合も未完了とみなしてロック", () => {
    assert.equal(isCourseLocked(c(0, 0), c(0, 5)), true);
    assert.equal(isCourseLocked(c(0, 0), c(0, 0)), true);
  });

  it("前のコースを全部終えていればロックしない", () => {
    assert.equal(isCourseLocked(c(10, 10), c(0, 5)), false);
    assert.equal(isCourseLocked(c(1, 1), c(0, 0)), false);
  });

  it("このコースに完了が 1 件でもあればロックしない（前のコースが未完了でも）", () => {
    assert.equal(isCourseLocked(c(0, 10), c(1, 5)), false);
    // 1/300 は % では 0 と表示されるが着手済み
    assert.equal(isCourseLocked(c(0, 10), c(1, 300)), false);
    assert.equal(isCourseLocked(c(0, 0), c(5, 5)), false);
  });
});

describe("countCourseLessons", () => {
  it("sections → lessons の completed を数える", () => {
    assert.deepEqual(
      countCourseLessons({
        sections: [
          { lessons: [{ completed: true }, { completed: false }, { completed: true }] },
          { lessons: [] },
          { lessons: [{ completed: false }] },
        ],
      }),
      c(2, 4)
    );
  });

  it("completed が true のものだけを完了とする", () => {
    assert.deepEqual(
      countCourseLessons({ sections: [{ lessons: [{ completed: "true" }, { completed: 1 }, {}, { completed: true }] }] }),
      c(1, 4)
    );
  });

  it("sections・lessons が無い・配列でない場合は 0 件として扱う", () => {
    assert.deepEqual(countCourseLessons(null), c(0, 0));
    assert.deepEqual(countCourseLessons(undefined), c(0, 0));
    assert.deepEqual(countCourseLessons({}), c(0, 0));
    assert.deepEqual(countCourseLessons({ sections: null }), c(0, 0));
    assert.deepEqual(countCourseLessons({ sections: [null, { lessons: null }, {}] }), c(0, 0));
  });

  it("null のレッスンは総数に数え、完了には数えない", () => {
    assert.deepEqual(countCourseLessons({ sections: [{ lessons: [null, { completed: true }] }] }), c(1, 2));
  });
});
