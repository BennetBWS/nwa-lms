import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeErrorSummary } from "@/lib/safe-error";
import type { Prisma } from "@prisma/client";
import { parseCreateComment, toCommentThreadView } from "@/lib/lesson-comments";
import {
  THREADS_PAGE_SIZE,
  encodeThreadCursor,
  isAnswered,
  parseThreadListQuery,
  toQuestionThreadView,
  unlockedCourseIds,
} from "@/lib/question-threads";

// 1 件ごとに読む項目。user は name・role・deactivatedAt だけ（応答には含めない。#32）
const COMMENT_SELECT = {
  id: true,
  content: true,
  createdAt: true,
  userId: true,
  user: { select: { name: true, role: true, deactivatedAt: true } },
} as const;

// 質問スレッド一覧（#32）。親の質問を新しい順に 20 件ずつ（カーソル方式）。読み取りだけ（投稿は #46）。
// 受講生には、自分にとってロック中のコースの質問を返さない（自分の質問は常に返す）。講師はロックなし。
// 絞り込み：mine（自分の質問）・status（answered / unanswered）・courseId
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
      const [courses, progress] = await Promise.all([
        prisma.course.findMany({
          orderBy: [{ order: "asc" }, { id: "asc" }],
          select: { id: true, sections: { select: { lessons: { select: { id: true } } } } },
        }),
        prisma.progress.findMany({
          where: { userId, completed: true },
          select: { lessonId: true },
        }),
      ]);
      const unlocked = unlockedCourseIds(courses, new Set(progress.map((p) => p.lessonId)));
      and.push({ OR: [{ userId }, { lesson: { section: { courseId: { in: unlocked } } } }] });
    }
    if (mine) and.push({ userId });
    if (courseId !== null) and.push({ lesson: { section: { courseId } } });
    // DB では別レッスンの返信も含めて絞る。下で同じレッスンの返信だけで判定し直す
    if (status === "answered") and.push({ replies: { some: { user: { role: "INSTRUCTOR" } } } });
    if (status === "unanswered") and.push({ replies: { none: { user: { role: "INSTRUCTOR" } } } });
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


// 画面からは使わない（投稿欄の公開は #46）。入力検証だけ強化して残す（#32）
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    const lesson = await prisma.lesson.findUnique({ where: { id: lessonId }, select: { id: true } });
    if (!lesson) {
      return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
    }

    if (parentId !== null) {
      // 返信は、同じレッスンの親の質問（parentId が null）にだけ付けられる。返信への返信は禁止
      const parent = await prisma.comment.findUnique({
        where: { id: parentId },
        select: { lessonId: true, parentId: true },
      });
      if (!parent || parent.lessonId !== lessonId || parent.parentId !== null) {
        return NextResponse.json({ error: "Invalid request", reason: "invalid_parent_id" }, { status: 400 });
      }
    }

    const userId = session.user.id;
    const comment = await prisma.comment.create({
      data: { userId, lessonId, content, parentId },
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
