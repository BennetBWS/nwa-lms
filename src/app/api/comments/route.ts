import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import type { Prisma } from "@prisma/client";
import { parseCreateComment, toCommentThreadView, type CommentPostRejectReason } from "@/lib/lesson-comments";
import { COMMENT_DAILY_LIMIT, commentWindowStart, decideCommentRate } from "@/lib/comment-rate-limit";
import { lessonAccessFor, unlockedCourseIdsFor } from "@/lib/lesson-access";
import {
  THREADS_PAGE_SIZE,
  encodeThreadCursor,
  isAnswered,
  parseThreadListQuery,
  toQuestionThreadView,
} from "@/lib/question-threads";

// 1 件ごとに読む項目。user は name・role・deactivatedAt だけ（応答には含めない。#32）
const COMMENT_SELECT = {
  id: true,
  content: true,
  createdAt: true,
  userId: true,
  user: { select: { name: true, role: true, deactivatedAt: true } },
} as const;

// 質問スレッド一覧（#32）。親の質問を新しい順に 20 件ずつ（カーソル方式）。読み取りだけ（投稿は下の POST。#46）。
// 受講生には、自分にとってロック中のコースの質問を返さない（自分の質問は常に返す）。講師はロックなし。
// 絞り込み：mine（自分の質問）・status（answered / unanswered）・courseId
// status の回答済み／未回答は、DB で 21 件読んだ後に JS で「親と同じレッスンの返信」だけで判定して絞る。
// そのため 1 ページが 20 件より少ないことも、0 件なのに nextCursor があることもある（画面は続きを読めるようにする）
export async function GET(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = parseThreadListQuery(new URL(request.url).searchParams);
    // tsconfig は strict: false なので ok では絞り込めない。"reason" in で失敗側に絞る
    if ("reason" in parsed) {
      return NextResponse.json({ error: "Invalid request", reason: parsed.reason }, { status: 400 });
    }
    const { mine, status, courseId, cursor } = parsed.value;
    const userId = session.user.id;

    const and: Prisma.CommentWhereInput[] = [];
    if (session.user.role !== "INSTRUCTOR") {
      // ロックは lesson-access の loadCourseGates（course-gate.ts の規則。#78 PR A）
      const unlocked = await unlockedCourseIdsFor(prisma, userId);
      and.push({ OR: [{ userId }, { lesson: { section: { courseId: { in: unlocked } } } }] });
    }
    if (mine) and.push({ userId });
    if (courseId !== null) and.push({ lesson: { section: { courseId } } });
    // answered は DB で別レッスンの返信も含めて絞り、下で同じレッスンの返信だけで判定し直す。
    // unanswered は DB では講師の返信で絞らない（別レッスンの講師の返信しかない質問を落とさないため）。下の判定だけで絞る
    if (status === "answered") and.push({ replies: { some: { user: { role: "INSTRUCTOR" } } } });
    if (cursor !== null) {
      and.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });
    }

    const rows = await prisma.comment.findMany({
      where: { parentId: null, AND: and },
      select: {
        ...COMMENT_SELECT,
        lesson: { select: { id: true, title: true, section: { select: { course: { select: { id: true, name: true } } } } } },
        // 親と同じレッスンの返信だけを使う（toQuestionThreadView で lessonId を見て絞る）
        replies: {
          select: { ...COMMENT_SELECT, lessonId: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: THREADS_PAGE_SIZE + 1,
    });

    const page = rows.slice(0, THREADS_PAGE_SIZE);
    const last = page[page.length - 1];
    // カーソルは判定し直す前の最後の行（次のページが同じ並びの続きになる）
    const nextCursor = rows.length > THREADS_PAGE_SIZE && last ? encodeThreadCursor(last.createdAt, last.id) : null;
    const shown =
      status === "all" ? page : page.filter((r) => isAnswered(r) === (status === "answered"));

    return NextResponse.json({
      threads: shown.map((r) => toQuestionThreadView(r, userId)),
      nextCursor,
    });
  } catch (error) {
    console.error("GET /api/comments error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}


// 受講生が親の質問を投稿する（#46。画面の投稿欄は B-2）。入力と 201 の応答（CommentThreadView）の形は #32 と同じ。
// 判定の順（DB をなるべく読まない順。拒否の理由に他人の投稿の情報を含めない）：
// 1. 未ログイン 401
// 2. 受講生以外 403 forbidden_role（講師の回答は POST /api/admin/comments/[id]/replies に一本化）
// 3. 入力検証 400（parseCreateComment。本文の NUL・対になっていないサロゲートは invalid_characters。#86）。
//    id も同じく使えない文字を断る（parentId に含まれると 403 reply_not_allowed より先に 400 invalid_parent_id）
// 4. parentId 付き 403 reply_not_allowed（受講生は返信できない。親の存在は確かめない）
// 5. 自分の直近の投稿だけを読み、連投 409 duplicate / 429 rate_limited（comment-rate-limit.ts）
// 6. レッスンがない 404、ロック中のコース 403 course_locked（lesson-access.ts）
// 同時に送られた投稿が両方とも 5 を通り抜ける競合は許容する（DB の関数やロックは使わない）
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.user.role !== "STUDENT") {
      return NextResponse.json({ error: "Forbidden", reason: "forbidden_role" satisfies CommentPostRejectReason }, { status: 403 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = parseCreateComment(body);
    // tsconfig は strict: false なので ok では絞り込めない。"reason" in で失敗側に絞る
    if ("reason" in parsed) {
      return NextResponse.json({ error: "Invalid request", reason: parsed.reason }, { status: 400 });
    }
    const { lessonId, content, parentId } = parsed.value;

    if (parentId !== null) {
      return NextResponse.json({ error: "Forbidden", reason: "reply_not_allowed" satisfies CommentPostRejectReason }, { status: 403 });
    }

    const userId = session.user.id;
    const now = new Date();
    const recent = await prisma.comment.findMany({
      where: { userId, createdAt: { gt: commentWindowStart(now) } },
      select: { content: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: COMMENT_DAILY_LIMIT,
    });
    const rate = decideCommentRate(recent, content, now);
    if (rate.kind === "duplicate") {
      return NextResponse.json({ error: "Conflict", reason: "duplicate" satisfies CommentPostRejectReason }, { status: 409 });
    }
    if (rate.kind === "rate_limited") {
      return NextResponse.json(
        { error: "Too many requests", reason: "rate_limited" satisfies CommentPostRejectReason, retryAfterSeconds: rate.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
      );
    }

    const access = await lessonAccessFor(prisma, userId, lessonId);
    if (access === "not_found") {
      return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
    }
    if (access === "locked") {
      return NextResponse.json({ error: "Forbidden", reason: "course_locked" satisfies CommentPostRejectReason }, { status: 403 });
    }

    const comment = await prisma.comment.create({
      data: { userId, lessonId, content, parentId: null },
      select: {
        id: true,
        content: true,
        createdAt: true,
        userId: true,
        user: { select: { name: true, role: true, deactivatedAt: true } },
      },
    });

    return NextResponse.json(toCommentThreadView({ ...comment, replies: [] }, userId), { status: 201 });
  } catch (error) {
    console.error("POST /api/comments error:", safeErrorSummary(error).name);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
