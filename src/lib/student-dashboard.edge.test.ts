import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countCompletedSince,
  NEXT_LESSONS_LIMIT,
  pickActiveCourse,
  pickNextLessons,
  RECENT_DAYS,
  relativeTimeJa,
  summarizeCourses,
  toActivityItems,
  toNewsItems,
  type CourseNode,
} from "./student-dashboard";

// #32 受講生ダッシュボードの純粋関数：境界値・不正入力・route と画面の整合を追加で確かめる。
// DB・ネットワークなし。now は固定。データはすべてダミー。

const NOW = new Date("2026-09-29T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("relativeTimeJa：ミリ秒単位の境界", () => {
  const cases: Array<[number, string]> = [
    [0, "たった今"],
    [59 * SEC, "たった今"],
    [MIN - 1, "たった今"],
    [MIN, "1分前"],
    [HOUR - 1, "59分前"],
    [HOUR, "1時間前"],
    [DAY - 1, "23時間前"],
    [DAY, "1日前"],
    [2 * DAY - 1, "1日前"],
    [365 * DAY, "365日前"],
  ];
  for (const [ms, expected] of cases) {
    it(`${ms}ms 前 → ${expected}`, () => {
      assert.equal(relativeTimeJa(ago(ms), NOW), expected);
    });
  }

  it("1ms 先の未来も「たった今」（負の分・時間を出さない）", () => {
    assert.equal(relativeTimeJa(new Date(NOW.getTime() + 1), NOW), "たった今");
    assert.equal(relativeTimeJa(new Date(NOW.getTime() + 400 * DAY), NOW), "たった今");
  });

  it("エポックミリ秒（number）も受け付ける", () => {
    assert.equal(relativeTimeJa(NOW.getTime() - 3 * HOUR, NOW), "3時間前");
  });

  it("タイムゾーン付きの ISO 文字列は同じ瞬間として扱う（+09:00 と Z）", () => {
    // 2026-09-29T20:00+09:00 は 11:00Z → 1 時間前
    assert.equal(relativeTimeJa("2026-09-29T20:00:00+09:00", NOW), "1時間前");
    assert.equal(relativeTimeJa("2026-09-29T11:00:00.000Z", NOW), "1時間前");
  });

  it("日付の切り替わり（JST の深夜 0 時）をまたいでも経過時間だけで決まる", () => {
    // JST 2026-09-30 00:30 の 1 時間前 = JST 09-29 23:30。暦日は違うが「1時間前」
    const now = new Date("2026-09-30T00:30:00+09:00");
    assert.equal(relativeTimeJa("2026-09-29T23:30:00+09:00", now), "1時間前");
  });

  describe("プロセスの TZ に依存しない", () => {
    const original = process.env.TZ;
    afterEach(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Asia/Dubai"]) {
      it(`TZ=${tz}`, () => {
        process.env.TZ = tz;
        assert.equal(relativeTimeJa(ago(5 * HOUR), NOW), "5時間前");
        assert.equal(relativeTimeJa(ago(3 * DAY).toISOString(), NOW), "3日前");
        assert.equal(countCompletedSince([{ completed: true, completedAt: ago(7 * DAY) }], NOW), 1);
      });
    }
  });

  it("不正な値（Invalid Date・NaN・Infinity・オブジェクト風）は空文字", () => {
    assert.equal(relativeTimeJa(NaN, NOW), "");
    assert.equal(relativeTimeJa(Infinity, NOW), "");
    assert.equal(relativeTimeJa("2026-13-45T99:99:99Z", NOW), "");
    assert.equal(relativeTimeJa("   ", NOW), "");
    assert.equal(relativeTimeJa(new Date("invalid"), NOW), "");
  });
});

