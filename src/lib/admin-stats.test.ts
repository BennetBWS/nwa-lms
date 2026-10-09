import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_COMPLETED_COLOR,
  FALLBACK_COURSE_COLORS,
  buildAdminStats,
  isOpenQuestion,
  jstMonthKey,
  monthLabel,
  recentJstMonths,
  toAdminDashboardView,
  type AdminStatsRows,
  type StatsCourseRow,
  type StatsProgressRow,
} from "./admin-stats";
import { isAnswered } from "./question-threads";

// #32 PR B 管理ダッシュボードの統計（純粋関数）。DB・時計・ネットワークなし。データはすべてダミー。

const NOW = new Date("2026-10-09T03:00:00.000Z"); // 日本時間 2026-10-09 12:00

const course = (id: string, lessonIds: string[][], color = "#112233"): StatsCourseRow => ({
  id,
  name: `STEP ${id}`,
  color,
  sections: lessonIds.map((ids) => ({ lessons: ids.map((lid) => ({ id: lid })) })),
});

// c1: l1, l2 / c0: レッスンなし / c2: l3, l4（2 セクション）
const COURSES: StatsCourseRow[] = [course("c1", [["l1", "l2"]]), course("c0", []), course("c2", [["l3"], ["l4"]])];

const done = (userId: string, lessonId: string, iso: string | null): StatsProgressRow => ({
  userId,
  lessonId,
  completedAt: iso === null ? null : new Date(iso),
});

const rows = (over: Partial<AdminStatsRows> = {}): AdminStatsRows => ({
  students: [],
  courses: COURSES,
  progress: [],
  questions: [],
  ...over,
});

