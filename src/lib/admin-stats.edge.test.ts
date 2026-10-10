import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_COMPLETED_COLOR,
  FALLBACK_COURSE_COLORS,
  buildAdminStats,
  isOpenQuestion,
  jstMonthKey,
  recentJstMonths,
  toAdminDashboardView,
  type AdminStatsRows,
  type StatsCourseRow,
  type StatsProgressRow,
  type StatsQuestionRow,
} from "./admin-stats";
import { isAnswered } from "./question-threads";
import { currentCourseOf } from "./student-current-course";
import { progressPercent } from "./admin-student-view";

// #32 PR B 管理ダッシュボードの統計（純粋関数）の境界・異常データ。admin-stats.test.ts の補足。
// DB・時計・ネットワークなし。データはすべてダミー。

const NOW = new Date("2026-10-09T03:00:00.000Z"); // 日本時間 2026-10-09 12:00 → 範囲は 2026-05〜2026-10

const course = (id: string, lessonIds: string[][], color = "#112233"): StatsCourseRow => ({
  id,
  name: `STEP ${id}`,
  color,
  sections: lessonIds.map((ids) => ({ lessons: ids.map((lid) => ({ id: lid })) })),
});

// c1: l1, l2 / c0: レッスンなし / c2: l3, l4
const COURSES: StatsCourseRow[] = [course("c1", [["l1", "l2"]]), course("c0", []), course("c2", [["l3"], ["l4"]])];

const done = (userId: string, lessonId: string, at: string | Date | null): StatsProgressRow => ({
  userId,
  lessonId,
  completedAt: at === null ? null : at instanceof Date ? at : new Date(at),
});

const rows = (over: Partial<AdminStatsRows> = {}): AdminStatsRows => ({
  students: [],
  courses: COURSES,
  progress: [],
  questions: [],
  ...over,
});

const active = (id: string) => ({ id, deactivatedAt: null });
const off = (id: string) => ({ id, deactivatedAt: new Date("2026-09-01T00:00:00.000Z") });

const byMonth = (s: ReturnType<typeof buildAdminStats>, key: "activeStudents" | "completions") =>
  Object.fromEntries(s.monthly.map((m) => [m.month, m[key]]));

// ───────────── 1. 日本時間の月 ─────────────

