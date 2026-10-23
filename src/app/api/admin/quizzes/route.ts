import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { COURSE_ORDER_BY } from "@/lib/course-order";
import { safeErrorSummary } from "@/lib/safe-error";
import { buildAdminQuizList, type AdminQuizListResponse } from "@/lib/admin-quizzes";

function noStoreJson(body: unknown, init: { status: number }) {
  return NextResponse.json(body, { status: init.status, headers: { "Cache-Control": "no-store" } });
}

// クイズ管理の一覧（#81 Q1）。講師専用（未ログインは 401、講師以外は 403。どちらも DB を読む前に返す）。
// 応答は { quizzes: AdminQuizSummary[] }（項目は src/lib/admin-quizzes.ts の buildAdminQuizList が許可リストで組み立てる）。
// 並びはコース（COURSE_ORDER_BY）→ 修了テスト → ミニテスト、コースなしは最後。状態は ok / unavailable / no_course。
// 選択肢・正解は状態の判定だけに読み、応答には含めない。POST は #81 Q3 で閉じた（戻さない）。
// ログはエラー名だけ。応答は Cache-Control: no-store
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return noStoreJson({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.user.role !== "INSTRUCTOR") {
      return noStoreJson({ error: "Forbidden" }, { status: 403 });
    }

    const [courses, quizzes] = await Promise.all([
      prisma.course.findMany({
        orderBy: COURSE_ORDER_BY,
        select: { id: true, name: true },
      }),
      prisma.quiz.findMany({
        select: {
          id: true,
          title: true,
          type: true,
          courseId: true,
          lesson: {
            select: {
              id: true,
              title: true,
              order: true,
              section: { select: { id: true, order: true, courseId: true } },
            },
          },
          // 状態（受験できるか）の判定と問題数だけに使う。応答には選択肢・正解を出さない
          questions: { select: { options: true, correctIndex: true } },
          _count: { select: { attempts: true } },
        },
      }),
    ]);

    const body: AdminQuizListResponse = { quizzes: buildAdminQuizList(courses, quizzes) };
    return noStoreJson(body, { status: 200 });
  } catch (error) {
    console.error("GET /api/admin/quizzes error:", safeErrorSummary(error).name);
    return noStoreJson({ error: "Internal server error" }, { status: 500 });
  }
}
