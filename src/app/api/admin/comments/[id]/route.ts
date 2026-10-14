import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { toQuestionThreadView } from "@/lib/question-threads";
import { isValidQuestionId } from "@/lib/question-reply";
import {
  DELETE_LOG_MESSAGE,
  deletedCommentKind,
  questionDeletedResponse,
  replyDeletedResponse,
} from "@/lib/admin-comment-delete";

// 1 件ごとに読む項目。user は name・role・deactivatedAt だけ（応答には含めない。GET /api/comments・回答 API と同じ）
const COMMENT_SELECT = {
  id: true,
  content: true,
  createdAt: true,
  userId: true,
  user: { select: { name: true, role: true, deactivatedAt: true } },
} as const;

// 講師による質問・返信の削除（#47 P1）。[id] は質問または返信の id。講師専用（INSTRUCTOR 以外は DB を読む前に 403）。
// 物理削除。Comment.parentId の FK は ON DELETE SET NULL なので、質問を消すときは返信を同じトランザクションで明示的に消す
// （lessonId では絞らない。別レッスンの lessonId を持つ古い返信も消さないと、質問として浮き上がるため）。
// 応答：質問なら 200 { kind: "question", id, deletedReplies }、返信なら 200 { kind: "reply", id, thread }（削除後のスレッド）。
// 既に送った回答の通知には触れない（通知はコメントを参照していない。Tec 決定 C-a）。
// ログは固定文だけ（id・本文・名前を出さない。Tec 決定 E-a）。
// 既知の残存リスク：deleteMany と delete の間に回答が commit されると、その回答は SET NULL で質問として残る（設計のリスク 2、許容）
export async function DELETE(
  _request: Request,
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

    const target = await prisma.comment.findUnique({
      where: { id },
      select: { id: true, parentId: true },
    });
    if (!target) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }

    const kind = deletedCommentKind(target);

    if (kind === "question") {
      const deletedReplies = await prisma.$transaction(async (tx) => {
        const replies = await tx.comment.deleteMany({ where: { parentId: target.id } });
        await tx.comment.delete({ where: { id: target.id }, select: { id: true } });
        return replies.count;
      });
      console.info(DELETE_LOG_MESSAGE.question);
      return NextResponse.json(questionDeletedResponse(target.id, deletedReplies), { status: 200 });
    }

    const parentId = target.parentId;
    const viewerId = session.user.id;
    const thread = await prisma.$transaction(async (tx) => {
      await tx.comment.delete({ where: { id: target.id }, select: { id: true } });

      // 応答に使うスレッド（GET /api/comments の 1 件と同じ select）。削除と同じトランザクションで読み直す
      const reread = await tx.comment.findUnique({
        where: { id: parentId },
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
        // 親が見つからない（同時に質問ごと削除された等）。例外で削除をロールバックし、500 を返す
        throw new Error("Question thread not found after reply deletion");
      }
      return reread;
    });
    console.info(DELETE_LOG_MESSAGE.reply);
    return NextResponse.json(replyDeletedResponse(target.id, toQuestionThreadView(thread, viewerId)), { status: 200 });
  } catch (error) {
    console.error("DELETE /api/admin/comments/[id] error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
