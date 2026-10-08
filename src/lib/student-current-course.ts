/**
 * 受講生の「現在のコース」（#32、Tec 決定 QA-2）。
 *
 * 並び順（Course.order の昇順）で、全レッスンを終えていない最初のコース。
 * レッスンが 1 件もないコースは飛ばす（終える対象がないため）。
 * すべて終えていれば null（画面では「全コース修了」）。
 * course-lock の考え方（前のコースを終えないと次は開けない）と同じ。
 *
 * 生徒管理の表（Course 列）・詳細表示、管理ダッシュボードの Distribution（#32 PR B）で
 * 同じ定義を使うため、ここにだけ置く。DB・React に依存しない純粋関数。
 */

export type CurrentCourse = { id: string; name: string };

/** sections → lessons の id だけを持つコース（Prisma の select の結果と同じ形） */
export type CourseLessonTree = {
  id: string;
  name: string;
  sections: ReadonlyArray<{ lessons: ReadonlyArray<{ id: string }> }>;
};

/** コースのレッスン id をまとめる（sections の順・lessons の順のまま） */
export function lessonIdsOf(course: CourseLessonTree): string[] {
  return course.sections.flatMap((s) => s.lessons.map((l) => l.id));
}

/**
 * courses は並び順（order の昇順）に並べて渡す。この関数は並べ替えない。
 * completedLessonIds は完了したレッスンの id。ほかのコースの id が混ざっていてもよい。
 */
export function currentCourseOf(
  courses: ReadonlyArray<CourseLessonTree>,
  completedLessonIds: ReadonlySet<string>
): CurrentCourse | null {
  for (const course of courses) {
    const ids = lessonIdsOf(course);
    if (ids.length === 0) continue;
    if (ids.some((id) => !completedLessonIds.has(id))) {
      return { id: course.id, name: course.name };
    }
  }
  return null;
}
