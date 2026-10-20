import type { PrismaClient } from "@prisma/client";
import { COURSE_ORDER_BY } from "./course-order";
import { computeCourseGates, unlockedCourseIdsOf, type CourseGateState } from "./course-gate";
import { quizCourseId } from "./student-quizzes";

/**
 * 受講生がコース・レッスンを使えるか（コースのロック。#46、#47 P4、Tec 決定 2026-10-09 / D-a 2026-10-14）。
 *
 * コースのロックの規則は course-gate.ts の computeCourseGates だけで決める（#78 PR A）。
 * 判定に使うデータの読み込みは loadCourseGates だけで行い、ロックを返す API（GET /api/courses、GET /api/comments（一覧）、
 * GET /api/quizzes、GET /api/dashboard）とアクセスの確認（下の *AccessFor）はすべてその結果を使う。
 * 並び順は course-order.ts の COURSE_ORDER_BY（#47 P3）。
 *
 * 使う API（#47 P4）：POST /api/comments、POST /api/progress、GET /api/courses/[courseId]、GET /api/comments/[lessonId]。
 * （#47 P5）：GET /api/quizzes/[quizId]、POST /api/quizzes/[quizId]/submit（quizAccessFor）。
 * ここの関数はロールを見ない。講師を通す（確認しない）かどうかは呼び出し側が決める。
 * prisma は引数で受け取る（student-status.ts と同じ書き方。テストでは偽物を渡す）。
 */

export type LessonAccessDb = Pick<PrismaClient, "lesson" | "course" | "progress">;

/** コースの確認だけに使う（lesson は読まない） */
export type CourseAccessDb = Pick<PrismaClient, "course" | "progress">;

/** クイズの確認に使う（quiz からコースを決め、コースのロックを読む。#47 P5） */
export type QuizAccessDb = Pick<PrismaClient, "quiz" | "course" | "progress">;

export type LessonAccess = "ok" | "locked" | "not_found";

export type CourseAccess = LessonAccess;

export type QuizAccess = LessonAccess;

/** ロック中のコースを拒否するときの理由（403 の body の reason。CommentPostRejectReason の course_locked と同じ値） */
export type CourseLockedReason = "course_locked";

export const COURSE_LOCKED_REASON: CourseLockedReason = "course_locked";

/**
 * userId の受講生にとっての、すべてのコース（COURSE_ORDER_BY の順）のロックの状態（#78 PR A）。
 * 読むのはコースとレッスンの id と、自分の完了だけ。ロールは見ない（講師を通すかどうかは呼び出し側が決める）。
 */
export async function loadCourseGates(db: CourseAccessDb, userId: string): Promise<CourseGateState[]> {
  const [courses, progress] = await Promise.all([
    db.course.findMany({
      orderBy: COURSE_ORDER_BY,
      select: { id: true, sections: { select: { lessons: { select: { id: true } } } } },
    }),
    db.progress.findMany({
      where: { userId, completed: true },
      select: { lessonId: true },
    }),
  ]);
  return computeCourseGates({ courses, completedLessonIds: new Set(progress.map((p) => p.lessonId)) });
}

/** userId の受講生にとって解放済み（ロックされていない）コースの id（表示順） */
export async function unlockedCourseIdsFor(db: CourseAccessDb, userId: string): Promise<string[]> {
  return unlockedCourseIdsOf(await loadCourseGates(db, userId));
}

/**
 * userId の受講生にとって、courseId のコースが使えるか。
 * - コースがなければ not_found
 * - ロック中なら locked
 * - それ以外は ok
 */
export async function courseAccessFor(db: CourseAccessDb, userId: string, courseId: string): Promise<CourseAccess> {
  const gate = (await loadCourseGates(db, userId)).find((g) => g.courseId === courseId);
  if (!gate) return "not_found";
  return gate.locked ? "locked" : "ok";
}

/**
 * userId の受講生にとって、lessonId のレッスンが使えるか。
 * - レッスンがなければ not_found（コースやロックの状態は読まない）
 * - レッスンのコースがロック中なら locked
 * - それ以外は ok
 */
export async function lessonAccessFor(db: LessonAccessDb, userId: string, lessonId: string): Promise<LessonAccess> {
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: { section: { select: { courseId: true } } },
  });
  if (!lesson) return "not_found";

  const unlocked = await unlockedCourseIdsFor(db, userId);
  return unlocked.includes(lesson.section.courseId) ? "ok" : "locked";
}

/**
 * userId の受講生にとって、quizId のクイズが使えるか（#47 P5、Tec 決定 D-a・F-a）。
 * コースは student-quizzes.ts の quizCourseId（一覧 GET /api/quizzes の振り分けと同じ規則）：
 * 修了テスト（FINAL）は quiz.courseId、ミニテスト（MINI）はレッスンのコース。
 * - クイズがない、規則で決まるコースがない、そのコースがない：not_found（コースが決まらなければコースや進捗は読まない）
 * - コースがロック中なら locked
 * - それ以外は ok
 * 読むのはコースを決める列だけ（問題文・選択肢・正解は読まない）。
 */
export async function quizAccessFor(db: QuizAccessDb, userId: string, quizId: string): Promise<QuizAccess> {
  const quiz = await db.quiz.findUnique({
    where: { id: quizId },
    select: { type: true, courseId: true, lesson: { select: { section: { select: { courseId: true } } } } },
  });
  if (!quiz) return "not_found";

  const courseId = quizCourseId(quiz);
  if (!courseId) return "not_found";
  return courseAccessFor(db, userId, courseId);
}

// ───────────── GET /api/courses の応答 ─────────────

/**
 * ロック中のコースのレッスンに残す項目（#47 P4、reviewer 指摘で除外リストから許可リストに変更）。
 * 画面（page.tsx の CourseList・LessonView）がロック中のコースで使うのは、ロック計算（course-lock の countCourseLessons）と
 * 一覧表示に要るレッスンの数・completed だけ。id・sectionId・title・type・duration・order は表示用の見出しとして残す。
 * ここにない項目（videoUrl・content・pdfUrl や、将来 Lesson に足す列）は出さない。
 * Lesson に列を足したら lesson-access.schema.test.ts が落ちるので、ロック中に出すかを決めてどちらかの一覧に入れる。
 */
export const LOCKED_LESSON_VISIBLE_FIELDS = ["id", "sectionId", "title", "type", "duration", "order", "completed"] as const;

type VisibleField = (typeof LOCKED_LESSON_VISIBLE_FIELDS)[number];

/**
 * ロック中のコースのレッスンを、LOCKED_LESSON_VISIBLE_FIELDS の項目だけにする（それ以外は値が null でも項目ごと除く）。
 * 元のオブジェクトは変えない。
 */
export function hideLockedLessonContent<L extends object>(lesson: L): Pick<L, Extract<keyof L, VisibleField>> {
  const visible: ReadonlyArray<string> = LOCKED_LESSON_VISIBLE_FIELDS;
  return Object.fromEntries(Object.entries(lesson).filter(([k]) => visible.includes(k))) as Pick<L, Extract<keyof L, VisibleField>>;
}
