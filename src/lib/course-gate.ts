/**
 * コースのロック（次の STEP に進めるか）の判定。規則はこのファイルだけで決める（#78 PR A）。
 *
 * サーバーの各 API（lesson-access.ts の loadCourseGates 経由）がこの結果を使い、画面は API が返す locked を表示するだけにする。
 * DB・時計に触れない純粋関数だけを置く。
 *
 * 今の規則（#32 / #47 の course-lock.ts の isCourseLocked と同じ。挙動は変えない）：
 * - courses は表示順（course-order.ts の COURSE_ORDER_BY の順）
 * - 最初のコースは開いている
 * - それ以外は、前のコースのレッスンが 1 件以上あってすべて完了しているか、
 *   このコースの完了が 1 件以上ある（開始済みは維持）なら開いている。どちらでもなければロック
 * - 前のコースにレッスンがない（0 件）場合は「前のコースを終えた」とみなさない（#41 の扱いのまま）
 *
 * #78 の後続の PR で、修了テストの合格・講師の承認（CourseApproval）を入力に足す。
 * そのときは CourseGateInput に項目を足し、CourseGateState に理由などを足す（呼び出し側は locked だけを見ていればよい）。
 */

export type CourseGateCourse = {
  id: string;
  sections: ReadonlyArray<{ lessons: ReadonlyArray<{ id: string }> }>;
};

export type CourseGateInput = {
  /** 表示順（COURSE_ORDER_BY の順）に並んだすべてのコース */
  courses: ReadonlyArray<CourseGateCourse>;
  /** この受講生が完了したレッスンの id */
  completedLessonIds: ReadonlySet<string>;
};

export type CourseGateState = {
  courseId: string;
  locked: boolean;
};

type Counts = { completed: number; total: number };

function countLessons(course: CourseGateCourse, completedLessonIds: ReadonlySet<string>): Counts {
  let total = 0;
  let completed = 0;
  for (const s of course.sections) {
    for (const l of s.lessons) {
      total++;
      if (completedLessonIds.has(l.id)) completed++;
    }
  }
  return { completed, total };
}

/** レッスンが 1 件以上あり、すべて完了している */
function isFinished(c: Counts): boolean {
  return c.total > 0 && c.completed >= c.total;
}

/**
 * コースごとのロックの状態。並びは input.courses と同じ（1 コースにつき 1 件）。
 * 同じ id のコースが複数あっても、それぞれ並び順どおりに判定する（DB では id は一意）。
 */
export function computeCourseGates(input: CourseGateInput): CourseGateState[] {
  const out: CourseGateState[] = [];
  let prev: Counts | null = null;
  for (const course of input.courses) {
    const counts = countLessons(course, input.completedLessonIds);
    const locked = prev !== null && !isFinished(prev) && !(counts.completed > 0);
    out.push({ courseId: course.id, locked });
    prev = counts;
  }
  return out;
}

/** 開いている（ロックされていない）コースの id（gates の並びのまま） */
export function unlockedCourseIdsOf(gates: ReadonlyArray<CourseGateState>): string[] {
  return gates.filter((g) => !g.locked).map((g) => g.courseId);
}
