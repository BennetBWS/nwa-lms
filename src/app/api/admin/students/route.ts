import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const session = await auth();
    if ((session?.user as any)?.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const totalLessons = await prisma.lesson.count();

    const students = await prisma.user.findMany({
      where: { role: "STUDENT" },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        createdAt: true,
        progress: {
          where: { completed: true },
          select: { completedAt: true },
          orderBy: { completedAt: "desc" },
        },
      },
      orderBy: { name: "asc" },
    });

    const result = students.map((student) => ({
      id: student.id,
      email: student.email,
      name: student.name,
      avatar: student.avatar,
      createdAt: student.createdAt,
      completedLessons: student.progress.length,
      totalLessons,
      lastActive: student.progress[0]?.completedAt ?? null,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch students:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