describe("countCompletedSince：境界と不正値", () => {
  it("RECENT_DAYS は 7", () => {
    assert.equal(RECENT_DAYS, 7);
  });

  it("ちょうど 7 日前（ISO 文字列）は含み、1ms 古いものは含まない", () => {
    const rows = [
      { completed: true, completedAt: ago(7 * DAY).toISOString() },
      { completed: true, completedAt: ago(7 * DAY + 1).toISOString() },
      { completed: true, completedAt: ago(7 * DAY - 1).toISOString() },
    ];
    assert.equal(countCompletedSince(rows, NOW), 2);
  });

  it("days を変えると範囲も変わる（days=1 はちょうど 24 時間前まで）", () => {
    const rows = [
      { completed: true, completedAt: ago(DAY) },
      { completed: true, completedAt: ago(DAY + 1) },
    ];
    assert.equal(countCompletedSince(rows, NOW, 1), 1);
    assert.equal(countCompletedSince(rows, NOW, 0), 0);
  });

  it("now が不正なら 0（NaN 比較で全件数えたりしない）", () => {
    const rows = [{ completed: true, completedAt: ago(HOUR) }];
    assert.equal(countCompletedSince(rows, new Date(NaN)), 0);
  });

  it("undefined・空文字・Invalid Date の completedAt は数えない", () => {
    const rows = [
      { completed: true, completedAt: undefined },
      { completed: true, completedAt: "" },
      { completed: true, completedAt: new Date(NaN) },
    ];
    assert.equal(countCompletedSince(rows, NOW), 0);
  });
});

function course(id: string, sections: Array<[order: number, lessons: Array<[id: string, order: number]>]>, sectionIds?: string[]): CourseNode {
  return {
    id,
    name: `コース ${id}`,
    icon: "html",
    color: "#000000",
    order: 0,
    sections: sections.map(([order, lessons], i) => ({
      id: sectionIds?.[i] ?? `${id}_s${i}`,
      order,
      lessons: lessons.map(([lid, lorder]) => ({ id: lid, title: `レッスン ${lid}`, order: lorder })),
    })),
  };
}

describe("pickNextLessons：追加の境界", () => {
  it("NEXT_LESSONS_LIMIT は 3", () => {
    assert.equal(NEXT_LESSONS_LIMIT, 3);
  });

  it("先頭にレッスン 0 件のコースがあっても、次のコースから選ぶ", () => {
    const empty = course("e", []);
    const emptySection = course("es", [[1, []]]);
    const c = course("c", [[1, [["c_1", 1], ["c_2", 2]]]]);
    assert.deepEqual(
      pickNextLessons([empty, emptySection, c], new Set()).map((n) => n.lessonId),
      ["c_1", "c_2"]
    );
  });

  it("すべて完了＋レッスン 0 件のコースだけなら空", () => {
    const empty = course("e", []);
    const c = course("c", [[1, [["c_1", 1]]]]);
    assert.deepEqual(pickNextLessons([c, empty], new Set(["c_1"])), []);
  });

  it("セクションの order が重複したら section id 順（配列の順ではない）", () => {
    const c = course(
      "d",
      [
        [1, [["d_z", 1]]],
        [1, [["d_y", 1]]],
      ],
      ["sec_b", "sec_a"]
    );
    assert.deepEqual(
      pickNextLessons([c], new Set()).map((n) => n.lessonId),
      ["d_y", "d_z"]
    );
  });

  it("レッスン order が 0・負数でも数値順", () => {
    const c = course("n", [[1, [["n_a", 10], ["n_b", -1], ["n_c", 0]]]]);
    assert.deepEqual(
      pickNextLessons([c], new Set()).map((n) => n.lessonId),
      ["n_b", "n_c", "n_a"]
    );
  });

  it("受講中コースが後ろにあれば、手前の未着手コースより優先する", () => {
    const a = course("a", [[1, [["a_1", 1]]]]);
    const b = course("b", [[1, [["b_1", 1], ["b_2", 2]]]]);
    assert.deepEqual(
      pickNextLessons([a, b], new Set(["b_1"])).map((n) => [n.courseId, n.lessonId]),
      [["b", "b_2"]]
    );
  });

  it("どのコースにもない lessonId が完了済みに混ざっても影響しない", () => {
    const a = course("a", [[1, [["a_1", 1], ["a_2", 2]]]]);
    const s = summarizeCourses([a], new Set(["zzz", "a_1"]));
    assert.equal(s.completedLessons, 1);
    assert.equal(s.totalLessons, 2);
    assert.deepEqual(
      pickNextLessons([a], new Set(["zzz"])).map((n) => n.lessonId),
      ["a_1", "a_2"]
    );
  });

  it("limit より多い未完了があっても limit 件で止まる。limit が負なら空", () => {
    const c = course("m", [[1, Array.from({ length: 10 }, (_, i) => [`m_${i}`, i] as [string, number])]]);
    assert.equal(pickNextLessons([c], new Set(), 5).length, 5);
    assert.deepEqual(pickNextLessons([c], new Set(), -1), []);
  });

  it("返す要素は lessonId / title / courseId / courseName だけ", () => {
    const c = course("k", [[1, [["k_1", 1]]]]);
    const [n] = pickNextLessons([c], new Set());
    assert.deepEqual(Object.keys(n).sort(), ["courseId", "courseName", "lessonId", "title"]);
  });
});

