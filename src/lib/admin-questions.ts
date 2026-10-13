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

// ───────────── 結果不明の回答を一覧の読み直しで確かめる ─────────────

/** 結果不明の後、読み直した一覧で回答済みになっていたときの知らせ（書きかけは消す） */
export const REPLY_SAVED_AFTER_UNKNOWN_MESSAGE = "回答は保存されていました（この質問は回答済みになっています）。入力欄は空にしました。";
/** 結果不明の後、読み直した一覧で未回答のままだったときのエラー（書きかけは残す） */
export const REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE = "回答は保存されていませんでした。入力は残してあります。もう一度送信してください。";

/** 結果不明の質問の id → 結果不明になった時点の一覧の読み込みの通し番号 */
export type UncertainReplies = Readonly<Record<string, number>>;

export type UncertainReplyResolution = { saved: string[]; notSaved: string[] };

/**
 * 読み直した一覧（GET /api/comments の threads）から、結果不明だった質問の結果を判定する。
 * - 結果不明になった後に始めた読み込み（pageSeq が記録した番号より大きい）だけで判定する。
 *   それより前に始めた読み込みは、回答が保存される前の一覧かもしれないため使わない
 * - 一覧にあり answered が true：saved（回答は保存されていた）。false：notSaved（保存されていない）
 * - 一覧にない・answered が boolean でない：判定しない（未回答タブでは回答済みの質問は一覧から外れる。
 *   2 ページ目以降にあるかもしれない）。結果不明のまま残る
 */
export function resolveUncertainReplies(uncertain: UncertainReplies, pageSeq: number, rows: unknown[]): UncertainReplyResolution {
  const saved: string[] = [];
  const notSaved: string[] = [];
  for (const id of Object.keys(uncertain)) {
    if (!(pageSeq > uncertain[id])) continue;
    const row = rows.find((r) => isPlainObject(r) && r.id === id);
    if (!isPlainObject(row) || typeof row.answered !== "boolean") continue;
    (row.answered ? saved : notSaved).push(id);
  }
  return { saved, notSaved };
}

function omitIds<V>(prev: Readonly<Record<string, V>>, ids: readonly string[]): Record<string, V> {
  const next: Record<string, V> = { ...prev };
  for (const id of ids) delete next[id];
  return next;
}

/** 判定した質問を結果不明の記録から外す */
export function nextUncertainReplies(prev: UncertainReplies, r: UncertainReplyResolution): Record<string, number> {
  return omitIds(prev, [...r.saved, ...r.notSaved]);
}

/** 回答欄のエラー：saved は消し、notSaved は「保存されていませんでした」に変える。それ以外の質問はそのまま */
export function nextReplyErrors(prev: Readonly<Record<string, string>>, r: UncertainReplyResolution): Record<string, string> {
  const next = omitIds(prev, r.saved);
  for (const id of r.notSaved) next[id] = REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE;
  return next;
}

/** 書きかけ：saved だけ消す（二重回答を防ぐ）。notSaved とそれ以外の質問は残す */
export function nextReplyDrafts(prev: Readonly<Record<string, string>>, r: UncertainReplyResolution): Record<string, string> {
  return omitIds(prev, r.saved);
}

/** 回答欄の知らせ：saved に「保存されていました」を出し、notSaved の古い知らせは消す */
export function nextReplyNotices(prev: Readonly<Record<string, string>>, r: UncertainReplyResolution): Record<string, string> {
  const next = omitIds(prev, r.notSaved);
  for (const id of r.saved) next[id] = REPLY_SAVED_AFTER_UNKNOWN_MESSAGE;
  return next;
}

/** 判定した質問を開いた状態にする（読み直すと開いた行は閉じるため、結果をその場で見せる）。順序は保ち、重複させない */
export function expandResolvedIds(prev: readonly string[], r: UncertainReplyResolution): string[] {
  const next = [...prev];
  for (const id of [...r.saved, ...r.notSaved]) if (!next.includes(id)) next.push(id);
  return next;
}
