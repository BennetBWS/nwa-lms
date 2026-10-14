import type { PrismaClient } from "@prisma/client";
import { COURSE_ORDER_BY } from "./course-order";
import { unlockedCourseIds } from "./question-threads";

/**
 * 受講生がコース・レッスンを使えるか（コースのロック。#46、#47 P4、Tec 決定 2026-10-09 / D-a 2026-10-14）。
 *
 * コースのロックは course-lock.ts / question-threads.ts の unlockedCourseIds と同じ考え方：
 * コースを order（同じなら id）の順に並べ、前のコースを全部終えておらず、
 * このコースが未着手（完了 0 件）ならロック。最初のコースはロックしない。
 * 並び順は course-order.ts の COURSE_ORDER_BY（画面のロック表示と同じ並び。#47 P3）。
 *
 * 使う API（#47 P4）：POST /api/comments、POST /api/progress、GET /api/courses/[courseId]、GET /api/comments/[lessonId]。
 * GET /api/courses と GET /api/comments（一覧）は、読んだコースから question-threads の unlockedCourseIds で計算する。
 * ここの関数はロールを見ない。講師を通す（確認しない）かどうかは呼び出し側が決める。
 * prisma は引数で受け取る（student-status.ts と同じ書き方。テストでは偽物を渡す）。
 */

export type LessonAccessDb = Pick<PrismaClient, "lesson" | "course" | "progress">;

/** コースの確認だけに使う（lesson は読まない） */
export type CourseAccessDb = Pick<PrismaClient, "course" | "progress">;

export type LessonAccess = "ok" | "locked" | "not_found";

export type CourseAccess = LessonAccess;

/** ロック中のコースを拒否するときの理由（403 の body の reason。CommentPostRejectReason の course_locked と同じ値） */
export type CourseLockedReason = "course_locked";

export const COURSE_LOCKED_REASON: CourseLockedReason = "course_locked";

/** すべてのコース（表示順）と、userId の受講生にとって解放済みのコース id */
async function loadCourseLocks(db: CourseAccessDb, userId: string): Promise<{ courseIds: string[]; unlocked: string[] }> {
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
  return {
    courseIds: courses.map((c) => c.id),
    unlocked: unlockedCourseIds(courses, new Set(progress.map((p) => p.lessonId))),
  };
}

/** userId の受講生にとって解放済み（ロックされていない）コースの id（表示順） */
export async function unlockedCourseIdsFor(db: CourseAccessDb, userId: string): Promise<string[]> {
  return (await loadCourseLocks(db, userId)).unlocked;
}

/**
 * userId の受講生にとって、courseId のコースが使えるか。
 * - コースがなければ not_found
 * - ロック中なら locked
 * - それ以外は ok
 */
export async function courseAccessFor(db: CourseAccessDb, userId: string, courseId: string): Promise<CourseAccess> {
  const { courseIds, unlocked } = await loadCourseLocks(db, userId);
  if (!courseIds.includes(courseId)) return "not_found";
  return unlocked.includes(courseId) ? "ok" : "locked";
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

// ───────────── GET /api/courses の応答 ─────────────

/** ロック中のコースのレッスンから除く項目（本文・動画・資料。#47 P4） */
export const LOCKED_LESSON_HIDDEN_FIELDS = ["videoUrl", "content", "pdfUrl"] as const;

type HiddenField = (typeof LOCKED_LESSON_HIDDEN_FIELDS)[number];

/**
 * ロック中のコースのレッスンを、画面のロック計算に要る項目だけにする（videoUrl・content・pdfUrl を除く）。
 * それ以外の項目（id・title・type・completed など）はそのまま残す。元のオブジェクトは変えない。
 */
export function hideLockedLessonContent<L extends object>(lesson: L): Omit<L, HiddenField> {
  const hidden: ReadonlyArray<string> = LOCKED_LESSON_HIDDEN_FIELDS;
  return Object.fromEntries(Object.entries(lesson).filter(([k]) => !hidden.includes(k))) as Omit<L, HiddenField>;
}
