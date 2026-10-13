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

/** 結果不明の後、読み直した一覧に自分の回答が増えていたときの知らせ（入力欄が送った本文のままだったので消した） */
export const REPLY_SAVED_AFTER_UNKNOWN_MESSAGE = "回答は保存されていました。入力欄は空にしました。";
/** 結果不明の後、読み直した一覧に自分の回答が増えていたが、入力欄が書き直されていたときの知らせ（書き直した内容は残す） */
export const REPLY_SAVED_DRAFT_KEPT_AFTER_UNKNOWN_MESSAGE =
  "回答は保存されていました。入力欄の書き直した内容は残してあります。追加で送る必要があるか確かめてください。";
/** 複数の質問で、入力欄を空にしたものと残したものがあるときの読み上げの知らせ（各質問の文言は回答欄の下に出す） */
export const REPLY_SAVED_MIXED_AFTER_UNKNOWN_MESSAGE = "回答は保存されていました。各質問の回答欄の下の知らせを確かめてください。";
/**
 * 結果不明の後、読み直した一覧に自分の回答が増えていなかったときのエラー（書きかけは残す）。
 * サーバーがまだ処理中の可能性もあるため「保存されていない」とは言い切らない。
 * 判定の後は記録を外し、遅れて保存された回答は検出しないため、再送の前にスレッドを確かめるよう案内する
 */
export const REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE =
    "回答は保存されていない可能性が高いです。入力は残してあります。少し待ってから一覧を再読み込みし、スレッドに自分の回答が出ていないか確かめてから、出ていなければ送信してください。";
/** 結果不明の記録がある間、送信ボタンの横に出す補足（送信は止め、再読み込みを促す） */
export const REPLY_BLOCKED_UNTIL_RELOAD_HINT = "送信できたか確かめるまで、この質問への送信は止めています。「一覧を再読み込み」を押してください。";

/**
 * 読み直した 1 ページ目に結果不明の質問がなかったときの知らせ（role="status"）。
 * 未回答タブでは、回答が保存されて回答済みになり一覧から外れた可能性がある
 */
export function uncertainReplyMissingMessage(tab: AdminQuestionTab): string {
  if (tab === "unanswered") return "回答済みになった可能性があります。回答済みタブで確かめてください。";
  return "送信結果を確かめる質問がこの一覧に見つかりませんでした。「もっと見る」や他のタブで確かめてください。";
}

/** 結果不明の回答の記録 */
export type UncertainReply = {
  /** 結果不明になった時点の一覧の読み込みの通し番号（これより後に始めた読み込みだけで判定する） */
  seq: number;
  /** 送った本文（サーバーの parseCommentContent と同じく前後の空白を除いたもの） */
  content: string;
  /** 送信した時点の行にあった「自分の講師の返信で、本文が content と同じもの」の件数 */
  mineCount: number;
};

/** 結果不明の質問の id → 記録 */
export type UncertainReplies = Readonly<Record<string, UncertainReply>>;

export type UncertainReplyResolution = { saved: string[]; notSaved: string[] };

/**
 * 行（GET /api/comments の threads の 1 件・回答の応答の thread）の返信のうち、
 * 自分の（mine が true の）講師の返信で本文が content と同じものの件数。replies が配列でなければ null（数えられない）
 */
export function countMyInstructorReplies(row: unknown, content: string): number | null {
  if (!isPlainObject(row) || !Array.isArray(row.replies)) return null;
  let n = 0;
  for (const r of row.replies) {
    if (!isPlainObject(r) || r.mine !== true || r.content !== content) continue;
    if (!isPlainObject(r.author) || r.author.isInstructor !== true) continue;
    n++;
  }
  return n;
}

/**
 * 結果不明になった回答の記録を作る。value は送った本文（前後の空白はここで除く。サーバーと同じ）、
 * rows は送信した時点の一覧（id が同じ最初の行で数える。行がない・数えられないときは 0 件として扱う）
 */
export function uncertainReplyRecord(seq: number, threadId: string, value: unknown, rows: unknown[]): UncertainReply {
  const content = typeof value === "string" ? value.trim() : "";
  const row = rows.find((r) => isPlainObject(r) && r.id === threadId);
  return { seq, content, mineCount: countMyInstructorReplies(row, content) ?? 0 };
}

/**
 * 読み直した一覧（GET /api/comments の threads）から、結果不明だった質問の結果を判定する。
 * - 結果不明になった後に始めた読み込み（pageSeq が記録した seq より大きい）だけで判定する。
 *   それより前に始めた読み込みは、回答が保存される前の一覧かもしれないため使わない
 * - 行にある「自分の講師の返信で、送った本文と同じもの」が記録した件数より増えていれば saved、増えていなければ notSaved。
 *   answered（講師の返信があるか）では判定しない：回答済みの質問への追加の回答や、別の講師の回答で誤判定するため
 * - 一覧にない・replies が配列でない：判定しない（未回答タブでは回答済みになった質問は一覧から外れる。
 *   2 ページ目以降にあるかもしれない）。結果不明のまま残る
 */
