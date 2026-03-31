import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    const [courses, userProgress, recentActivity, notifications] =
      await Promise.all([
        prisma.course.findMany({
          orderBy: { order: "asc" },
          include: {
            sections: {
              include: {
                lessons: { select: { id: true } },
              },
            },
          },
        }),
        prisma.progress.findMany({
          where: { userId, completed: true },
          select: { lessonId: true },
        }),
        prisma.progress.findMany({
          where: { userId, completed: true },
          orderBy: { completedAt: "desc" },
          take: 5,
          include: {
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
        }),
      ]);

    const unreadNotifications = await prisma.notification.count({
      where: { userId, read: false },
    });

    const completedLessonIds = new Set(
      userProgress.map((p) => p.lessonId)
    );

    let totalLessons = 0;
    let completedLessons = 0;
    let activeCourses = 0;

    const coursesData = courses.map((course) => {
      let courseTotalLessons = 0;
      let courseCompletedLessons = 0;

      for (const section of course.sections) {
        for (const lesson of section.lessons) {
          courseTotalLessons++;
          totalLessons++;
          if (completedLessonIds.has(lesson.id)) {
            courseCompletedLessons++;
            completedLessons++;
          }
        }
      }

      const progress =
        courseTotalLessons > 0
          ? Math.round((courseCompletedLessons / courseTotalLessons) * 100)
          : 0;

      if (courseCompletedLessons > 0 && courseCompletedLessons < courseTotalLessons) {
        activeCourses++;
      }

      return {
        id: course.id,
        name: course.name,
        icon: course.icon,
        color: course.color,
        order: course.order,
        progress,
        totalLessons: courseTotalLessons,
        completedLessons: courseCompletedLessons,
      };
    });

    const overallProgress =
      totalLessons > 0
        ? Math.round((completedLessons / totalLessons) * 100)
        : 0;

    const recentActivityData = recentActivity.map((p) => ({
      lessonTitle: p.lesson.title,
      courseName: p.lesson.section.course.name,
      completedAt: p.completedAt,
    }));

    return NextResponse.json({
      activeCourses,
      completedLessons,
      totalLessons,
      overallProgress,
      weeklyHours: 8,
      courses: coursesData,
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
