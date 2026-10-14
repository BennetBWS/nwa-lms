import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { COURSE_ORDER_BY, SECTION_ORDER_BY } from "@/lib/course-order";

export async function GET() {
  try {
    const session = await auth();
    if ((session?.user as any)?.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const courses = await prisma.course.findMany({
      include: {
        sections: {
          orderBy: SECTION_ORDER_BY,
          include: {
            _count: { select: { lessons: true } },
          },
        },
        _count: { select: { sections: true } },
      },
      orderBy: COURSE_ORDER_BY,
    });

    const result = courses.map((course) => ({
      ...course,
      sectionCount: course._count.sections,
      lessonCount: course.sections.reduce(
        (sum, section) => sum + section._count.lessons,
        0
      ),
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch courses:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if ((session?.user as any)?.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { name, description, order, icon, color } = body;

    const course = await prisma.course.create({
      data: { name, description, order, icon, color },
    });

    return NextResponse.json(course, { status: 201 });
  } catch (error) {
    console.error("Failed to create course:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
