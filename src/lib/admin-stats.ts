/**
 * 管理ダッシュボードの統計（#32 PR B）。GET /api/admin/stats の集計と、画面（AdminDashboard）用の変換。
 *
 * DB・時計・DOM に触れない純粋関数だけを置く。現在時刻は必ず引数 `now` で受け取る。
 * 応答は集計値とコース名・色だけ。受講生個人の id・名前・メールは返さない。
 *
 * 定義（Tec の決定、#32）：
 * - 有効な受講生：role = STUDENT かつ deactivatedAt = null。カードと Distribution はこの人たちだけで数える
 * - 平均進捗：有効な受講生ごとの「完了レッスン数 ÷ 全レッスン数」（上限 1）の平均を % にして四捨五入。
 *   生徒管理の一覧（progressPercent）と同じく、完了行は completedAt が null の古い行も数える。
 *   有効な受講生が 0 人なら null（画面は「—」）。レッスンが 0 件なら各受講生 0%
 * - 未回答の質問：親コメント（parentId = null）のうち、親と同じレッスンに講師の返信がないもの。
 *   質問スレッド一覧（#55、question-threads の isAnswered）と同じ判定。無効化済み受講生の質問も含める
 * - 修了：コース修了の延べ数。有効な受講生 × コースの組で、そのコースの全レッスンを完了しているもの。
 *   レッスン 0 件のコースは数えない（終える対象がないため）
 * - 増減（+3 など）は出さない（過去のスナップショットがなく正確に出せないため）
 *
 * Monthly Trends（当月を含む直近 6 か月、古い順。月は日本時間で区切る）：
 * - activeStudents：その月にレッスンを 1 件以上完了した受講生の人数（Progress.completedAt の月。重複なし）
 * - completions：その月のコース修了の数。受講生 × コース（レッスン 1 件以上）で全レッスンを完了している組を、
 *   そのコースのレッスンの completedAt のうち最も遅いもの（＝最後のレッスンを終えた日時）の月で数える
 * - 過去の月は、無効化された受講生も含めて数える（その時点では受講していたため）
 * - completedAt が null の完了行（古いデータ）は月が分からないので月別には数えない。
 *   コース修了は、そのコースのどれかのレッスンの completedAt が null なら「最後に終えた日時」が決まらないので月別には数えない
 *   （カードの修了・平均進捗では数える）
 * - 後からレッスンを追加すると、そのコースの過去の修了は取り消されて見える（修了の記録を持たないため）
 *
 * Distribution：有効な受講生の「現在のコース」（student-current-course の currentCourseOf。
 * 生徒管理の表の Course 列と同じ定義）ごとの人数。全コースを修了した人は「全コース修了」の 1 区分にまとめる。
 * 並びはコースの並び順、最後に「全コース修了」。レッスン 0 件のコースは現在のコースにならないので出さない。
 * 0 人のコースも返す（画面は円グラフには出さず、凡例には人数つきで出す）。
 */

import { currentCourseOf, lessonIdsOf, type CourseLessonTree } from "./student-current-course";
import { sameLessonReplies } from "./question-threads";
import { ALL_COURSES_COMPLETED_LABEL } from "./admin-student-view";

/** 集計する月の数（当月を含む） */
export const STATS_MONTHS = 6;

/** 日本時間（UTC+9。夏時間なし）のずれ（ミリ秒） */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Distribution の「全コース修了」の色 */
export const ALL_COMPLETED_COLOR = "#94A3B8";

// ───────────── 入力（route が prisma の select で読む形） ─────────────

export type StatsStudentRow = { id: string; deactivatedAt: Date | null };

export type StatsCourseRow = CourseLessonTree & { color: string };

export type StatsProgressRow = { userId: string; lessonId: string; completedAt: Date | null };

export type StatsQuestionRow = {
  lesson: { id: string };
  replies: ReadonlyArray<{ lessonId: string; user: { role: string } }>;
};

export type AdminStatsRows = {
  /** role = STUDENT の全員（無効化済みも含む） */
  students: ReadonlyArray<StatsStudentRow>;
  /** 並び順（[order, id]。src/lib/course-order.ts）に並べたコース */
  courses: ReadonlyArray<StatsCourseRow>;
  /** completed = true の行（受講生以外の行が混ざっていてもよい。受講生の行だけを使う） */
  progress: ReadonlyArray<StatsProgressRow>;
  /** 親コメント（parentId = null）と、その返信 */
  questions: ReadonlyArray<StatsQuestionRow>;
};