describe("route の nextLessons と画面の activeCourse（CTA）が同じコースを指す", () => {
  // page.tsx は API の courses（summarizeCourses の結果）に pickActiveCourse をかける。
  // route の nextLessons も同じ規則。擬似乱数でいくつも組み合わせて食い違わないことを確かめる。
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it("200 通りの組み合わせで一致する", () => {
    const rand = rng(32);
    for (let t = 0; t < 200; t++) {
      const courses: CourseNode[] = [];
      const done = new Set<string>();
      const nCourses = Math.floor(rand() * 5);
      for (let c = 0; c < nCourses; c++) {
        const nSections = Math.floor(rand() * 3);
        const sections: Array<[number, Array<[string, number]>]> = [];
        for (let s = 0; s < nSections; s++) {
          const nLessons = Math.floor(rand() * 4);
          const lessons: Array<[string, number]> = [];
          for (let l = 0; l < nLessons; l++) {
            const id = `t${t}_c${c}_s${s}_l${l}`;
            lessons.push([id, Math.floor(rand() * 3)]);
            if (rand() < 0.5) done.add(id);
          }
          sections.push([Math.floor(rand() * 3), lessons]);
        }
        courses.push(course(`t${t}_c${c}`, sections));
      }
      const summaries = summarizeCourses(courses, done).courses;
      const active = pickActiveCourse(summaries);
      const next = pickNextLessons(courses, done);
      for (const n of next) {
        assert.equal(n.courseId, active?.id, `case ${t}`);
        assert.ok(!done.has(n.lessonId), `case ${t}`);
      }
      if (active && active.completedLessons < active.totalLessons) {
        assert.equal(next.length, Math.min(NEXT_LESSONS_LIMIT, active.totalLessons - active.completedLessons), `case ${t}`);
      } else {
        assert.equal(next.length, 0, `case ${t}`);
      }
    }
  });
});

