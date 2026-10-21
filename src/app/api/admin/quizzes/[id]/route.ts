import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { isValidId } from "@/lib/lesson-comments";
import { quizCourseId } from "@/lib/student-quizzes";
import { buildAdminQuizDetail } from "@/lib/admin-quizzes";
import { questionRevision } from "@/lib/admin-quiz-revision";

function noStoreJson(body: unknown, init: { status: number }) {
  return NextResponse.json(body, { status: init.status, headers: { "Cache-Control": "no-store" } });
}

// クイズ管理の詳細（#81 Q1）。講師専用（未ログインは 401、講師以外は 403。どちらも DB を読む前に返す）。
// 応答は AdminQuizDetail（src/lib/admin-quizzes.ts の buildAdminQuizDetail が許可リストで組み立てる）。
// 問題は [order, id] の順（受験と同じ並び）、選択肢は元の並び（シャッフルしない）。問題ごとに valid と revision
// （内容の sha256。秘密の鍵は使わない。PATCH /api/admin/questions/[id] の楽観ロックに使う）を付ける。
// コース名は quizCourseId（受講生の一覧・ロックと同じ規則）のコースを id で 1 件読む。なければ null（状態は no_course）。
// PUT・DELETE は #81 Q3 で閉じた（戻さない）。ログはエラー名だけ。応答は Cache-Control: no-store
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return noStoreJson({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.user.role !== "INSTRUCTOR") {
      return noStoreJson({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    if (!isValidId(id)) {
      return noStoreJson({ error: "Invalid request", reason: "invalid_id" }, { status: 400 });
    }

    const quiz = await prisma.quiz.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        type: true,
        courseId: true,
        lesson: { select: { title: true, section: { select: { courseId: true } } } },
        questions: {
          orderBy: [{ order: "asc" }, { id: "asc" }],
          select: { id: true, order: true, question: true, options: true, correctIndex: true },
        },
        _count: { select: { attempts: true } },
      },
    });
    if (!quiz) {
      return noStoreJson({ error: "Quiz not found" }, { status: 404 });
    }

    const courseId = quizCourseId(quiz);
    const course = courseId === null
      ? null
      : await prisma.course.findUnique({ where: { id: courseId }, select: { name: true } });

    return noStoreJson(buildAdminQuizDetail(quiz, course?.name ?? null, questionRevision), { status: 200 });
  } catch (error) {
    const summary = safeErrorSummary(error);
    if (summary.code === "P2025") {
      return noStoreJson({ error: "Quiz not found" }, { status: 404 });
    }
    console.error("GET /api/admin/quizzes/[id] error:", summary.name);
    return noStoreJson({ error: "Internal server error" }, { status: 500 });
  }
}
