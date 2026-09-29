import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { countCompletedSince, pickNextLessons, summarizeCourses } from "@/lib/student-dashboard";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;
    const now = new Date();

    const [courses, userProgress, recentActivity, notifications] =
      await Promise.all([
        prisma.course.findMany({
          orderBy: { order: "asc" },
          select: {
            id: true,
            name: true,
            icon: true,
            color: true,
            order: true,
            sections: {
              orderBy: [{ order: "asc" }, { id: "asc" }],
              select: {
                id: true,
                order: true,
                lessons: {
                  orderBy: [{ order: "asc" }, { id: "asc" }],
                  select: { id: true, title: true, order: true },
                },
              },
            },
          },
        }),
        prisma.progress.findMany({
          where: { userId, completed: true },
          select: { lessonId: true, completed: true, completedAt: true },
        }),
        // completedAt が NULL の行は Postgres の DESC で先頭に来るため除く
        prisma.progress.findMany({
          where: { userId, completed: true, completedAt: { not: null } },
          orderBy: [{ completedAt: "desc" }, { id: "desc" }],
          take: 5,
          select: {
            completedAt: true,
            lesson: {
              select: {
                title: true,
                section: {
                  select: {
                    course: { select: { name: true } },
                  },
                },
              },
            },
          },
        }),
        prisma.notification.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, title: true, message: true, read: true, createdAt: true },
        }),
      ]);

    const unreadNotifications = await prisma.notification.count({
      where: { userId, read: false },
    });

    const completedLessonIds = new Set(userProgress.map((p) => p.lessonId));
    const summary = summarizeCourses(courses, completedLessonIds);

    const recentActivityData = recentActivity.map((p) => ({
      lessonTitle: p.lesson.title,
      courseName: p.lesson.section.course.name,
      completedAt: p.completedAt,
    }));

    return NextResponse.json({
      activeCourses: summary.activeCourses,
      completedLessons: summary.completedLessons,
      totalLessons: summary.totalLessons,
      overallProgress: summary.overallProgress,
      completedLast7Days: countCompletedSince(userProgress, now),
      courses: summary.courses,
      nextLessons: pickNextLessons(courses, completedLessonIds),
      recentActivity: recentActivityData,
      unreadNotifications,
      notifications,
    });
  } catch (error) {
    console.error("GET /api/dashboard error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