export function resolveUncertainReplies(uncertain: UncertainReplies, pageSeq: number, rows: unknown[]): UncertainReplyResolution {
  const saved: string[] = [];
  const notSaved: string[] = [];
  for (const id of Object.keys(uncertain)) {
    const rec = uncertain[id];
    if (!(pageSeq > rec.seq)) continue;
    const row = rows.find((r) => isPlainObject(r) && r.id === id);
    const count = countMyInstructorReplies(row, rec.content);
    if (count === null) continue;
    (count > rec.mineCount ? saved : notSaved).push(id);
  }
  return { saved, notSaved };
}

/**
 * 判定の対象（pageSeq が記録より大きい）なのに、読み直した一覧に見つからなかった質問の id。
 * 1 ページ目の読み直しのときだけ、画面が uncertainReplyMissingMessage で知らせる
 */
export function missingUncertainReplies(uncertain: UncertainReplies, pageSeq: number, rows: unknown[]): string[] {
  return Object.keys(uncertain).filter(
    (id) => pageSeq > uncertain[id].seq && countMyInstructorReplies(rows.find((r) => isPlainObject(r) && r.id === id), uncertain[id].content) === null
  );
}

function omitIds<V>(prev: Readonly<Record<string, V>>, ids: readonly string[]): Record<string, V> {
  const next: Record<string, V> = { ...prev };
  for (const id of ids) delete next[id];
  return next;
}

/** 判定した質問を結果不明の記録から外す */
export function nextUncertainReplies(prev: UncertainReplies, r: UncertainReplyResolution): Record<string, UncertainReply> {
  return omitIds(prev, [...r.saved, ...r.notSaved]);
}

/** 回答欄のエラー：saved は消し、notSaved は「保存されていない可能性が高い」に変える。それ以外の質問はそのまま */
export function nextReplyErrors(prev: Readonly<Record<string, string>>, r: UncertainReplyResolution): Record<string, string> {
  const next = omitIds(prev, r.saved);
  for (const id of r.notSaved) next[id] = REPLY_NOT_SAVED_AFTER_UNKNOWN_MESSAGE;
  return next;
}

/** saved の質問の書きかけの扱い：cleared は消す（送った本文のまま）、kept は残す（結果不明の間に書き直された） */
export type SavedDraftOutcome = { cleared: string[]; kept: string[] };

/**
 * saved の質問ごとに、今の書きかけを消すか残すかを決める。uncertain は判定前の記録（nextUncertainReplies で外す前のもの）。
 * 結果不明の間も回答欄は編集できるため、今の書きかけを trim した値（サーバーの parseCommentContent と同じ
 * String.prototype.trim）が記録の content と同じとき、または空のときだけ消す。違うときは書き直した内容として残す
 */
export function savedDraftOutcome(
  drafts: Readonly<Record<string, string>>,
  uncertain: UncertainReplies,
  r: UncertainReplyResolution
): SavedDraftOutcome {
  const cleared: string[] = [];
  const kept: string[] = [];
  for (const id of r.saved) {
    const draft = (drafts[id] ?? "").trim();
    const rec = uncertain[id];
    (draft === "" || (rec !== undefined && draft === rec.content) ? cleared : kept).push(id);
  }
  return { cleared, kept };
}

/** 書きかけ：送った本文のままの saved（cleared）だけ消す（二重回答を防ぐ）。書き直したもの・notSaved・それ以外の質問は残す */
export function nextReplyDrafts(prev: Readonly<Record<string, string>>, d: SavedDraftOutcome): Record<string, string> {
  return omitIds(prev, d.cleared);
}

/**
 * 回答欄の知らせ：saved のうち書きかけを消したものに「入力欄は空にしました」、残したものに「書き直した内容は残してあります」を出す。
 * notSaved の古い知らせは消す
 */
export function nextReplyNotices(prev: Readonly<Record<string, string>>, r: UncertainReplyResolution, d: SavedDraftOutcome): Record<string, string> {
  const next = omitIds(prev, r.notSaved);
  for (const id of d.cleared) next[id] = REPLY_SAVED_AFTER_UNKNOWN_MESSAGE;
  for (const id of d.kept) next[id] = REPLY_SAVED_DRAFT_KEPT_AFTER_UNKNOWN_MESSAGE;
  return next;
}

/** 読み上げの知らせ（role="status"）。saved がなければ null（知らせない） */
export function savedReplyStatusMessage(d: SavedDraftOutcome): string | null {
  if (d.cleared.length === 0 && d.kept.length === 0) return null;
  if (d.kept.length === 0) return REPLY_SAVED_AFTER_UNKNOWN_MESSAGE;
  if (d.cleared.length === 0) return REPLY_SAVED_DRAFT_KEPT_AFTER_UNKNOWN_MESSAGE;
  return REPLY_SAVED_MIXED_AFTER_UNKNOWN_MESSAGE;
}

/** 判定した質問を開いた状態にする（読み直すと開いた行は閉じるため、結果をその場で見せる）。順序は保ち、重複させない */
export function expandResolvedIds(prev: readonly string[], r: UncertainReplyResolution): string[] {
  const next = [...prev];
  for (const id of [...r.saved, ...r.notSaved]) if (!next.includes(id)) next.push(id);
  return next;
}