describe("jstMonthKey・recentJstMonths（日本時間の月）", () => {
  it("UTC 14:59:59.999 は前の月、15:00 は次の月", () => {
    assert.equal(jstMonthKey(new Date("2026-05-31T14:59:59.999Z")), "2026-05");
    assert.equal(jstMonthKey(new Date("2026-05-31T15:00:00.000Z")), "2026-06");
    assert.equal(jstMonthKey(new Date("2025-12-31T15:00:00.000Z")), "2026-01");
  });

  it("当月を含む 6 か月を古い順に。年をまたぐ", () => {
    assert.deepEqual(recentJstMonths(new Date("2026-02-10T00:00:00.000Z")), ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"]);
    // UTC では 2025-12-31 だが日本時間では 2026-01
    assert.deepEqual(recentJstMonths(new Date("2025-12-31T15:00:00.000Z")), ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01"]);
    assert.deepEqual(recentJstMonths(NOW, 2), ["2026-09", "2026-10"]);
  });
});

describe("buildAdminStats：カード", () => {
  it("受講生 0 人：人数 0、平均進捗 null、修了 0。月別は 6 か月ぶんの 0", () => {
    const s = buildAdminStats(rows(), NOW);
    assert.deepEqual(s.cards, { activeStudents: 0, avgProgressPercent: null, openQuestions: 0, completions: 0 });
    assert.deepEqual(s.monthly.map((m) => m.month), ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    assert.ok(s.monthly.every((m) => m.activeStudents === 0 && m.completions === 0), "0 でない月がある");
    assert.equal(s.generatedAt, NOW.toISOString());
    assert.equal(s.timeZone, "Asia/Tokyo");
  });

  it("無効化された受講生はカードから外す（平均進捗・修了も）", () => {
    const s = buildAdminStats(
      rows({
        students: [
          { id: "a", deactivatedAt: null },
          { id: "b", deactivatedAt: null },
          { id: "off", deactivatedAt: new Date("2026-09-01T00:00:00.000Z") },
        ],
        progress: [
          done("a", "l1", "2026-09-01T00:00:00.000Z"),
          done("a", "l2", "2026-09-02T00:00:00.000Z"),
          done("b", "l3", null),
          ...["l1", "l2", "l3", "l4"].map((l) => done("off", l, "2026-09-03T00:00:00.000Z")),
        ],
      }),
      NOW
    );
    assert.equal(s.cards.activeStudents, 2);
    // a: 2/4 = 0.5、b: 1/4 = 0.25 → 平均 0.375 → 38%
    assert.equal(s.cards.avgProgressPercent, 38);
    // a が c1 を修了（off の 2 コースは数えない）
    assert.equal(s.cards.completions, 1);
  });

  it("レッスン 0 件のコースは修了として数えない。全レッスン完了でなければ数えない", () => {
    const s = buildAdminStats(
      rows({
        students: [{ id: "a", deactivatedAt: null }],
        progress: [done("a", "l1", null), done("a", "l2", null), done("a", "l3", null)],
      }),
      NOW
    );
    assert.equal(s.cards.completions, 1, "c1 だけが修了");
  });

  it("講師・知らない受講生の完了行、コースにないレッスンの行は使わない", () => {
    const s = buildAdminStats(
      rows({
        students: [{ id: "a", deactivatedAt: null }],
        progress: [done("ins", "l1", "2026-10-01T00:00:00.000Z"), done("a", "ghost", "2026-10-01T00:00:00.000Z")],
      }),
      NOW
    );
    assert.equal(s.cards.avgProgressPercent, 0);
    assert.ok(s.monthly.every((m) => m.activeStudents === 0), "講師・知らないレッスンの行を数えている");
  });

  it("レッスンが 0 件なら、受講生がいても平均進捗は 0", () => {
    const s = buildAdminStats(rows({ courses: [course("c0", [])], students: [{ id: "a", deactivatedAt: null }] }), NOW);
    assert.equal(s.cards.avgProgressPercent, 0);
  });

  it("未回答の質問：別レッスンの講師の返信では回答済みにならない（#55 と同じ判定）", () => {
    const q = (lessonId: string, replies: Array<[string, string]>) => ({
      lesson: { id: lessonId },
      replies: replies.map(([rl, role]) => ({ lessonId: rl, user: { role } })),
    });
    const questions = [
      q("l1", []),
      q("l1", [["l1", "STUDENT"]]),
      q("l1", [["l2", "INSTRUCTOR"]]),
      q("l1", [["l1", "INSTRUCTOR"]]),
      q("l2", [["l1", "STUDENT"], ["l2", "INSTRUCTOR"]]),
    ];
    const s = buildAdminStats(rows({ questions }), NOW);
    assert.equal(s.cards.openQuestions, 3);
    assert.deepEqual(
      questions.map(isOpenQuestion),
      questions.map((x) =>
        !isAnswered({
          lesson: { id: x.lesson.id, title: "", section: { course: { id: "", name: "" } } },
          replies: x.replies.map((r, i) => ({ id: `r${i}`, content: "", createdAt: NOW, userId: "u", user: { name: "", role: r.user.role as "STUDENT" | "INSTRUCTOR", deactivatedAt: null }, lessonId: r.lessonId })),
        })
      ),
      "isAnswered と判定が食い違う"
    );
  });
});

describe("buildAdminStats：Monthly Trends", () => {
  it("activeStudents：その月に完了した受講生を重複なく数える。無効化された受講生も含め、範囲外の月と completedAt null は数えない", () => {
    const s = buildAdminStats(
      rows({
        students: [
          { id: "a", deactivatedAt: null },
          { id: "off", deactivatedAt: new Date("2026-09-20T00:00:00.000Z") },
        ],
        progress: [
          done("a", "l1", "2026-09-30T14:59:59.000Z"), // 9 月
          done("a", "l2", "2026-09-30T15:00:00.000Z"), // 10 月（日本時間）
          done("a", "l3", "2026-10-01T00:00:00.000Z"), // 10 月（同じ人）
          done("off", "l1", "2026-09-10T00:00:00.000Z"), // 9 月
          done("off", "l2", "2026-04-30T00:00:00.000Z"), // 範囲外
          done("off", "l3", null),
        ],
      }),
      NOW
    );
    const by = Object.fromEntries(s.monthly.map((m) => [m.month, m.activeStudents]));
    assert.deepEqual(by, { "2026-05": 0, "2026-06": 0, "2026-07": 0, "2026-08": 0, "2026-09": 2, "2026-10": 1 });
  });

  it("completions：最後のレッスンを終えた月に数える。無効化された受講生も含める。completedAt が null のレッスンがあれば月別には数えない", () => {
    const s = buildAdminStats(
      rows({
        students: [
          { id: "a", deactivatedAt: null },
          { id: "off", deactivatedAt: new Date("2026-09-20T00:00:00.000Z") },
          { id: "legacy", deactivatedAt: null },
        ],
        progress: [
          // a: c1 は 8 月に l2、9 月に l1 → 9 月。c2 は l4 が 10 月 1 日 00:00 JST → 10 月
          done("a", "l2", "2026-08-15T00:00:00.000Z"),
          done("a", "l1", "2026-09-05T00:00:00.000Z"),
          done("a", "l3", "2026-09-06T00:00:00.000Z"),
          done("a", "l4", "2026-09-30T15:00:00.000Z"),
          // off: c1 は 7 月
          done("off", "l1", "2026-07-01T00:00:00.000Z"),
          done("off", "l2", "2026-07-02T00:00:00.000Z"),
          // legacy: c1 は l1 の completedAt が null → 月別には数えない（カードでは数える）
          done("legacy", "l1", null),
          done("legacy", "l2", "2026-10-02T00:00:00.000Z"),
        ],
      }),
      NOW
    );
    const by = Object.fromEntries(s.monthly.map((m) => [m.month, m.completions]));
    assert.deepEqual(by, { "2026-05": 0, "2026-06": 0, "2026-07": 1, "2026-08": 0, "2026-09": 1, "2026-10": 1 });
    // カード：a の 2 コース + legacy の c1（off は除く）
    assert.equal(s.cards.completions, 3);
  });
});

describe("buildAdminStats：Distribution", () => {
  it("有効な受講生の現在のコースごと。レッスン 0 件のコースは出さず、最後に全コース修了。0 人のコースも返す", () => {
    const s = buildAdminStats(
      rows({
        students: [
          { id: "new", deactivatedAt: null },
          { id: "mid", deactivatedAt: null },
          { id: "all", deactivatedAt: null },
          { id: "off", deactivatedAt: new Date("2026-09-01T00:00:00.000Z") },
        ],
        progress: [
          done("mid", "l1", null),
          done("mid", "l2", null),
          ...["l1", "l2", "l3", "l4"].map((l) => done("all", l, "2026-10-01T00:00:00.000Z")),
        ],
      }),
      NOW
    );
    assert.deepEqual(s.distribution, [
      { courseId: "c1", name: "STEP c1", color: "#112233", students: 1 },
      { courseId: "c2", name: "STEP c2", color: "#112233", students: 1 },
      { courseId: null, name: "全コース修了", color: ALL_COMPLETED_COLOR, students: 1 },
    ]);
  });

  it("応答に受講生の id を含めない", () => {
    const s = buildAdminStats(
      rows({ students: [{ id: "stu-secret-id", deactivatedAt: null }], progress: [done("stu-secret-id", "l1", "2026-10-01T00:00:00.000Z")] }),
      NOW
    );
    assert.ok(!JSON.stringify(s).includes("stu-secret-id"), "受講生の id が応答に含まれている");
    assert.deepEqual(Object.keys(s).sort(), ["cards", "distribution", "generatedAt", "monthly", "timeZone"]);
  });
});

describe("toAdminDashboardView（画面用の変換）", () => {
  const ok = () => ({
    generatedAt: NOW.toISOString(),
    timeZone: "Asia/Tokyo",
    cards: { activeStudents: 3, avgProgressPercent: 40, openQuestions: 2, completions: 1 },
    monthly: [
      { month: "2026-09", activeStudents: 2, completions: 0 },
      { month: "2026-10", activeStudents: 1, completions: 1 },
    ],
    distribution: [
      { courseId: "c1", name: "STEP1", color: "#6366F1", students: 2 },
      { courseId: "c2", name: "STEP2", color: "red; background:url(x)", students: 0 },
      { courseId: null, name: "全コース修了", color: ALL_COMPLETED_COLOR, students: 1 },
    ],
  });

  it("月のラベルは「9月」、色が #RGB などでなければ代わりの色", () => {
    const v = toAdminDashboardView(ok());
    assert.ok(v, "null になった");
    assert.deepEqual(v.cards, { activeStudents: 3, avgProgressPercent: 40, openQuestions: 2, completions: 1 });
    assert.deepEqual(v.monthly, [
      { m: "9月", a: 2, c: 0 },
      { m: "10月", a: 1, c: 1 },
    ]);
    assert.deepEqual(v.distribution, [
      { key: "course-c1", name: "STEP1", value: 2, color: "#6366F1" },
      { key: "course-c2", name: "STEP2", value: 0, color: FALLBACK_COURSE_COLORS[1] },
      { key: "all-completed", name: "全コース修了", value: 1, color: ALL_COMPLETED_COLOR },
    ]);
  });

  it("平均進捗の null はそのまま", () => {
    const d = ok();
    d.cards.avgProgressPercent = null;
    assert.equal(toAdminDashboardView(d)?.cards.avgProgressPercent, null);
  });

  it("形が違えば null", () => {
    const bad: Array<(d: ReturnType<typeof ok>) => unknown> = [
      () => null,
      () => [],
      (d) => ({ ...d, cards: null }),
      (d) => ({ ...d, monthly: {} }),
      (d) => ({ ...d, distribution: "x" }),
      (d) => ({ ...d, cards: { ...d.cards, activeStudents: -1 } }),
      (d) => ({ ...d, cards: { ...d.cards, openQuestions: 1.5 } }),
      (d) => ({ ...d, cards: { ...d.cards, completions: "1" } }),
      (d) => ({ ...d, cards: { ...d.cards, avgProgressPercent: 101 } }),
      (d) => ({ ...d, cards: { ...d.cards, avgProgressPercent: undefined } }),
      (d) => ({ ...d, monthly: [{ month: "2026-13", activeStudents: 0, completions: 0 }] }),
      (d) => ({ ...d, monthly: [{ month: "2026-01", activeStudents: 0 }] }),
      (d) => ({ ...d, monthly: [null] }),
      (d) => ({ ...d, distribution: [{ courseId: 1, name: "x", color: "#fff", students: 0 }] }),
      (d) => ({ ...d, distribution: [{ courseId: "c", name: null, color: "#fff", students: 0 }] }),
      (d) => ({ ...d, distribution: [{ courseId: "c", name: "x", color: "#fff", students: NaN }] }),
    ];
    bad.forEach((f, i) => assert.equal(toAdminDashboardView(f(ok())), null, `${i} 番目が null でない`));
  });

  it("monthLabel", () => {
    assert.equal(monthLabel("2026-01"), "1月");
    assert.equal(monthLabel("2026-12"), "12月");
    assert.equal(monthLabel("2026-1"), null);
    assert.equal(monthLabel(202601), null);
  });
});
