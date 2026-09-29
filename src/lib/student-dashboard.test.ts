import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countCompletedSince,
  pickActiveCourse,
  pickNextLessons,
  relativeTimeJa,
  summarizeCourses,
  toActivityItems,
  toNewsItems,
  type CourseNode,
} from "./student-dashboard";

// #32 受講生ダッシュボードの純粋関数。DB・ネットワーク・現在時刻に依存しない（now は固定）。

const NOW = new Date("2026-09-29T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("relativeTimeJa", () => {
  it("1 分未満は「たった今」", () => {
    assert.equal(relativeTimeJa(NOW, NOW), "たった今");
    assert.equal(relativeTimeJa(ago(59 * SEC), NOW), "たった今");
  });

  it("分・時間・日の境界（切り捨て）", () => {
    assert.equal(relativeTimeJa(ago(1 * MIN), NOW), "1分前");
    assert.equal(relativeTimeJa(ago(59 * MIN + 59 * SEC), NOW), "59分前");
    assert.equal(relativeTimeJa(ago(1 * HOUR), NOW), "1時間前");
    assert.equal(relativeTimeJa(ago(23 * HOUR + 59 * MIN), NOW), "23時間前");
    assert.equal(relativeTimeJa(ago(1 * DAY), NOW), "1日前");
    assert.equal(relativeTimeJa(ago(30 * DAY + 5 * HOUR), NOW), "30日前");
  });

  it("未来の時刻は「たった今」", () => {
    assert.equal(relativeTimeJa(new Date(NOW.getTime() + 5 * MIN), NOW), "たった今");
    assert.equal(relativeTimeJa(new Date(NOW.getTime() + 3 * DAY), NOW), "たった今");
  });

  it("ISO 文字列（API の JSON）も受け付ける", () => {
    assert.equal(relativeTimeJa(ago(2 * HOUR).toISOString(), NOW), "2時間前");
  });

  it("null・undefined・空文字・不正な値は空文字", () => {
    assert.equal(relativeTimeJa(null, NOW), "");
    assert.equal(relativeTimeJa(undefined, NOW), "");
    assert.equal(relativeTimeJa("", NOW), "");
    assert.equal(relativeTimeJa("not-a-date", NOW), "");
    assert.equal(relativeTimeJa(new Date(NaN), NOW), "");
    assert.equal(relativeTimeJa(NOW, new Date(NaN)), "");
  });
});

// セクション・レッスンはわざと order 逆順で並べ、関数側で並べ替えることを確かめる
function course(id: string, sections: Array<[order: number, lessons: Array<[id: string, order: number]>]>): CourseNode {
  return {
    id,
    name: `コース ${id}`,
    icon: "html",
    color: "#000000",
    order: 0,
    sections: sections.map(([order, lessons], i) => ({
      id: `${id}_s${i}`,
      order,
      lessons: lessons.map(([lid, lorder]) => ({ id: lid, title: `レッスン ${lid}`, order: lorder })),
    })),
  };
}

const C1 = course("c1", [
  [2, [["c1_b2", 2], ["c1_b1", 1]]],
  [1, [["c1_a2", 2], ["c1_a1", 1]]],
]);
const C2 = course("c2", [
  [1, [["c2_a1", 1], ["c2_a2", 2], ["c2_a3", 3], ["c2_a4", 4], ["c2_a5", 5]]],
]);
const EMPTY = course("c0", []);

describe("summarizeCourses", () => {
  it("コースごとの件数・進度と、全体の集計", () => {
    const s = summarizeCourses([C1, C2], new Set(["c1_a1", "c2_a1", "c2_a2"]));
    assert.deepEqual(
      s.courses.map((c) => [c.id, c.completedLessons, c.totalLessons, c.progress]),
      [
        ["c1", 1, 4, 25],
        ["c2", 2, 5, 40],
      ]
    );
    assert.equal(s.activeCourses, 2);
    assert.equal(s.completedLessons, 3);
    assert.equal(s.totalLessons, 9);
    assert.equal(s.overallProgress, 33);
    // sections は返さない
    assert.ok(!("sections" in s.courses[0]));
  });

  it("コース 0 件・レッスン 0 件でも 0 を返す（0 除算しない）", () => {
    assert.deepEqual(summarizeCourses([], new Set()), {
      courses: [],
      activeCourses: 0,
      completedLessons: 0,
      totalLessons: 0,
      overallProgress: 0,
    });
    const s = summarizeCourses([EMPTY], new Set());
    assert.equal(s.courses[0].progress, 0);
    assert.equal(s.activeCourses, 0);
  });

  it("全部完了したコースは受講中に数えない", () => {
    const s = summarizeCourses([C1], new Set(["c1_a1", "c1_a2", "c1_b1", "c1_b2"]));
    assert.equal(s.courses[0].progress, 100);
    assert.equal(s.activeCourses, 0);
  });
});

describe("pickActiveCourse", () => {
  it("受講中のコースを選ぶ。なければ最初のコース、0 件なら null", () => {
    const a = { id: "a", completedLessons: 0, totalLessons: 3 };
    const b = { id: "b", completedLessons: 1, totalLessons: 3 };
    const done = { id: "d", completedLessons: 3, totalLessons: 3 };
    assert.equal(pickActiveCourse([a, b]), b);
    assert.equal(pickActiveCourse([done, a]), done);
    assert.equal(pickActiveCourse([]), null);
  });

  it("丸めで 0% / 100% と表示されても件数で受講中と判定する", () => {
    const almost = { id: "x", completedLessons: 299, totalLessons: 300 };
    assert.equal(pickActiveCourse([{ id: "a", completedLessons: 0, totalLessons: 1 }, almost]), almost);
  });
});

