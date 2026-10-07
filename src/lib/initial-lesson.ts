/**
 * レッスン画面（src/app/page.tsx の LessonView）で、コースを開いたときに最初に表示するレッスンを選ぶ（#32）。
 * DB・DOM に触れない純粋関数。
 */

export type SectionWithLessons<L> = { lessons?: ReadonlyArray<L> | null };

/**
 * 最初に表示するレッスン。
 * 1. セクション・レッスンの並び順で、未完了の最初のレッスン
 * 2. すべて完了済みなら、全セクションの中の最初のレッスン（最初のセクションが空でも次のセクションから選ぶ）
 * 3. レッスンが 0 件なら null
 */
export function pickInitialLesson<L>(
  sections: ReadonlyArray<SectionWithLessons<L>> | null | undefined,
  isCompleted: (lesson: L) => boolean
): L | null {
  const lessons = (sections ?? []).flatMap((s) => s?.lessons ?? []).filter((l): l is NonNullable<L> => l != null);
  return lessons.find((l) => !isCompleted(l)) ?? lessons[0] ?? null;
}
