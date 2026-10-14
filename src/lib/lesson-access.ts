import type { PrismaClient } from "@prisma/client";
import { unlockedCourseIds } from "./question-threads";

/**
 * 受講生がレッスンを使えるか（コースのロック。#46、Tec 決定 2026-10-09）。
 *
 * コースのロックは course-lock.ts / question-threads.ts の unlockedCourseIds と同じ考え方：
 * コースを order（同じなら id）の順に並べ、前のコースを全部終えておらず、
 * このコースが未着手（完了 0 件）ならロック。最初のコースはロックしない。
 *
 * 今は POST /api/comments だけが使う（GET 側を揃えるのは #47）。
 * prisma は引数で受け取る（student-status.ts と同じ書き方。テストでは偽物を渡す）。
 */

export type LessonAccessDb = Pick<PrismaClient, "lesson" | "course" | "progress">;

export type LessonAccess = "ok" | "locked" | "not_found";

/**
 * userId の受講生にとって、lessonId のレッスンが使えるか。
 * - レッスンがなければ not_found（コースやロックの状態は読まない）
 * - レッスンのコースがロック中なら locked
 * - それ以外は ok
 * ロールは見ない（講師を通すかどうかは呼び出し側が決める）
 */
export async function lessonAccessFor(db: LessonAccessDb, userId: string, lessonId: string): Promise<LessonAccess> {
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: { section: { select: { courseId: true } } },
  });
  if (!lesson) return "not_found";

  const [courses, progress] = await Promise.all([
    db.course.findMany({
      orderBy: [{ order: "asc" }, { id: "asc" }],
      select: { id: true, sections: { select: { lessons: { select: { id: true } } } } },
    }),
    db.progress.findMany({
      where: { userId, completed: true },
      select: { lessonId: true },
    }),
  ]);
  const unlocked = unlockedCourseIds(courses, new Set(progress.map((p) => p.lessonId)));
  return unlocked.includes(lesson.section.courseId) ? "ok" : "locked";
}