// ───────────── 応答 ─────────────

export type AdminStatsCards = {
  activeStudents: number;
  avgProgressPercent: number | null;
  openQuestions: number;
  completions: number;
};

export type AdminStatsMonth = { month: string; activeStudents: number; completions: number };

export type AdminStatsDistribution = { courseId: string | null; name: string; color: string; students: number };

export type AdminStats = {
  generatedAt: string;
  timeZone: "Asia/Tokyo";
  cards: AdminStatsCards;
  monthly: AdminStatsMonth[];
  distribution: AdminStatsDistribution[];
};

// ───────────── 日本時間の月 ─────────────

/** 日本時間の月の "YYYY-MM"。例：2026-05-31T15:00:00Z は "2026-06" */
export function jstMonthKey(d: Date): string {
  const s = new Date(d.getTime() + JST_OFFSET_MS);
  return `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** now の日本時間の月を含む直近 count か月の "YYYY-MM"（古い順） */
export function recentJstMonths(now: Date, count: number = STATS_MONTHS): string[] {
  const s = new Date(now.getTime() + JST_OFFSET_MS);
  const y = s.getUTCFullYear();
  const m = s.getUTCMonth();
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// ───────────── 集計 ─────────────

/** 講師の返信が、親と同じレッスンに 1 件もない（question-threads の isAnswered の否定と同じ判定） */
export function isOpenQuestion(row: StatsQuestionRow): boolean {
  return !sameLessonReplies(row).some((r) => r.user.role === "INSTRUCTOR");
}

export function buildAdminStats(rows: AdminStatsRows, now: Date): AdminStats {
  const courses = rows.courses.map((c) => ({ course: c, lessonIds: lessonIdsOf(c) }));
  const knownLessons = new Set(courses.flatMap((c) => c.lessonIds));
  const totalLessons = knownLessons.size;

  // 受講生ごとの完了行（コースのレッスンのものだけ。lessonId は (userId, lessonId) で一意）
  const byStudent = new Map<string, Map<string, Date | null>>();
  for (const s of rows.students) byStudent.set(s.id, new Map());
  for (const p of rows.progress) {
    const done = byStudent.get(p.userId);
    if (!done || !knownLessons.has(p.lessonId)) continue;
    done.set(p.lessonId, p.completedAt);
  }

  const active = rows.students.filter((s) => s.deactivatedAt === null);

  // カード
  let ratioSum = 0;
  let completions = 0;
  for (const s of active) {
    const done = byStudent.get(s.id)!;
    ratioSum += totalLessons > 0 ? Math.min(1, done.size / totalLessons) : 0;
    for (const { lessonIds } of courses) {
      if (lessonIds.length > 0 && lessonIds.every((id) => done.has(id))) completions++;
    }
  }
  const cards: AdminStatsCards = {
    activeStudents: active.length,
    avgProgressPercent: active.length === 0 ? null : Math.round((ratioSum / active.length) * 100),
    openQuestions: rows.questions.filter(isOpenQuestion).length,
    completions,
  };

  // Monthly Trends（無効化済みの受講生も含める）
  const months = recentJstMonths(now);
  const activeByMonth = new Map<string, Set<string>>(months.map((m) => [m, new Set<string>()]));
  const completionsByMonth = new Map<string, number>(months.map((m) => [m, 0]));
  byStudent.forEach((done, userId) => {
    done.forEach((completedAt) => {
      if (completedAt === null) return;
      activeByMonth.get(jstMonthKey(completedAt))?.add(userId);
    });
    for (const { lessonIds } of courses) {
      if (lessonIds.length === 0 || !lessonIds.every((id) => done.has(id))) continue;
      let last: number | null = null;
      let unknown = false;
      for (const id of lessonIds) {
        const at = done.get(id);
        // Invalid Date も日時不明として扱う（NaN との比較でレッスンの順序に結果が左右されないように）
        if (!at || Number.isNaN(at.getTime())) {
          unknown = true;
          break;
        }
        if (last === null || at.getTime() > last) last = at.getTime();
      }
      if (unknown || last === null) continue;
      const key = jstMonthKey(new Date(last));
      if (completionsByMonth.has(key)) completionsByMonth.set(key, completionsByMonth.get(key)! + 1);
    }
  });
  const monthly = months.map((month) => ({
    month,
    activeStudents: activeByMonth.get(month)!.size,
    completions: completionsByMonth.get(month)!,
  }));

  // Distribution（有効な受講生の現在のコース）
  const counts = new Map<string | null, number>();
  for (const s of active) {
    const current = currentCourseOf(rows.courses, new Set(byStudent.get(s.id)!.keys()));
    const key = current === null ? null : current.id;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const distribution: AdminStatsDistribution[] = courses
    .filter(({ lessonIds }) => lessonIds.length > 0)
    .map(({ course }) => ({ courseId: course.id, name: course.name, color: course.color, students: counts.get(course.id) ?? 0 }));
  distribution.push({ courseId: null, name: ALL_COURSES_COMPLETED_LABEL, color: ALL_COMPLETED_COLOR, students: counts.get(null) ?? 0 });

  return { generatedAt: now.toISOString(), timeZone: "Asia/Tokyo", cards, monthly, distribution };
}

// ───────────── 画面（AdminDashboard）用 ─────────────

/** Distribution の色が使えないとき（#RGB / #RRGGBB / #RRGGBBAA 以外）の代わりの色 */
export const FALLBACK_COURSE_COLORS: ReadonlyArray<string> = ["#6366F1", "#EF4444", "#3B82F6", "#A78BFA", "#F59E0B", "#22C55E", "#EC4899"];

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export type AdminDashboardView = {
  cards: AdminStatsCards;
  /** Monthly Trends のグラフの data（m は「5月」の形、a は activeStudents、c は completions） */
  monthly: Array<{ m: string; a: number; c: number }>;
  /** Distribution。円グラフは value が 1 以上のものだけ、凡例は全部に使う */
  distribution: Array<{ key: string; name: string; value: number; color: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** "2026-05" → "5月"。形が違えば null */
export function monthLabel(month: unknown): string | null {
  if (typeof month !== "string") return null;
  const m = MONTH_RE.exec(month);
  return m ? `${Number(m[2])}月` : null;
}

/**
 * GET /api/admin/stats の応答を画面の形にする。形が違えば null（読み込み失敗として扱う）。
 * - cards：件数は 0 以上の整数。avgProgressPercent は 0〜100 の整数か null
 * - monthly：要素の月が "YYYY-MM" で、件数が 0 以上の整数
 * - distribution：name が文字列、students が 0 以上の整数。courseId は文字列か null。色が #RGB などでなければ代わりの色
 */
export function toAdminDashboardView(data: unknown): AdminDashboardView | null {
  if (!isRecord(data) || !isRecord(data.cards) || !Array.isArray(data.monthly) || !Array.isArray(data.distribution)) return null;
  const c = data.cards;
  if (!isCount(c.activeStudents) || !isCount(c.openQuestions) || !isCount(c.completions)) return null;
  let avg: number | null = null;
  if (c.avgProgressPercent !== null) {
    if (!isCount(c.avgProgressPercent) || c.avgProgressPercent > 100) return null;
    avg = c.avgProgressPercent;
  }

  const monthly: AdminDashboardView["monthly"] = [];
  for (const row of data.monthly) {
    if (!isRecord(row)) return null;
    const m = monthLabel(row.month);
    if (m === null || !isCount(row.activeStudents) || !isCount(row.completions)) return null;
    monthly.push({ m, a: row.activeStudents, c: row.completions });
  }

  const distribution: AdminDashboardView["distribution"] = [];
  for (let i = 0; i < data.distribution.length; i++) {
    const row: unknown = data.distribution[i];
    if (!isRecord(row) || typeof row.name !== "string" || !isCount(row.students)) return null;
    if (row.courseId !== null && typeof row.courseId !== "string") return null;
    const color = typeof row.color === "string" && HEX_COLOR_RE.test(row.color) ? row.color : FALLBACK_COURSE_COLORS[i % FALLBACK_COURSE_COLORS.length];
    distribution.push({ key: row.courseId === null ? "all-completed" : `course-${row.courseId}`, name: row.name, value: row.students, color });
  }

  return {
    cards: { activeStudents: c.activeStudents, avgProgressPercent: avg, openQuestions: c.openQuestions, completions: c.completions },
    monthly,
    distribution,
  };
}
