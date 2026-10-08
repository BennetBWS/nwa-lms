/**
 * 質問スレッド一覧（#32）と GET /api/comments の入力検証・応答の変換。
 *
 * route（src/app/api/comments/route.ts の GET）と src/app/page.tsx の Questions の両方から使う。
 * DB・時計・DOM に触れない純粋関数だけを置く。現在時刻は必ず引数 `now` で受け取る。
 *
 * Tec の決定（#32、2026-10-08）：
 * - 受講生には全受講生の質問を見せる。ただし自分にとってロック中のコースの質問はサーバー側で除く（自分の質問は常に出す）。
 *   講師はロックなしで全コース
 * - 状態のバッジは、講師の返信があれば「回答済み」、なければ「未回答」
 * - スレッドを押したら、この画面で全文と返信を展開する
 * - 読み取りだけ（投稿は #46）
 * - 名前の出し方はレッスン画面（lesson-comments の commentAuthorView / toCommentThreadView）と同じ
 */

import { isCourseLocked, type LessonCounts } from "./course-lock";
import {
  isValidId,
  toCommentThreadView,
  toItem,
  validRows,
  type CommentItem,
  type CommentRow,
  type CommentThreadView,
} from "./lesson-comments";

/** 1 ページの件数（親の質問の数） */
export const THREADS_PAGE_SIZE = 20;

export type ParseResult<T, R> = { ok: true; value: T } | { ok: false; reason: R };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ───────────── カーソル ─────────────

export type ThreadCursor = { createdAt: Date; id: string };

/** `<epochMillis>.<id>`。id に "." が含まれていても、最初の "." で分ける */
export function encodeThreadCursor(createdAt: Date, id: string): string {
  return `${createdAt.getTime()}.${id}`;
}

/** 15 桁まで（年 33658 まで。Date の範囲内に収める） */
const MILLIS_RE = /^\d{1,15}$/;

/**
 * encodeThreadCursor の逆。epochMillis が 0 以上の整数（数字だけ、15 桁まで）で、
 * id が空でない 64 文字以内の文字列でなければ null
 */