describe("toActivityItems / toNewsItems：不正な入力", () => {
  it("配列でないもの（オブジェクト・文字列・数値）は空配列", () => {
    for (const bad of [{}, "x", 1, { length: 1, 0: {} }]) {
      assert.deepEqual(toActivityItems(bad as never, NOW), []);
      assert.deepEqual(toNewsItems(bad as never, NOW), []);
    }
  });

  it("配列の中の null・undefined・非オブジェクト（文字列・数値・真偽値・配列）の要素は飛ばし、残りは順番どおり変換する", () => {
    const junk = [null, undefined, "x", 1, true, []];
    const activity = [
      ...junk,
      { lessonTitle: "L1", courseName: "C", completedAt: ago(MIN) },
      null,
      { lessonTitle: "L2", courseName: "C", completedAt: ago(HOUR) },
      7,
    ];
    assert.deepEqual(toActivityItems(activity as never, NOW), [
      { text: "C - L1", time: "1分前" },
      { text: "C - L2", time: "1時間前" },
    ]);
    const news = [
      "n",
      { id: "a", title: "T", message: "M", read: false, createdAt: ago(MIN) },
      null,
      [],
      { id: "b", title: "T2", message: "M2", read: true, createdAt: ago(DAY) },
      undefined,
    ];
    assert.deepEqual(toNewsItems(news as never, NOW), [
      { id: "a", title: "T", message: "M", unread: true, time: "1分前" },
      { id: "b", title: "T2", message: "M2", unread: false, time: "1日前" },
    ]);
  });

  it("要素がすべて null・非オブジェクトなら空配列（例外にしない）", () => {
    const allJunk = [null, undefined, 0, "", false, []];
    assert.deepEqual(toActivityItems(allJunk as never, NOW), []);
    assert.deepEqual(toNewsItems(allJunk as never, NOW), []);
  });

  it("Activity は lessonTitle と courseName が文字列の要素だけを通す", () => {
    const rows = [
      {},
      { courseName: "C", completedAt: ago(MIN) },
      { lessonTitle: "L", completedAt: ago(MIN) },
      { lessonTitle: null, courseName: "C", completedAt: ago(MIN) },
      { lessonTitle: "L", courseName: 1, completedAt: ago(MIN) },
      { lessonTitle: ["L"], courseName: "C", completedAt: ago(MIN) },
      { lessonTitle: "L", courseName: { name: "C" }, completedAt: ago(MIN) },
      { lessonTitle: "OK", courseName: "C", completedAt: ago(MIN) },
      // 空文字も文字列なので通す
      { lessonTitle: "", courseName: "", completedAt: ago(HOUR) },
    ];
    assert.deepEqual(toActivityItems(rows as never, NOW), [
      { text: "C - OK", time: "1分前" },
      { text: " - ", time: "1時間前" },
    ]);
  });

  it("お知らせは title が文字列の要素だけを通し、message が文字列でなければ空文字", () => {
    const rows = [
      {},
      { id: "x1", message: "M", read: false, createdAt: ago(MIN) },
      { id: "x2", title: null, message: "M", read: false, createdAt: ago(MIN) },
      { id: "x3", title: 1, message: "M", read: false, createdAt: ago(MIN) },
      { id: "x4", title: { t: "T" }, message: "M", read: false, createdAt: ago(MIN) },
      { id: "a", title: "T", message: "M", read: false, createdAt: ago(MIN) },
      { id: "b", title: "T2", read: true, createdAt: ago(MIN) },
      { id: "c", title: "T3", message: null, read: true, createdAt: ago(MIN) },
      { id: "d", title: "T4", message: 42, read: true, createdAt: ago(MIN) },
      { id: "e", title: "", message: "M5", read: true, createdAt: ago(MIN) },
    ];
    assert.deepEqual(toNewsItems(rows as never, NOW), [
      { id: "a", title: "T", message: "M", unread: true, time: "1分前" },
      { id: "b", title: "T2", message: "", unread: false, time: "1分前" },
      { id: "c", title: "T3", message: "", unread: false, time: "1分前" },
      { id: "d", title: "T4", message: "", unread: false, time: "1分前" },
      { id: "e", title: "", message: "M5", unread: false, time: "1分前" },
    ]);
  });

  it("日時が不正・欠けている要素は time が空文字（例外にしない）", () => {
    assert.deepEqual(toActivityItems([{ lessonTitle: "L", courseName: "C", completedAt: "bad" }], NOW), [
      { text: "C - L", time: "" },
    ]);
    assert.deepEqual(
      toNewsItems([{ id: "n", title: "T", message: "M", read: false, createdAt: undefined }], NOW),
      [{ id: "n", title: "T", message: "M", unread: true, time: "" }]
    );
  });

  it("未来の createdAt は「たった今」", () => {
    const [n] = toNewsItems(
      [{ id: "n", title: "T", message: "M", read: true, createdAt: new Date(NOW.getTime() + HOUR).toISOString() }],
      NOW
    );
    assert.equal(n.time, "たった今");
    assert.equal(n.unread, false);
  });

  it("並びは入力のまま（route の新しい順を崩さない）", () => {
    const rows = [
      { lessonTitle: "新", courseName: "C", completedAt: ago(MIN).toISOString() },
      { lessonTitle: "旧", courseName: "C", completedAt: ago(DAY).toISOString() },
    ];
    assert.deepEqual(
      toActivityItems(rows, NOW).map((a) => a.text),
      ["C - 新", "C - 旧"]
    );
  });

  it("タイトル・本文の HTML 風文字列は加工せずそのまま返す（React 側でエスケープされる）", () => {
    const [n] = toNewsItems([{ id: "x", title: "<b>t</b>", message: "<script>m</script>", read: false, createdAt: NOW }], NOW);
    assert.equal(n.title, "<b>t</b>");
    assert.equal(n.message, "<script>m</script>");
  });
});
