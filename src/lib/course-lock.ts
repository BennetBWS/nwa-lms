/**
 * コースのロック表示（#32、Tec 決定）。
 *
 * 受講生ダッシュボードのカリキュラム欄と、コース一覧（CourseList）の両方で使う。
 * 丸めた % ではなく、レッスンの件数で判定する純粋関数だけを置く。
 */

export type LessonCounts = { completedLessons: number; totalLessons: number };

/** レッスンが 1 件以上あり、すべて完了している */
function isFinished(c: LessonCounts): boolean {
  return c.totalLessons > 0 && c.completedLessons >= c.totalLessons;
}

/**
 * ロックするか。
 * 前のコースを全部終えておらず（前のコースにレッスンがない場合も含む）、
 * このコースが未着手（完了 0 件）ならロック。最初のコース（prev が null）はロックしない。
 */
export function isCourseLocked(prev: LessonCounts | null, current: LessonCounts): boolean {
  if (prev === null) return false;
  return !isFinished(prev) && !(current.completedLessons > 0);
}

export type CourseWithLessons = {
  sections?: ReadonlyArray<{ lessons?: ReadonlyArray<{ completed?: unknown } | null> | null } | null> | null;
};

/**
 * /api/courses の 1 コース（sections → lessons、各レッスンに completed）から
 * 完了数と総数を数える。completed が true のものだけを完了とする。
 * sections・lessons が配列でない場合は 0 件として扱う。
 */
export function countCourseLessons(course: CourseWithLessons | null | undefined): LessonCounts {
  let totalLessons = 0;
  let completedLessons = 0;
  const sections = course?.sections;
  if (!Array.isArray(sections)) return { completedLessons, totalLessons };
  for (const section of sections) {
    const lessons = section?.lessons;
    if (!Array.isArray(lessons)) continue;
    for (const lesson of lessons) {
      totalLessons++;
      if (lesson?.completed === true) completedLessons++;
    }
  }
  return { completedLessons, totalLessons };
}
