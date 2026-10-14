import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import { toQuestionThreadView } from "@/lib/question-threads";
import { isValidQuestionId } from "@/lib/question-reply";
import {
  DELETE_LOG_MESSAGE,
  collectDescendantIds,
  deletedCommentKind,
  findRootQuestionId,
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

/**
 * rootId の下の返信（子・孫…）をすべて消し、消した件数を返す。rootId 自身は消さない。
 * 同じトランザクションの中で、parentId の in を 1 段ずつ繰り返して集める（lessonId では絞らない）。
 * 深さが上限（MAX_REPLY_DEPTH）を超えたら例外（500。削除はロールバックされる）。循環しても止まる
 */
async function deleteDescendantReplies(tx: Prisma.TransactionClient, rootId: string): Promise<number> {
  const ids = await collectDescendantIds(rootId, async (parentIds) => {
    const rows = await tx.comment.findMany({ where: { parentId: { in: parentIds } }, select: { id: true } });
    return rows.map((r) => r.id);
  });
  if (ids.length === 0) return 0;
  const result = await tx.comment.deleteMany({ where: { id: { in: ids } } });
  return result.count;
}

// 講師による質問・返信の削除（#47 P1）。[id] は質問または返信の id。講師専用（INSTRUCTOR 以外は DB を読む前に 403）。
// 物理削除。Comment.parentId の FK は ON DELETE SET NULL なので、質問・返信を消すときは、その下の返信（子孫）を
// 同じトランザクションで先に明示的に消す（lessonId では絞らない。別レッスンの lessonId を持つ古い返信や、
// #32 より前に作られうる返信への返信も消さないと、質問として浮き上がるため）。
// 応答：質問なら 200 { kind: "question", id, deletedReplies }、返信なら 200 { kind: "reply", id, thread }（削除後のスレッド）。
// 既に送った回答の通知には触れない（通知はコメントを参照していない。Tec 決定 C-a）。
// ログは固定文だけ（id・本文・名前を出さない。Tec 決定 E-a）。
// 確認と delete の間に別の講師が消した（delete が P2025）場合は 404。返信の削除後に親を読み直せない場合は 500（削除はロールバック）。
// トランザクションは Prisma の既定のタイムアウト（5 秒）で、超えたら P2028 で 500・ロールバックになる。
// 既知の残存リスク：子孫を集めてから delete するまでの間に、別の講師の回答が commit されると、その回答は SET NULL で質問として残りうる（設計のリスク 2、許容）
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
        const count = await deleteDescendantReplies(tx, target.id);
        await tx.comment.delete({ where: { id: target.id }, select: { id: true } });
        return count;
      });
      console.info(DELETE_LOG_MESSAGE.question);
      return NextResponse.json(questionDeletedResponse(target.id, deletedReplies), { status: 200 });
    }

    const parentId = target.parentId;
    const viewerId = session.user.id;
    const thread = await prisma.$transaction(async (tx) => {
      // 返信への返信（#32 より前のデータ）があれば、先に消す
      await deleteDescendantReplies(tx, target.id);
      await tx.comment.delete({ where: { id: target.id }, select: { id: true } });

      // 応答に使うスレッドの根の質問。返信への返信（#32 より前のデータ）を消した場合、親は中間の返信なので、
      // parentId を根までたどる（読む回数は MAX_REPLY_DEPTH 回まで。循環・上限超えは例外で 500・ロールバック）
      const rootId = await findRootQuestionId(parentId, (cur) =>
        tx.comment.findUnique({ where: { id: cur }, select: { parentId: true } })
      );
      if (!rootId) {
        // 親（または途中の返信）が見つからない（同時に質問ごと削除された等）。例外で削除をロールバックし、500 を返す
        throw new Error("Question thread not found after reply deletion");
      }

      // 応答に使うスレッド（GET /api/comments の 1 件と同じ select）。削除と同じトランザクションで読み直す
      const reread = await tx.comment.findUnique({
        where: { id: rootId },
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
        // 根の質問が見つからない（たどったあとに同時に削除された等）。例外で削除をロールバックし、500 を返す
        throw new Error("Question thread not found after reply deletion");
      }
      return reread;
    });
    console.info(DELETE_LOG_MESSAGE.reply);
    return NextResponse.json(replyDeletedResponse(target.id, toQuestionThreadView(thread, viewerId)), { status: 200 });
  } catch (error) {
    const summary = safeErrorSummary(error);
    if (summary.code === "P2025") {
      // 確認（findUnique）と delete の間に、別の講師が同じ質問・返信を消した。削除済みとして 404 を返す（成功のログは出さない）
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }
    console.error("DELETE /api/admin/comments/[id] error:", summary.name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
