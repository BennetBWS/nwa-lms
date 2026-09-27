import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  parseStudentStatusFilter,
  studentListWhere,
  studentStatusOf,
} from "@/lib/student-status";

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

    const students = await prisma.user.findMany({
      where: studentListWhere(filter),
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        createdAt: true,
        deactivatedAt: true,
        progress: {
          where: { completed: true },
          select: { completedAt: true },
          orderBy: { completedAt: "desc" },
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
        lastActive: student.progress[0]?.completedAt ?? null,
        status,
        deactivatedAt,
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
