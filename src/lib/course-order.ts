import type { Prisma } from "@prisma/client";

/**
 * コース・セクション・レッスンの並び順（#47 P3、Tec 決定 G-a）。
 *
 * order が同じ行があっても、すべての API で同じ順になるように id で同点を決める（[order, id]）。
 * 並び順が API ごとに違うと、画面のロック表示（course-lock の isCourseLocked を API の並びで計算）と
 * サーバーの判定（question-threads の unlockedCourseIds など）が食い違う。
 * Course / Section / Lesson を orderBy で並べるときは、必ずこの定数を使う（scripts/lib/course-order.test.ts で確かめる）。
 * 一意制約は付けない（スキーマは変えない）。
 */

export const COURSE_ORDER_BY: Prisma.CourseOrderByWithRelationInput[] = [{ order: "asc" }, { id: "asc" }];

export const SECTION_ORDER_BY: Prisma.SectionOrderByWithRelationInput[] = [{ order: "asc" }, { id: "asc" }];

export const LESSON_ORDER_BY: Prisma.LessonOrderByWithRelationInput[] = [{ order: "asc" }, { id: "asc" }];
