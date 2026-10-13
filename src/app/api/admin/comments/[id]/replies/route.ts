import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { toQuestionThreadView } from "@/lib/question-threads";
import {
  REPLY_NOTIFICATION_TITLE,
  isValidQuestionId,
  parseReplyBody,
  replyNotificationMessage,
  shouldNotifyQuestionAuthor,
} from "@/lib/question-reply";

// 1 件ごとに読む項目。user は name・role・deactivatedAt だけ（応答には含めない。GET /api/comments と同じ）
const COMMENT_SELECT = {
  id: true,
  content: true,
  createdAt: true,
  userId: true,
  user: { select: { name: true, role: true, deactivatedAt: true } },
} as const;

// 講師の回答（#32 A-1）。[id] は親の質問の id。講師専用（INSTRUCTOR 以外は DB を読む前に 403）。
// 返信の lessonId は親と同じ値を使い、クライアントからは受け取らない。
// 質問の投稿者が「回答者本人でない・STUDENT・無効化されていない」ときだけ、同じトランザクションで通知を作る
// （無効化された受講生の質問にも回答できるが、通知は作らない。Tec 決定 2026-10-09）。
// 応答は 201 { thread }（GET /api/comments の 1 件と同じ QuestionThreadView）。編集・削除の API はない
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.user.role !== "INSTRUCTOR") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    if (!isValidQuestionId(id)) {
      return NextResponse.json({ error: "Invalid request", reason: "invalid_id" }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request", reason: "invalid_body" }, { status: 400 });
    }
    const parsed = parseReplyBody(body);
    // tsconfig は strict: false なので ok では絞り込めない。"reason" in で失敗側に絞る
    if ("reason" in parsed) {
      return NextResponse.json({ error: "Invalid request", reason: parsed.reason }, { status: 400 });
    }
    const { content } = parsed.value;

    const parent = await prisma.comment.findUnique({
      where: { id },
      select: {
        id: true,
        parentId: true,
        lessonId: true,
        userId: true,
        user: { select: { role: true, deactivatedAt: true } },
        lesson: { select: { title: true, section: { select: { course: { select: { name: true } } } } } },
      },
    });
    if (!parent) {
      return NextResponse.json({ error: "Question not found" }, { status: 404 });
    }
    if (parent.parentId !== null) {
      return NextResponse.json({ error: "Invalid request", reason: "not_a_question" }, { status: 400 });
    }

    const replierId = session.user.id;
    // 通知の判定はトランザクションの外で行う（READ COMMITTED では中に移しても無効化との競合を完全には防げず、無効化された受講生は通知を見られないので影響が小さい）
    const notify = shouldNotifyQuestionAuthor(
      { id: parent.userId, role: parent.user.role, deactivatedAt: parent.user.deactivatedAt },
      replierId
    );

    const thread = await prisma.$transaction(async (tx) => {
      await tx.comment.create({
        data: { userId: replierId, lessonId: parent.lessonId, content, parentId: parent.id },
        select: { id: true },
      });
      if (notify) {
        await tx.notification.create({
          data: {
            userId: parent.userId,
            title: REPLY_NOTIFICATION_TITLE,
            message: replyNotificationMessage(parent.lesson.section.course.name, parent.lesson.title),
          },
          select: { id: true },
        });
      }

      // 応答に使うスレッド（GET /api/comments の 1 件と同じ select）。作成と同じトランザクションで読み直す
      const reread = await tx.comment.findUnique({
        where: { id: parent.id },
        select: {
          ...COMMENT_SELECT,
          lesson: { select: { id: true, title: true, section: { select: { course: { select: { id: true, name: true } } } } } },
          // 親と同じレッスンの返信だけを使う（toQuestionThreadView で lessonId を見て絞る）
          replies: {
            select: { ...COMMENT_SELECT, lessonId: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      });
      if (!reread) {
        // 親が途中で消えた（削除の API はないので通常は起きない）。例外で回答と通知をロールバックし、500 を返す
        throw new Error("Question thread not found after reply");
      }
      return reread;
    });

    return NextResponse.json({ thread: toQuestionThreadView(thread, replierId) }, { status: 201 });
  } catch (error) {
    console.error("POST /api/admin/comments/[id]/replies error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
