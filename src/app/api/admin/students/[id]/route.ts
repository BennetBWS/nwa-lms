import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  DETAIL_ASSIGNMENT_SELECT,
  DETAIL_QUIZ_ATTEMPT_SELECT,
  DETAIL_USER_SELECT,
  detailCourseSelect,
  toAdminStudentDetail,
} from "@/lib/admin-student-detail";

// Student detail for the admin "生徒管理" page (#32). The response is built field by
// field in toAdminStudentDetail (no password / sessionVersion / avatar / answers /
// feedback / userId).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (session?.user?.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    // Students only (#7): other roles are answered with 404.
    const user = await prisma.user.findFirst({
      where: { id, role: "STUDENT" },
      select: DETAIL_USER_SELECT,
    });

    if (!user) {
      return NextResponse.json({ error: "Student not found" }, { status: 404 });
    }

    // Per-course progress (completed rows of this student only)
    const courses = await prisma.course.findMany({
      select: detailCourseSelect(id),
      orderBy: { order: "asc" },
    });

    const quizAttempts = await prisma.quizAttempt.findMany({
      where: { userId: id },
      select: DETAIL_QUIZ_ATTEMPT_SELECT,
      orderBy: { createdAt: "desc" },
    });

    const assignments = await prisma.assignment.findMany({
      where: { userId: id },
      select: DETAIL_ASSIGNMENT_SELECT,
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(toAdminStudentDetail({ user, courses, quizAttempts, assignments }));
  } catch (error) {
    console.error("Failed to fetch student detail:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
