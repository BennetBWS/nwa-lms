/**
 * 受講生ダッシュボード（#32）の集計と表示用の変換。
 *
 * /api/dashboard（route）と src/app/page.tsx の StudentDashboard の両方から使う。
 * DB・時計に触れない純粋関数だけを置く。現在時刻は必ず引数 `now` で受け取る。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 「直近 7 日」の日数（暦週ではなく now から遡る 7 日間） */
export const RECENT_DAYS = 7;

/** Next Up に出す最大件数 */
export const NEXT_LESSONS_LIMIT = 3;

type DateInput = Date | string | number | null | undefined;

function toTime(value: DateInput): number | null {
  if (value === null || value === undefined || value === "") return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 相対時刻（日本語）。
 * 1 分未満は「たった今」、以降「N分前」「N時間前」「N日前」（切り捨て）。
 * 未来の時刻は「たった今」。null・不正な値は ""。
 */
export function relativeTimeJa(date: DateInput, now: Date): string {
  const t = toTime(date);
  const n = now.getTime();
  if (t === null || !Number.isFinite(n)) return "";
  const diff = n - t;
  if (diff < MINUTE) return "たった今";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}時間前`;
  return `${Math.floor(diff / DAY)}日前`;
}

// ───────────── route 側の集計 ─────────────

export type LessonNode = { id: string; title: string; order: number };
export type SectionNode = { id: string; order: number; lessons: LessonNode[] };
export type CourseNode = {
  id: string;
  name: string;
  icon: string;
  color: string;
  order: number;
  sections: SectionNode[];
};

export type CourseSummary = {
  id: string;
  name: string;
  icon: string;
  color: string;
  order: number;
  progress: number;
  totalLessons: number;
  completedLessons: number;
};

export type CoursesSummary = {
  courses: CourseSummary[];
  activeCourses: number;
  completedLessons: number;
  totalLessons: number;
  overallProgress: number;
};

function percent(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

/** コースごとの進捗と、全体の件数・進度をまとめる。コースの並びは受け取った順のまま */
export function summarizeCourses(courses: CourseNode[], completedLessonIds: ReadonlySet<string>): CoursesSummary {
  let totalLessons = 0;
  let completedLessons = 0;
  let activeCourses = 0;

  const summaries = courses.map((course) => {
    let total = 0;
    let done = 0;
    for (const section of course.sections) {
      for (const lesson of section.lessons) {
        total++;
        if (completedLessonIds.has(lesson.id)) done++;
      }
    }
    totalLessons += total;
    completedLessons += done;
    if (isInProgress({ completedLessons: done, totalLessons: total })) activeCourses++;
    return {
      id: course.id,
      name: course.name,
      icon: course.icon,
      color: course.color,
      order: course.order,
      progress: percent(done, total),
      totalLessons: total,
      completedLessons: done,
    };
  });

  return {
    courses: summaries,
    activeCourses,
    completedLessons,
    totalLessons,
    overallProgress: percent(completedLessons, totalLessons),
  };
}

type Counts = { completedLessons: number; totalLessons: number };

/**
 * 受講中（progress > 0 && < 100）。
 * 丸めた % ではなく件数で判定する（1/300 が 0%、299/300 が 100% と表示されても受講中とみなす）。
 */
export function isInProgress(c: Counts): boolean {
  return c.completedLessons > 0 && c.completedLessons < c.totalLessons;
}

/** 未完了のコース（レッスンがあり、まだ全部は終えていない） */
function isUnfinished(c: Counts): boolean {
  return c.completedLessons < c.totalLessons;
}

/**
 * 「学習を続ける」と Next Up の対象コース（#32、Tec 決定）：
 * 受講中のコース → なければ最初の未完了コース（STEP1 完了・STEP2 未着手なら STEP2）→
 * すべて完了なら最初のコース。コースが 0 件なら null
 */
export function pickActiveCourse<C extends Counts>(courses: readonly C[]): C | null {
  return courses.find(isInProgress) ?? courses.find(isUnfinished) ?? courses[0] ?? null;
}

export type NextLesson = { lessonId: string; title: string; courseId: string; courseName: string };

const byOrderThenId = (a: { order: number; id: string }, b: { order: number; id: string }) =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Next Up：pickActiveCourse で選んだコースの未完了レッスンを、
 * セクション順・レッスン順（order、同順は id）に最大 `limit` 件。
 */
export function pickNextLessons(
  courses: CourseNode[],
  completedLessonIds: ReadonlySet<string>,
  limit: number = NEXT_LESSONS_LIMIT
): NextLesson[] {
  const summaries = summarizeCourses(courses, completedLessonIds).courses;
  const active = pickActiveCourse(summaries);
  if (!active || limit <= 0) return [];

  const course = courses[summaries.indexOf(active)];
  const out: NextLesson[] = [];
  for (const section of [...course.sections].sort(byOrderThenId)) {
    for (const lesson of [...section.lessons].sort(byOrderThenId)) {
      if (completedLessonIds.has(lesson.id)) continue;
      out.push({ lessonId: lesson.id, title: lesson.title, courseId: course.id, courseName: course.name });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** completed かつ completedAt が now から `days` 日前以降の件数 */
export function countCompletedSince(
  rows: ReadonlyArray<{ completed: boolean; completedAt: DateInput }>,
  now: Date,
  days: number = RECENT_DAYS
): number {
  const since = now.getTime() - days * DAY;
  let n = 0;
  for (const r of rows) {
    if (!r.completed) continue;
    const t = toTime(r.completedAt);
    if (t !== null && t >= since) n++;
  }
  return n;
}

// ───────────── 画面側の変換 ─────────────

export type NextUpEmptyInput = { courseCount: number; completedLessons: number; totalLessons: number };

/**
 * Next Up が 0 件のときの文言。
 * コース 0 件 →「コースはまだありません」、コースはあるがレッスン 0 件 →「レッスンはまだありません」、
 * 全レッスン完了 →「すべて完了しました」。
 * それ以外（未完了があるのに Next Up が空という食い違い）は「次のレッスンはありません」。
 */
export function nextUpEmptyMessage(c: NextUpEmptyInput): string {
  if (!(c.courseCount > 0)) return "コースはまだありません";
  if (!(c.totalLessons > 0)) return "レッスンはまだありません";
  if (c.completedLessons === c.totalLessons) return "すべて完了しました";
  return "次のレッスンはありません";
}

function isPlainObject(r: unknown): r is Record<string, unknown> {
  return typeof r === "object" && r !== null && !Array.isArray(r);
}

/**
 * 配列の要素のうち、オブジェクト（null・配列を除く）で、`stringKeys` がすべて文字列のものだけを残す。
 * API 応答が崩れていても落とさない
 */
function onlyObjects<R extends object>(rows: ReadonlyArray<R | null | undefined>, stringKeys: ReadonlyArray<keyof R & string>): R[] {
  return rows.filter((r): r is R => isPlainObject(r) && stringKeys.every((k) => typeof r[k] === "string"));
}

export type ActivityInput = { lessonTitle: string; courseName: string; completedAt: DateInput };
export type ActivityItem = { text: string; time: string };

/**
 * Activity の行。テキストは「コース名 - レッスン名」、時刻は相対時刻。
 * null・非オブジェクト、lessonTitle か courseName が文字列でない要素は飛ばす
 */
export function toActivityItems(
  rows: ReadonlyArray<ActivityInput | null | undefined> | null | undefined,
  now: Date
): ActivityItem[] {
  if (!Array.isArray(rows)) return [];
  return onlyObjects(rows, ["lessonTitle", "courseName"]).map((r) => ({
    text: `${r.courseName} - ${r.lessonTitle}`,
    time: relativeTimeJa(r.completedAt, now),
  }));
}

export type NewsInput = { id: string; title: string; message: string; read: boolean; createdAt: DateInput };
export type NewsItem = { id: string; title: string; message: string; unread: boolean; time: string };

/**
 * お知らせの行。1 行目 title、2 行目 message、未読フラグ、createdAt からの相対時刻。
 * null・非オブジェクト、title が文字列でない要素は飛ばす。message が文字列でなければ空文字
 */
export function toNewsItems(rows: ReadonlyArray<NewsInput | null | undefined> | null | undefined, now: Date): NewsItem[] {
  if (!Array.isArray(rows)) return [];
  return onlyObjects(rows, ["title"]).map((n) => ({
    id: n.id,
    title: n.title,
    message: typeof n.message === "string" ? n.message : "",
    unread: !n.read,
    time: relativeTimeJa(n.createdAt, now),
  }));
}