describe("pickNextLessons", () => {
  it("受講中のコースの未完了レッスンを、セクション順・レッスン順に最大 3 件", () => {
    const next = pickNextLessons([C1, C2], new Set(["c2_a2"]));
    assert.deepEqual(
      next.map((n) => n.lessonId),
      ["c2_a1", "c2_a3", "c2_a4"]
    );
    assert.deepEqual(next[0], { lessonId: "c2_a1", title: "レッスン c2_a1", courseId: "c2", courseName: "コース c2" });
  });

  it("セクションの order、次にレッスンの order で並べる（配列の順ではない）", () => {
    const next = pickNextLessons([C1], new Set(["c1_a1"]));
    assert.deepEqual(
      next.map((n) => n.lessonId),
      ["c1_a2", "c1_b1", "c1_b2"]
    );
  });

  it("同じ order は id で並べる", () => {
    const tie = course("t", [[1, [["t_b", 1], ["t_a", 1], ["t_c", 1]]]]);
    assert.deepEqual(
      pickNextLessons([tie], new Set()).map((n) => n.lessonId),
      ["t_a", "t_b", "t_c"]
    );
  });

  it("受講中のコースがなければ最初のコースから", () => {
    const next = pickNextLessons([C1, C2], new Set());
    assert.deepEqual(
      next.map((n) => n.lessonId),
      ["c1_a1", "c1_a2", "c1_b1"]
    );
  });

  it("3 件未満ならあるだけ返す", () => {
    const next = pickNextLessons([C1], new Set(["c1_a1", "c1_a2", "c1_b1"]));
    assert.deepEqual(
      next.map((n) => n.lessonId),
      ["c1_b2"]
    );
  });

  it("選ばれたコースが全部完了なら空（受講中のコースがなく最初のコースが完了済み）", () => {
    const next = pickNextLessons([C1, C2], new Set(["c1_a1", "c1_a2", "c1_b1", "c1_b2"]));
    assert.deepEqual(next, []);
  });

  it("コース 0 件・レッスン 0 件・limit 0 は空", () => {
    assert.deepEqual(pickNextLessons([], new Set()), []);
    assert.deepEqual(pickNextLessons([EMPTY], new Set()), []);
    assert.deepEqual(pickNextLessons([C1], new Set(), 0), []);
  });

  it("入力の配列を並べ替えない", () => {
    const before = JSON.stringify(C1);
    pickNextLessons([C1], new Set());
    assert.equal(JSON.stringify(C1), before);
  });
});

describe("countCompletedSince（直近 7 日）", () => {
  it("ちょうど 7 日前は含み、それより 1ms 古いものは含まない", () => {
    const rows = [
      { completed: true, completedAt: ago(7 * DAY) },
      { completed: true, completedAt: ago(7 * DAY + 1) },
    ];
    assert.equal(countCompletedSince(rows, NOW), 1);
  });

  it("暦週ではなく now から遡る 7 日", () => {
    // NOW は火曜。前週の木曜（5 日前）も含む
    const rows = [{ completed: true, completedAt: ago(5 * DAY) }];
    assert.equal(countCompletedSince(rows, NOW), 1);
  });

  it("未完了・completedAt が null・不正な値は数えない", () => {
    const rows = [
      { completed: false, completedAt: ago(HOUR) },
      { completed: true, completedAt: null },
      { completed: true, completedAt: "bad" },
      { completed: true, completedAt: ago(HOUR).toISOString() },
      { completed: true, completedAt: NOW },
    ];
    assert.equal(countCompletedSince(rows, NOW), 2);
  });

  it("空配列は 0", () => {
    assert.equal(countCompletedSince([], NOW), 0);
  });
});

describe("toActivityItems", () => {
  it("「コース名 - レッスン名」と相対時刻", () => {
    const items = toActivityItems(
      [
        { lessonTitle: "L2", courseName: "STEP2", completedAt: ago(3 * MIN).toISOString() },
        { lessonTitle: "L1", courseName: "STEP1", completedAt: ago(2 * DAY).toISOString() },
      ],
      NOW
    );
    assert.deepEqual(items, [
      { text: "STEP2 - L2", time: "3分前" },
      { text: "STEP1 - L1", time: "2日前" },
    ]);
  });

  it("空配列・null・undefined は空配列", () => {
    assert.deepEqual(toActivityItems([], NOW), []);
    assert.deepEqual(toActivityItems(null, NOW), []);
    assert.deepEqual(toActivityItems(undefined, NOW), []);
  });

  it("completedAt が null なら時刻は空文字", () => {
    assert.equal(toActivityItems([{ lessonTitle: "L", courseName: "C", completedAt: null }], NOW)[0].time, "");
  });
});

describe("toNewsItems", () => {
  it("タイトルと本文をそのまま使い、未読フラグと相対時刻を付ける", () => {
    const items = toNewsItems(
      [
        { id: "n1", title: "山田先生が回答しました", message: "本文1", read: false, createdAt: ago(5 * HOUR).toISOString() },
        { id: "n2", title: "お知らせ", message: "本文2", read: true, createdAt: ago(10 * SEC).toISOString() },
      ],
      NOW
    );
    assert.deepEqual(items, [
      { id: "n1", title: "山田先生が回答しました", message: "本文1", unread: true, time: "5時間前" },
      { id: "n2", title: "お知らせ", message: "本文2", unread: false, time: "たった今" },
    ]);
  });

  it("空配列・null は空配列（ようこそのフォールバックを出さない）", () => {
    assert.deepEqual(toNewsItems([], NOW), []);
    assert.deepEqual(toNewsItems(null, NOW), []);
  });
});