export function decodeThreadCursor(value: unknown): ThreadCursor | null {
  if (typeof value !== "string") return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const millis = value.slice(0, dot);
  const id = value.slice(dot + 1);
  if (!MILLIS_RE.test(millis) || !isValidId(id)) return null;
  const createdAt = new Date(Number(millis));
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

// ───────────── GET /api/comments のクエリ ─────────────

export type ThreadStatus = "all" | "answered" | "unanswered";

export type ThreadListQuery = {
  mine: boolean;
  status: ThreadStatus;
  courseId: string | null;
  cursor: ThreadCursor | null;
};

export type ThreadListReason = "invalid_mine" | "invalid_status" | "invalid_course_id" | "invalid_cursor";

const STATUSES: ReadonlyArray<ThreadStatus> = ["all", "answered", "unanswered"];

/**
 * GET /api/comments のクエリを検証する。知らないパラメータは無視する。
 * - mine：なし・"0"・"false" → false、"1"・"true" → true。それ以外は invalid_mine
 * - status：なし → all。all / answered / unanswered 以外は invalid_status
 * - courseId：なし → null。空・65 文字以上は invalid_course_id
 * - cursor：なし → null。decodeThreadCursor で読めなければ invalid_cursor
 * 同じ名前が複数あるときは最初の値を使う
 */
export function parseThreadListQuery(params: URLSearchParams): ParseResult<ThreadListQuery, ThreadListReason> {
  const mineRaw = params.get("mine");
  let mine: boolean;
  if (mineRaw === null || mineRaw === "0" || mineRaw === "false") mine = false;
  else if (mineRaw === "1" || mineRaw === "true") mine = true;
  else return { ok: false, reason: "invalid_mine" };

  const statusRaw = params.get("status");
  let status: ThreadStatus;
  if (statusRaw === null) status = "all";
  else if ((STATUSES as ReadonlyArray<string>).includes(statusRaw)) status = statusRaw as ThreadStatus;
  else return { ok: false, reason: "invalid_status" };

  const courseRaw = params.get("courseId");
  let courseId: string | null;
  if (courseRaw === null) courseId = null;
  else if (isValidId(courseRaw)) courseId = courseRaw;
  else return { ok: false, reason: "invalid_course_id" };

  const cursorRaw = params.get("cursor");
  let cursor: ThreadCursor | null;
  if (cursorRaw === null) cursor = null;
  else {
    cursor = decodeThreadCursor(cursorRaw);
    if (cursor === null) return { ok: false, reason: "invalid_cursor" };
  }

  return { ok: true, value: { mine, status, courseId, cursor } };
}

// ───────────── コースのロック ─────────────

export type LockCourseInput = {
  id: string;
  sections: ReadonlyArray<{ lessons: ReadonlyArray<{ id: string }> }>;
};

/**
 * 解放済み（ロックされていない）コースの id。courses は表示順（route が [order, id] で並べる）。
 * ロックの規則は course-lock の isCourseLocked と同じ（確認テストの一覧 buildQuizCourses と同じ考え方）
 */
export function unlockedCourseIds(
  courses: ReadonlyArray<LockCourseInput>,
  completedLessonIds: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  let prev: LessonCounts | null = null;
  for (const c of courses) {
    let totalLessons = 0;
    let completedLessons = 0;
    for (const s of c.sections) {
      for (const l of s.lessons) {
        totalLessons++;
        if (completedLessonIds.has(l.id)) completedLessons++;
      }
    }
    const counts = { completedLessons, totalLessons };
    if (!isCourseLocked(prev, counts)) out.push(c.id);
    prev = counts;
  }
  return out;
}

// ───────────── API の応答 ─────────────

/** route が prisma の select で読む 1 件 */
export type QuestionThreadRow = CommentRow & {
  lesson: { id: string; title: string; section: { course: { id: string; name: string } } };
  replies: ReadonlyArray<CommentRow & { lessonId: string }>;
};

export type QuestionThreadView = CommentThreadView & {
  lesson: { id: string; title: string };
  course: { id: string; name: string };
  /** 親と同じレッスンの返信の数 */
  replyCount: number;
  /** 親と同じレッスンの返信のうち、最後の日時（ISO 文字列）。返信なしは null */
  lastReplyAt: string | null;
  /** 親と同じレッスンに講師の返信がある */
  answered: boolean;
};

/** 親と同じレッスンの返信だけ（#32 より前の POST では、別レッスンの lessonId を持つ返信が作られうる） */
export function sameLessonReplies<R extends { lessonId: string }>(row: { lesson: { id: string }; replies: ReadonlyArray<R> }): R[] {
  return row.replies.filter((r) => r.lessonId === row.lesson.id);
}

/** 講師の返信が、親と同じレッスンに 1 件以上ある */
export function isAnswered(row: Pick<QuestionThreadRow, "lesson" | "replies">): boolean {
  return sameLessonReplies(row).some((r) => r.user.role === "INSTRUCTOR");
}

/**
 * API の応答 1 件。名前の出し方と、含めない項目（userId・メールアドレス・avatar・role・deactivatedAt）は
 * toCommentThreadView と同じ。返信は親と同じレッスンのものだけを数え・含める（並びは渡された順）
 */
export function toQuestionThreadView(row: QuestionThreadRow, viewerId: string): QuestionThreadView {
  const replies = sameLessonReplies(row);
  let last: number | null = null;
  for (const r of replies) {
    const t = r.createdAt.getTime();
    if (last === null || t > last) last = t;
  }
  return {
    ...toCommentThreadView({ ...row, replies }, viewerId),
    lesson: { id: row.lesson.id, title: row.lesson.title },
    course: { id: row.lesson.section.course.id, name: row.lesson.section.course.name },
    replyCount: replies.length,
    lastReplyAt: last === null ? null : new Date(last).toISOString(),
    answered: replies.some((r) => r.user.role === "INSTRUCTOR"),
  };
}

// ───────────── 画面の表示 ─────────────

export type QuestionTab = "all" | "mine" | "unanswered";

export const QUESTION_TABS: ReadonlyArray<{ key: QuestionTab; label: string }> = [
  { key: "all", label: "すべて" },
  { key: "mine", label: "自分の質問" },
  { key: "unanswered", label: "未回答" },
];

/** タブとカーソルから GET /api/comments の URL を作る（1 ページ目は cursor が null） */
export function threadListUrl(tab: QuestionTab, cursor: string | null): string {
  const q = new URLSearchParams();
  if (tab === "mine") q.set("mine", "1");
  if (tab === "unanswered") q.set("status", "unanswered");
  if (cursor !== null) q.set("cursor", cursor);
  const s = q.toString();
  return s === "" ? "/api/comments" : `/api/comments?${s}`;
}

/** 一覧が空のときの文言 */
export function threadsEmptyMessage(tab: QuestionTab): string {
  return tab === "mine" ? "まだ質問していません" : "まだ質問はありません";
}

/** 状態のバッジの文言 */
export function answeredLabel(answered: boolean): string {
  return answered ? "回答済み" : "未回答";
}

/**
 * GET /api/comments の応答の形を確かめる。threads が配列でなければ null（失敗として扱う）。
 * nextCursor は空でない文字列のときだけ使い、それ以外は null（次のページなし）
 */
export function readThreadPage(data: unknown): { threads: unknown[]; nextCursor: string | null } | null {
  if (!isPlainObject(data) || !Array.isArray(data.threads)) return null;
  const nextCursor = typeof data.nextCursor === "string" && data.nextCursor !== "" ? data.nextCursor : null;
  return { threads: data.threads, nextCursor };
}

export type QuestionThreadItem = CommentItem & {
  courseName: string;
  lessonTitle: string;
  replyCount: number;
  answered: boolean;
  answeredLabel: string;
  replies: CommentItem[];
};

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * スレッドの配列（ページを読んだ順につなげたもの）を画面の行にする。
 * 壊れた要素（非オブジェクト、id か content が文字列でない）を飛ばし、
 * 空の id と、親・返信・ページを通して重複した id を除く（最初の 1 件を残す。id は React の key）。
 * replyCount が 0 以上の整数でなければ、表示する返信の数を使う。answered は true のときだけ回答済み。順序は API のまま
 */
export function toQuestionThreadItems(rows: unknown, now: Date): QuestionThreadItem[] {
  const seen = new Set<string>();
  return validRows(rows, seen).map((r) => {
    const replies = validRows(r.replies, seen).map((x) => toItem(x, now));
    const course = isPlainObject(r.course) ? r.course : {};
    const lesson = isPlainObject(r.lesson) ? r.lesson : {};
    const answered = r.answered === true;
    return {
      ...toItem(r, now),
      courseName: typeof course.name === "string" ? course.name : "",
      lessonTitle: typeof lesson.title === "string" ? lesson.title : "",
      replyCount: isNonNegativeInt(r.replyCount) ? r.replyCount : replies.length,
      answered,
      answeredLabel: answeredLabel(answered),
      replies,
    };
  });
}