describe("日本時間の月：境界・年またぎ・当月・未来・不正な日付", () => {
  it("各月の境界（前月末日の UTC 14:59:59.999 / 15:00）。うるう年の 2 月末も", () => {
    const cases: Array<[string, string]> = [
      ["2026-01-31T14:59:59.999Z", "2026-01"],
      ["2026-01-31T15:00:00.000Z", "2026-02"],
      ["2028-02-29T14:59:59.999Z", "2028-02"],
      ["2028-02-29T15:00:00.000Z", "2028-03"],
      ["2026-02-28T15:00:00.000Z", "2026-03"],
      ["2025-12-31T14:59:59.999Z", "2025-12"],
      ["2025-12-31T15:00:00.000Z", "2026-01"],
      ["2026-03-01T00:00:00.000Z", "2026-03"],
    ];
    for (const [iso, want] of cases) assert.equal(jstMonthKey(new Date(iso)), want, `${iso} の月が違う`);
  });

  it("now が月の境界ちょうど：UTC 14:59:59.999 は前の月までの 6 か月、15:00 は次の月までの 6 か月", () => {
    assert.deepEqual(recentJstMonths(new Date("2026-09-30T14:59:59.999Z")), ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    assert.deepEqual(recentJstMonths(new Date("2026-09-30T15:00:00.000Z")), ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  });

  it("年またぎの 6 か月：1 月・3 月・5 月（最後に年をまたがない）、31 日の now でも月が飛ばない", () => {
    assert.deepEqual(recentJstMonths(new Date("2027-01-15T00:00:00.000Z")), ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"]);
    assert.deepEqual(recentJstMonths(new Date("2027-03-31T03:00:00.000Z")), ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
    assert.deepEqual(recentJstMonths(new Date("2027-05-31T03:00:00.000Z")), ["2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05"]);
    // 12 か月ぶん：重複・抜けがない
    const twelve = recentJstMonths(new Date("2026-08-31T03:00:00.000Z"), 12);
    assert.equal(new Set(twelve).size, 12, "月が重複している");
    assert.equal(twelve[0], "2025-09");
    assert.equal(twelve[11], "2026-08");
  });

  it("buildAdminStats の窓の端：最初の月の直前（UTC 14:59:59.999）は数えず、15:00 は最初の月に数える", () => {
    const s = buildAdminStats(
      rows({
        students: [active("a"), active("b")],
        progress: [
          done("a", "l1", "2026-04-30T14:59:59.999Z"), // 日本時間 4 月（範囲外）
          done("b", "l1", "2026-04-30T15:00:00.000Z"), // 日本時間 5 月 1 日 00:00
        ],
      }),
      NOW
    );
    assert.deepEqual(byMonth(s, "activeStudents"), { "2026-05": 1, "2026-06": 0, "2026-07": 0, "2026-08": 0, "2026-09": 0, "2026-10": 0 });
  });

  it("当月は now より前の完了だけでなく、当月中の now より後（未来）の完了も当月に数える。翌月以降の未来日付は数えない", () => {
    const s = buildAdminStats(
      rows({
        students: [active("a"), active("b"), active("c")],
        progress: [
          done("a", "l1", "2026-10-01T00:00:00.000Z"), // 当月（過去）
          done("b", "l1", "2026-10-20T00:00:00.000Z"), // 当月（未来）
          done("c", "l1", "2026-10-31T15:00:00.000Z"), // 日本時間 11 月（範囲外の未来）
          done("c", "l2", "2027-01-01T00:00:00.000Z"),
        ],
      }),
      NOW
    );
    assert.equal(byMonth(s, "activeStudents")["2026-10"], 2);
    assert.equal(s.monthly.length, 6);
    assert.ok(!s.monthly.some((m) => m.month > "2026-10"), "未来の月が含まれている");
    // 未来日付でも完了行なのでカードの修了には数える（c は c1 を修了）。月別のコース修了は範囲外なので 0
    assert.equal(s.cards.completions, 1);
    assert.ok(s.monthly.every((m) => m.completions === 0), "範囲外の未来のコース修了を数えている");
  });

  it("不正な日付（Invalid Date）の完了行で例外にならず、月別の学習者には数えない（カードでは完了として数える）", () => {
    const s = buildAdminStats(
      rows({ students: [active("a")], progress: [done("a", "l1", new Date(Number.NaN)), done("a", "l2", new Date(Number.NaN))] }),
      NOW
    );
    assert.ok(s.monthly.every((m) => m.activeStudents === 0 && m.completions === 0), "不正な日付を月別に数えている");
    assert.ok(s.monthly.every((m) => /^\d{4}-\d{2}$/.test(m.month)), "月の形が崩れている");
    assert.equal(s.cards.completions, 1);
    assert.equal(s.cards.avgProgressPercent, 50);
  });

  it("不正な日付が 1 件でもあるコース修了は、レッスンの順序に関係なく月別に数えない", () => {
    const valid = "2026-09-01T00:00:00.000Z";
    const invalid = new Date(Number.NaN);
    for (const progress of [
      [done("a", "l1", valid), done("a", "l2", invalid)],
      [done("a", "l1", invalid), done("a", "l2", valid)],
    ]) {
      const s = buildAdminStats(rows({ students: [active("a")], progress }), NOW);
      assert.ok(s.monthly.every((m) => m.completions === 0), "不正な日付を含むコース修了を月別に数えている");
      assert.equal(s.cards.completions, 1);
    }
  });

  it("generatedAt は now の ISO 文字列（呼び出し側の時計を使わない）", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    assert.equal(buildAdminStats(rows(), now).generatedAt, "2030-01-01T00:00:00.000Z");
  });
});

// ───────────── 2. 無効化済み受講生・講師 ─────────────

describe("無効化済み受講生・講師の扱い", () => {
  it("無効化済み受講生：カード（人数・平均・修了）と Distribution から外れ、Monthly（学習者・コース修了）には含まれる", () => {
    const all = ["l1", "l2", "l3", "l4"];
    const withOff = buildAdminStats(
      rows({
        students: [active("a"), off("x")],
        progress: [done("a", "l1", "2026-09-01T00:00:00.000Z"), ...all.map((l) => done("x", l, "2026-08-10T00:00:00.000Z"))],
      }),
      NOW
    );
    const without = buildAdminStats(rows({ students: [active("a")], progress: [done("a", "l1", "2026-09-01T00:00:00.000Z")] }), NOW);
    assert.deepEqual(withOff.cards, without.cards, "無効化済み受講生がカードに影響している");
    assert.deepEqual(withOff.distribution, without.distribution, "無効化済み受講生が Distribution に入っている");
    assert.equal(withOff.distribution.reduce((n, d) => n + d.students, 0), 1, "Distribution の合計が有効な受講生の数と違う");
    assert.equal(byMonth(withOff, "activeStudents")["2026-08"], 1, "無効化済み受講生の学習が月別にない");
    assert.equal(byMonth(withOff, "completions")["2026-08"], 2, "無効化済み受講生のコース修了が月別にない");
  });

  it("無効化済み受講生だけなら、平均進捗は null、Distribution は全区分 0、月別には数える", () => {
    const s = buildAdminStats(rows({ students: [off("x")], progress: [done("x", "l1", "2026-10-01T00:00:00.000Z")] }), NOW);
    assert.deepEqual(s.cards, { activeStudents: 0, avgProgressPercent: null, openQuestions: 0, completions: 0 });
    assert.ok(s.distribution.every((d) => d.students === 0), "Distribution に人数がある");
    assert.equal(byMonth(s, "activeStudents")["2026-10"], 1);
  });

  it("講師（students にいない userId）の完了行は、全レッスンを終えていてもカード・月別・Distribution に混ざらない", () => {
    const all = ["l1", "l2", "l3", "l4"];
    const base = rows({ students: [active("a")] });
    const s = buildAdminStats({ ...base, progress: all.map((l) => done("ins_1", l, "2026-10-01T00:00:00.000Z")) }, NOW);
    assert.deepEqual(s, buildAdminStats(base, NOW), "講師の進捗が集計に混ざっている");
  });
});

// ───────────── 3. 未回答の質問 ─────────────

describe("未回答の質問", () => {
  const q = (lessonId: string, replies: Array<[string, string]>): StatsQuestionRow => ({
    lesson: { id: lessonId },
    replies: replies.map(([rl, role]) => ({ lessonId: rl, user: { role } })),
  });
  const asThread = (x: StatsQuestionRow) => ({
    lesson: { id: x.lesson.id, title: "", section: { course: { id: "", name: "" } } },
    replies: x.replies.map((r, i) => ({
      id: `r${i}`,
      content: "",
      createdAt: NOW,
      userId: "u",
      user: { name: "", role: r.user.role as "STUDENT" | "INSTRUCTOR", deactivatedAt: null },
      lessonId: r.lessonId,
    })),
  });

  it("別レッスンにだけ講師の返信がある質問、受講生の返信だけの質問、講師以外のロール（ADMIN など）の返信だけの質問は未回答", () => {
    assert.equal(isOpenQuestion(q("l1", [["l2", "INSTRUCTOR"], ["l3", "INSTRUCTOR"]])), true);
    assert.equal(isOpenQuestion(q("l1", [["l1", "STUDENT"], ["l1", "STUDENT"]])), true);
    assert.equal(isOpenQuestion(q("l1", [["l1", "ADMIN"], ["l1", "instructor"]])), true);
    assert.equal(isOpenQuestion(q("l1", [["l1", "STUDENT"], ["l2", "INSTRUCTOR"], ["l1", "INSTRUCTOR"]])), false);
  });

  it("未回答の数は受講生の有無・無効化に関係なく、質問の行だけで決まる（無効化済み受講生の質問も含める）", () => {
    const questions = [q("l1", []), q("l2", [["l1", "INSTRUCTOR"]]), q("l2", [["l2", "INSTRUCTOR"]])];
    assert.equal(buildAdminStats(rows({ questions }), NOW).cards.openQuestions, 2);
    assert.equal(buildAdminStats(rows({ questions, students: [off("x")] }), NOW).cards.openQuestions, 2);
    // 質問のレッスンがどのコースにもなくても数える
    assert.equal(buildAdminStats(rows({ questions: [q("ghost", [])] }), NOW).cards.openQuestions, 1);
  });

  it("乱数データで question-threads の isAnswered と判定が一致する（固定シードの擬似乱数）", () => {
    let seed = 20261009;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const lessons = ["l1", "l2", "l3"];
    const roles = ["STUDENT", "INSTRUCTOR", "ADMIN"];
    const questions: StatsQuestionRow[] = [];
    for (let i = 0; i < 500; i++) {
      const replies: Array<[string, string]> = [];
      const n = rand(5);
      for (let k = 0; k < n; k++) replies.push([lessons[rand(3)], roles[rand(3)]]);
      questions.push(q(lessons[rand(3)], replies));
    }
    const expectedOpen = questions.filter((x) => !isAnswered(asThread(x))).length;
    assert.ok(expectedOpen > 0 && expectedOpen < questions.length, "乱数データが偏っていて照合にならない");
    questions.forEach((x, i) => assert.equal(isOpenQuestion(x), !isAnswered(asThread(x)), `${i} 番目の判定が isAnswered と食い違う`));
    assert.equal(buildAdminStats(rows({ questions }), NOW).cards.openQuestions, expectedOpen);
  });
});

// ───────────── 4. 平均進捗 ─────────────

describe("平均進捗", () => {
  const many = (n: number) => [course("big", [Array.from({ length: n }, (_, i) => `b${i}`)])];

  it("丸めは四捨五入（0.5% → 1、1/3 → 33、2/3 → 67、0.4% → 0）", () => {
    const pct = (n: number, completed: number) =>
      buildAdminStats(
        rows({
          courses: many(n),
          students: [active("a")],
          progress: Array.from({ length: completed }, (_, i) => done("a", `b${i}`, null)),
        }),
        NOW
      ).cards.avgProgressPercent;
    assert.equal(pct(200, 1), 1);
    assert.equal(pct(3, 1), 33);
    assert.equal(pct(3, 2), 67);
    assert.equal(pct(250, 1), 0);
    assert.equal(pct(3, 3), 100);
  });

  it("平均は受講生ごとの割合の平均を最後に 1 回丸める（受講生ごとに丸めた値の平均とは違いうる）", () => {
    // 3 レッスン：a = 1/3、b = 1/3 → 平均 33.33…% → 33。人数 0 の受講生（進捗なし）も分母に入る
    const s = buildAdminStats(
      rows({
        courses: many(3),
        students: [active("a"), active("b"), active("c")],
        progress: [done("a", "b0", null), done("b", "b1", null)],
      }),
      NOW
    );
    // (1/3 + 1/3 + 0) / 3 = 22.2…% → 22
    assert.equal(s.cards.avgProgressPercent, 22);
    // 生徒管理の一覧の progressPercent と、1 人のときは一致する
    const one = buildAdminStats(rows({ courses: many(7), students: [active("a")], progress: [done("a", "b0", null), done("a", "b1", null)] }), NOW);
    assert.equal(one.cards.avgProgressPercent, progressPercent(2, 7));
  });

  it("有効な受講生 0 人なら null。全コースのレッスンが 0 件なら 0（null ではない）", () => {
    assert.equal(buildAdminStats(rows({ students: [] }), NOW).cards.avgProgressPercent, null);
    const s = buildAdminStats(rows({ courses: [course("e1", []), course("e2", [[]])], students: [active("a")] }), NOW);
    assert.equal(s.cards.avgProgressPercent, 0);
    assert.equal(s.cards.completions, 0, "レッスン 0 件のコースを修了にしている");
    assert.deepEqual(s.distribution, [{ courseId: null, name: "全コース修了", color: ALL_COMPLETED_COLOR, students: 1 }]);
  });

  it("異常データ（同じレッスンの重複行・コースにないレッスン・同じレッスンが 2 コースにある）でも 100% を超えない", () => {
    const shared = [course("s1", [["x1", "x2"]]), course("s2", [["x2"]])];
    const s = buildAdminStats(
      rows({
        courses: shared,
        students: [active("a")],
        progress: [done("a", "x1", null), done("a", "x1", null), done("a", "x2", null), done("a", "ghost1", null), done("a", "ghost2", null)],
      }),
      NOW
    );
    assert.equal(s.cards.avgProgressPercent, 100);
    assert.ok(s.cards.avgProgressPercent! <= 100, "100 を超えている");
    assert.ok(toAdminDashboardView(s) !== null, "応答が画面の検証を通らない");
  });

  it("completedAt が null の完了行は、平均進捗・修了・Distribution では完了として数え、月別には数えない", () => {
    const s = buildAdminStats(rows({ students: [active("a")], progress: ["l1", "l2", "l3", "l4"].map((l) => done("a", l, null)) }), NOW);
    assert.equal(s.cards.avgProgressPercent, 100);
    assert.equal(s.cards.completions, 2);
    assert.equal(s.distribution.find((d) => d.courseId === null)!.students, 1);
    assert.ok(s.monthly.every((m) => m.activeStudents === 0 && m.completions === 0), "completedAt null を月別に数えている");
  });
});

// ───────────── 5. コース修了の月 ─────────────

describe("コース修了の月", () => {
  it("レッスンの並び順ではなく、completedAt が最も遅いレッスンの月で数える（最後のレッスンを先に終えた場合も）", () => {
    const s = buildAdminStats(
      rows({
        students: [active("a")],
        progress: [done("a", "l2", "2026-06-01T00:00:00.000Z"), done("a", "l1", "2026-08-31T15:00:00.000Z")], // l1 は日本時間 9 月
      }),
      NOW
    );
    assert.deepEqual(byMonth(s, "completions"), { "2026-05": 0, "2026-06": 0, "2026-07": 0, "2026-08": 0, "2026-09": 1, "2026-10": 0 });
  });

  it("最初のレッスンが範囲より前でも、最後のレッスンが範囲内なら数える。最後が範囲より前なら数えない", () => {
    const s = buildAdminStats(
      rows({
        students: [active("a"), active("b")],
        progress: [
          done("a", "l1", "2025-01-01T00:00:00.000Z"),
          done("a", "l2", "2026-05-02T00:00:00.000Z"),
          done("b", "l1", "2026-01-01T00:00:00.000Z"),
          done("b", "l2", "2026-04-30T14:59:59.999Z"),
        ],
      }),
      NOW
    );
    assert.deepEqual(byMonth(s, "completions"), { "2026-05": 1, "2026-06": 0, "2026-07": 0, "2026-08": 0, "2026-09": 0, "2026-10": 0 });
    assert.equal(s.cards.completions, 2);
  });

  it("どれか 1 件でも completedAt が null なら、その位置（最初・最後）にかかわらず月別に数えない", () => {
    for (const order of [
      [done("a", "l1", null), done("a", "l2", "2026-09-01T00:00:00.000Z")],
      [done("a", "l1", "2026-09-01T00:00:00.000Z"), done("a", "l2", null)],
    ]) {
      const s = buildAdminStats(rows({ students: [active("a")], progress: order }), NOW);
      assert.ok(s.monthly.every((m) => m.completions === 0), "null を含む修了を月別に数えている");
      assert.equal(s.cards.completions, 1);
      // 学習者としては completedAt のある行の月に数える
      assert.equal(byMonth(s, "activeStudents")["2026-09"], 1);
    }
  });

  it("同じ月に複数コースを修了すれば、その月に複数数える（延べ数）", () => {
    const s = buildAdminStats(
      rows({ students: [active("a")], progress: ["l1", "l2", "l3", "l4"].map((l) => done("a", l, "2026-07-10T00:00:00.000Z")) }),
      NOW
    );
    assert.equal(byMonth(s, "completions")["2026-07"], 2);
    assert.equal(byMonth(s, "activeStudents")["2026-07"], 1, "学習者が重複して数えられている");
  });

  it("既知の制約：コースにレッスンを追加すると、過去の修了がカード・月別の両方から消える", () => {
    const progress = [done("a", "l1", "2026-07-01T00:00:00.000Z"), done("a", "l2", "2026-07-02T00:00:00.000Z")];
    const before = buildAdminStats(rows({ students: [active("a")], progress }), NOW);
    const after = buildAdminStats(
      rows({ students: [active("a")], progress, courses: [course("c1", [["l1", "l2", "l1b"]]), course("c0", []), course("c2", [["l3"], ["l4"]])] }),
      NOW
    );
    assert.equal(before.cards.completions, 1);
    assert.equal(byMonth(before, "completions")["2026-07"], 1);
    assert.equal(after.cards.completions, 0);
    assert.equal(byMonth(after, "completions")["2026-07"], 0);
    // 現在のコースも c1 に戻る
    assert.equal(after.distribution.find((d) => d.courseId === "c1")!.students, 1);
  });
});

// ───────────── Distribution と currentCourseOf の一致 ─────────────

describe("Distribution は currentCourseOf と一致する", () => {
  it("乱数データで、各区分の人数が currentCourseOf で数えた人数と一致し、合計は有効な受講生の数", () => {
    let seed = 32;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const all = ["l1", "l2", "l3", "l4"];
    const students = Array.from({ length: 60 }, (_, i) => (rand(4) === 0 ? off(`s${i}`) : active(`s${i}`)));
    const progress: StatsProgressRow[] = [];
    for (const st of students) for (const l of all) if (rand(3) > 0) progress.push(done(st.id, l, rand(2) ? null : "2026-09-01T00:00:00.000Z"));
    const s = buildAdminStats(rows({ students, progress }), NOW);

    const expected = new Map<string | null, number>();
    for (const st of students.filter((x) => x.deactivatedAt === null)) {
      const ids = new Set(progress.filter((p) => p.userId === st.id).map((p) => p.lessonId));
      const cur = currentCourseOf(COURSES, ids);
      const key = cur === null ? null : cur.id;
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    for (const d of s.distribution) assert.equal(d.students, expected.get(d.courseId) ?? 0, `${d.courseId} の人数が違う`);
    assert.equal(s.distribution.reduce((n, d) => n + d.students, 0), s.cards.activeStudents);
    assert.deepEqual(s.distribution.map((d) => d.courseId), ["c1", "c2", null], "並びが違う（レッスン 0 件のコースが入っている）");
  });
});

// ───────────── 7. 画面用の変換（色・形） ─────────────

describe("toAdminDashboardView：色の検証と境界", () => {
  const base = (color: unknown, extra: Record<string, unknown> = {}) => ({
    generatedAt: NOW.toISOString(),
    timeZone: "Asia/Tokyo",
    cards: { activeStudents: 0, avgProgressPercent: null, openQuestions: 0, completions: 0 },
    monthly: [],
    distribution: [{ courseId: "c1", name: "STEP1", color, students: 1, ...extra }],
  });

  it("CSS に流すと危ない・形の違う色は代わりの色にする", () => {
    const bad: unknown[] = [
      "#fff;background:url(https://example.com/x)",
      "#ffffff\n",
      " #ffffff",
      "#ffffff ",
      "#ff\u0000ffff",
      "#ｆｆｆ", // 全角の f
      "#ffff",
      "#fffff",
      "#GGGGGG",
      "red",
      "rgb(0,0,0)",
      "var(--x)",
      "url(javascript:alert(1))",
      "",
      null,
      undefined,
      123456,
      { toString: () => "#ffffff" },
    ];
    for (const c of bad) {
      const v = toAdminDashboardView(base(c));
      assert.ok(v, `色 ${JSON.stringify(String(c))} で全体が null になった`);
      assert.equal(v.distribution[0].color, FALLBACK_COURSE_COLORS[0], `色 ${JSON.stringify(String(c))} がそのまま通った`);
    }
  });

  it("#RGB・#RRGGBB・#RRGGBBAA（大文字小文字）はそのまま", () => {
    for (const c of ["#abc", "#ABCDEF", "#12345678", "#aBcDeF"]) {
      assert.equal(toAdminDashboardView(base(c))?.distribution[0].color, c, `${c} が通らない`);
    }
  });

  it("代わりの色は区分の位置で決まり、区分数が配色数を超えても循環する", () => {
    const n = FALLBACK_COURSE_COLORS.length + 2;
    const v = toAdminDashboardView({
      ...base("x"),
      distribution: Array.from({ length: n }, (_, i) => ({ courseId: `c${i}`, name: `S${i}`, color: "bad", students: 0 })),
    });
    assert.ok(v, "null になった");
    v.distribution.forEach((d, i) => assert.equal(d.color, FALLBACK_COURSE_COLORS[i % FALLBACK_COURSE_COLORS.length], `${i} 番目の色が違う`));
  });

  it("区分の key は course- の接頭辞で「全コース修了」と衝突しない", () => {
    const v = toAdminDashboardView({
      ...base("#fff"),
      distribution: [
        { courseId: "all-completed", name: "x", color: "#fff", students: 0 },
        { courseId: null, name: "全コース修了", color: ALL_COMPLETED_COLOR, students: 0 },
      ],
    });
    assert.ok(v, "null になった");
    assert.deepEqual(v.distribution.map((d) => d.key), ["course-all-completed", "all-completed"]);
  });

  it("平均進捗 0 と 100 は通り、負・小数・文字列は null。件数の Infinity も null", () => {
    const withCards = (cards: Record<string, unknown>) => ({ ...base("#fff"), cards: { activeStudents: 1, avgProgressPercent: 0, openQuestions: 0, completions: 0, ...cards } });
    assert.equal(toAdminDashboardView(withCards({ avgProgressPercent: 0 }))?.cards.avgProgressPercent, 0);
    assert.equal(toAdminDashboardView(withCards({ avgProgressPercent: 100 }))?.cards.avgProgressPercent, 100);
    for (const bad of [{ avgProgressPercent: -1 }, { avgProgressPercent: 50.5 }, { avgProgressPercent: "50" }, { activeStudents: Infinity }, { completions: null }]) {
      assert.equal(toAdminDashboardView(withCards(bad)), null, `${JSON.stringify(bad)} が通った`);
    }
  });

  it("courseId が無い（undefined）区分は形が違うとして null", () => {
    const d = base("#fff");
    delete (d.distribution[0] as Record<string, unknown>).courseId;
    assert.equal(toAdminDashboardView(d), null);
  });

  it("buildAdminStats の出力はそのまま画面の検証を通る（0 人・乱数データ）", () => {
    assert.ok(toAdminDashboardView(JSON.parse(JSON.stringify(buildAdminStats(rows(), NOW)))), "0 人で通らない");
    const s = buildAdminStats(
      rows({ students: [active("a"), off("b")], progress: [done("a", "l1", "2026-10-01T00:00:00.000Z"), done("b", "l3", null)] }),
      NOW
    );
    const v = toAdminDashboardView(JSON.parse(JSON.stringify(s)));
    assert.ok(v, "通らない");
    assert.deepEqual(v.monthly.map((m) => m.m), ["5月", "6月", "7月", "8月", "9月", "10月"]);
  });
});
