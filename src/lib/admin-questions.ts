/**
 * 管理画面の質問対応ページ（#32 A-2、page.tsx の AdminQuestions）のタブ・URL・文言・応答の読み取り。
 *
 * DB・時計・DOM・React に触れない純粋関数だけを置く。
 * 一覧は既存の GET /api/comments（講師はロックなしで全件）、回答は POST /api/admin/comments/[id]/replies（A-1）。
 * 生徒側の Questions（question-threads の QUESTION_TABS など）とはタブが違うため、ここに分ける。
 * 行の表示（名前の匿名化・講師バッジ・要約）は question-threads の toQuestionThreadItems をそのまま使う。
 */

import { commentSubmitErrorMessage, COMMENT_UNKNOWN_RESULT_MESSAGE } from "./comment-form";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ───────────── タブ・URL ─────────────

export type AdminQuestionTab = "unanswered" | "answered" | "all";

export const ADMIN_QUESTION_TABS: ReadonlyArray<{ key: AdminQuestionTab; label: string }> = [
  { key: "unanswered", label: "未回答" },
  { key: "answered", label: "回答済み" },
  { key: "all", label: "すべて" },
];

/** 開いたときのタブ */
export const DEFAULT_ADMIN_QUESTION_TAB: AdminQuestionTab = "unanswered";

/**
 * GET /api/comments の URL。status はタブのまま（すべては省く）、courseId はコースで絞るときだけ、
 * cursor は 2 ページ目以降だけ付ける
 */
export function adminThreadListUrl(tab: AdminQuestionTab, courseId: string | null, cursor: string | null): string {
  const q = new URLSearchParams();
  if (tab !== "all") q.set("status", tab);
  if (courseId !== null) q.set("courseId", courseId);
  if (cursor !== null) q.set("cursor", cursor);
  const s = q.toString();
  return s === "" ? "/api/comments" : `/api/comments?${s}`;
}

/** 回答の送信先（POST /api/admin/comments/[id]/replies）。id は URL エンコードする */
export function adminReplyUrl(threadId: string): string {
  return `/api/admin/comments/${encodeURIComponent(threadId)}/replies`;
}

// ───────────── 文言 ─────────────

const TAB_NOUN: Readonly<Record<AdminQuestionTab, string>> = {
  unanswered: "未回答の質問",
  answered: "回答済みの質問",
  all: "質問",
};

/** 一覧が空のときの文言。コースで絞っているときは「このコースに」を付ける */
export function adminThreadsEmptyMessage(tab: AdminQuestionTab, filteredByCourse: boolean): string {
  return `${filteredByCourse ? "このコースに" : ""}${TAB_NOUN[tab]}はありません`;
}

/**
 * 表示できる行が 0 件で、続き（nextCursor）があるときに「もっと見る」の上に出す説明。
 * 未回答・回答済みはサーバーで 1 ページ分を読んだ後に絞るため、0 件でも続きがあることがある
 */
export function adminThreadsMoreHint(tab: AdminQuestionTab): string {
  return `ここまでに${TAB_NOUN[tab]}はありません。古い質問を続けて確認できます`;
}

/** 回答を送れたときの知らせ（role="status" で読み上げる） */
export const REPLY_SENT_MESSAGE = "回答を送信しました";

// ───────────── コースの選択肢 ─────────────

export type CourseOption = { id: string; name: string };

/**
 * GET /api/admin/courses の応答からコースの選択肢を作る。配列でなければ null（読み込み失敗として扱う）。
 * id・name が空でない文字列の要素だけを、順序のまま残す（重複した id は最初の 1 件）
 */
export function toCourseOptions(data: unknown): CourseOption[] | null {
  if (!Array.isArray(data)) return null;
  const seen = new Set<string>();
  const out: CourseOption[] = [];
  for (const c of data) {
    if (!isPlainObject(c)) continue;
    if (typeof c.id !== "string" || c.id === "" || seen.has(c.id)) continue;
    if (typeof c.name !== "string" || c.name === "") continue;
    seen.add(c.id);
    out.push({ id: c.id, name: c.name });
  }
  return out;
}

// ───────────── 回答の応答 ─────────────

export type ReplyOutcome = { kind: "success"; thread: Record<string, unknown> } | { kind: "error"; message: string };

/**
 * POST /api/admin/comments/[id]/replies の応答を判定する。body は JSON（読めなければ null）。
 * - redirected / 401 / 400 / 403 / 404 / 5xx：comment-form の commentSubmitErrorMessage の文言
 * - 2xx で body.thread が送った質問（id が threadId、content が文字列）：成功
 * - 2xx なのに thread が読めない：回答はできている可能性があるので、再送ではなく再読み込みを案内する
 */
export function interpretReplyResponse(input: {
  ok: boolean;
  status: number;
  redirected: boolean;
  body: unknown;
  threadId: string;
}): ReplyOutcome {
  const { ok, status, redirected, body, threadId } = input;
  if (redirected || !ok) {
    const reason = isPlainObject(body) ? body.reason : undefined;
    return { kind: "error", message: commentSubmitErrorMessage({ httpStatus: status, reason, redirected }) };
  }
  const thread = isPlainObject(body) ? body.thread : undefined;
  if (isPlainObject(thread) && thread.id === threadId && typeof thread.content === "string") {
    return { kind: "success", thread };
  }
  return { kind: "error", message: COMMENT_UNKNOWN_RESULT_MESSAGE };
}

/**
 * 一覧の生の行（GET /api/comments の threads をつなげたもの）のうち、id が同じ行を回答後の thread に置き換える。
 * 位置は変えない（未回答タブでも、回答した行はその場で「回答済み」にして残す。次に読み込んだときに外れる）。
 * 該当する行がなければ（タブを切り替えた後に応答が来たなど）rows をそのまま返す
 */
export function replaceThreadRow(rows: unknown[], thread: Record<string, unknown>): unknown[] {
  let hit = false;
  const next = rows.map((r) => {
    if (isPlainObject(r) && r.id === thread.id) {
      hit = true;
      return thread;
    }
    return r;
  });
  return hit ? next : rows;
}
