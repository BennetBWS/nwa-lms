import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { currentCourseOf } from "@/lib/student-current-course";
import {
  parseStudentStatusFilter,
  studentListWhere,
  studentStatusOf,
} from "@/lib/student-status";

// Course structure for currentCourse (#32): lesson ids only, courses in display order.
const COURSE_LESSON_IDS_SELECT = {
  id: true,
  name: true,
  sections: { select: { lessons: { select: { id: true } } } },
} satisfies Prisma.CourseSelect;

/**
 * Latest non-null completedAt, or null. Not `progress[0]` of an orderBy desc: Postgres puts
 * NULL first in DESC, so a legacy row (completed, completedAt NULL) would hide the date.
 */
function latestCompletedAt(progress: ReadonlyArray<{ completedAt: Date | null }>): Date | null {
  let latest: Date | null = null;
  for (const { completedAt } of progress) {
    if (completedAt && (latest === null || completedAt.getTime() > latest.getTime())) latest = completedAt;
  }
  return latest;
}

// ?status=active (default) | deactivated | all (#7). Other values: 400.
export async function GET(request: Request) {
  try {
    const session = await auth();
    if (session?.user?.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const filter = parseStudentStatusFilter(new URL(request.url).searchParams.get("status"));
    if (filter === null) {
      return NextResponse.json(
        { error: "status must be one of: active, deactivated, all" },
        { status: 400 }
      );
    }

    const totalLessons = await prisma.lesson.count();
    const courses = await prisma.course.findMany({
      select: COURSE_LESSON_IDS_SELECT,
      orderBy: { order: "asc" },
    });

    const students = await prisma.user.findMany({
      where: studentListWhere(filter),
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        createdAt: true,
        deactivatedAt: true,
        // All completed rows (also legacy rows with completedAt NULL) count as completed,
        // like the student dashboard. No orderBy: lastActive is the max non-null completedAt.
        progress: {
          where: { completed: true },
          select: { completedAt: true, lessonId: true },
        },
      },
      orderBy: { name: "asc" },
    });

    const result = students.map((student) => {
      const { status, deactivatedAt } = studentStatusOf(student);
      return {
        id: student.id,
        email: student.email,
        name: student.name,
        avatar: student.avatar,
        createdAt: student.createdAt,
        completedLessons: student.progress.length,
        totalLessons,
        lastActive: latestCompletedAt(student.progress),
        status,
        deactivatedAt,
        // First course (by order) whose lessons are not all completed; null = all completed (#32).
        currentCourse: currentCourseOf(courses, new Set(student.progress.map((p) => p.lessonId))),
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch students:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
