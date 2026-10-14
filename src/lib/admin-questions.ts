/**
 * 管理画面の質問対応ページ（#32 A-2、page.tsx の AdminQuestions）のタブ・URL・文言・応答の読み取り。
 *
 * DB・時計・DOM・React に触れない純粋関数だけを置く。
 * 一覧は既存の GET /api/comments（講師はロックなしで全件）、回答は POST /api/admin/comments/[id]/replies（A-1）。
 * 生徒側の Questions（question-threads の QUESTION_TABS など）とはタブが違うため、ここに分ける。
 * 行の表示（名前の匿名化・講師バッジ・要約）は question-threads の toQuestionThreadItems をそのまま使う。
 */

import { commentSubmitErrorMessage, COMMENT_SESSION_EXPIRED_MESSAGE, COMMENT_UNKNOWN_RESULT_MESSAGE } from "./comment-form";
import { displayName } from "./user-display";

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
 * 未回答タブでは、回答が保存されて回答済みになり一覧から外れた可能性がある。
 * hasMore：続きのページがある（nextCursor が null でない）か。ないときは「もっと見る」を案内しない
 */
export function uncertainReplyMissingMessage(tab: AdminQuestionTab, hasMore: boolean): string {
  if (tab === "unanswered") return "回答済みになった可能性があります。回答済みタブで確かめてください。";
  if (hasMore) return "送信結果を確かめる質問がこの一覧に見つかりませんでした。「もっと見る」や他のタブで確かめてください。";
  return "送信結果を確かめる質問がこの一覧に見つかりませんでした。他のタブやコースで確かめてください。";
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

// ───────────── 質問・返信の削除（#47 P2） ─────────────
// API は DELETE /api/admin/comments/[id]（講師専用、#47 P1）。物理削除で、元に戻せない。
// 質問を消すと、その下の返信もすべて消える。返信を消すと、削除後のスレッド（根の質問）が返る。

/** 削除の送信先（DELETE /api/admin/comments/[id]）。id は URL エンコードする */
export function adminCommentDeleteUrl(id: string): string {
  return `/api/admin/comments/${encodeURIComponent(id)}`;
}

/** 確認ダイアログで引用する本文の最大の文字数（書記素で数える） */
export const DELETE_QUOTE_MAX_CHARS = 40;

const EDGE_ZWJ = new RegExp("^\\u200D+|\\u200D+$", "g");

function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/**
 * 確認ダイアログで対象を見分けるための、本文の先頭の引用。
 * 名前と同じ規則（user-display の displayName：空白・改行を 1 つの空白にまとめ、見えない制御・書式文字や向きの制御文字を除く）で
 * 整えてから、DELETE_QUOTE_MAX_CHARS 書記素までにする（絵文字や結合文字を途中で切らない）。切ったときは末尾に「…」を付ける。
 * 文字列でない・見える文字が残らないときは ""（画面は引用を出さない）
 */
export function deleteQuote(content: unknown, maxChars: number = DELETE_QUOTE_MAX_CHARS): string {
  const shown = displayName(content);
  if (shown === null) return "";
  const g = graphemes(shown);
  if (g.length <= maxChars) return shown;
  return `${g.slice(0, maxChars).join("").trimEnd().replace(EDGE_ZWJ, "")}…`;
}

/** 返信の削除ボタンの読み上げ名に添える本文の先頭の最大の文字数（書記素） */
export const DELETE_LABEL_QUOTE_MAX_CHARS = 20;

/**
 * 返信の削除ボタンの読み上げ名（aria-label）。同じ名前の人の返信が並んでも区別できるよう、本文の先頭
 * （deleteQuote と同じ整え方で DELETE_LABEL_QUOTE_MAX_CHARS まで）を添える。本文に見える文字がなければ投稿日時を添える。
 * 見える文字の「削除」を含め、末尾は「を削除」にする。name は表示名（displayName 済み・匿名化済み）
 */
export function replyDeleteLabel(name: string, content: unknown, time: string): string {
  const q = deleteQuote(content, DELETE_LABEL_QUOTE_MAX_CHARS);
  if (q !== "") return `${name} の返信「${q}」を削除`;
  return time !== "" ? `${name} の返信（${time}）を削除` : `${name} の返信を削除`;
}

/** 削除の対象。threadId は根の質問の id（質問なら id と同じ）。replyCount は質問のときの返信の数（画面に出ている数） */
export type DeleteTarget =
  | { kind: "question"; id: string; threadId: string; replyCount: number }
  | { kind: "reply"; id: string; threadId: string };

/** 確認ダイアログが持つ対象（種類と id だけ）。件数・回答済み・引用は、描画のたびと送信時に今の一覧から求める（resolveDeleteTarget） */
export type DeleteDialogRef = { kind: DeleteTarget["kind"]; id: string; threadId: string };

/** 今の一覧から求めた対象。wasAnswered は削除する前の、質問の回答済みの状態 */
export type ResolvedDeleteTarget = DeleteTarget & { wasAnswered: boolean; quote: string };

/** 一覧の行（question-threads の toQuestionThreadItems の 1 件）のうち、削除の対象を求めるのに使う項目 */
type DeleteTargetRow = {
  id: string;
  content: string;
  replyCount: number;
  answered: boolean;
  replies: ReadonlyArray<{ id: string; content: string }>;
};

/**
 * 確認ダイアログの対象を今の一覧の行から求める。ダイアログを開いた後に回答が保存されて返信の件数・回答済みが変わっても、
 * 確認の文言と「未回答に戻ったか」の判定は今の値を使う。
 * 質問の行（threadId）、または返信のときはその行の中の返信（id）が見つからなければ null（別の操作で消えた等）
 */
export function resolveDeleteTarget(items: ReadonlyArray<DeleteTargetRow>, ref: DeleteDialogRef): ResolvedDeleteTarget | null {
  const row = items.find((x) => x.id === ref.threadId);
  if (!row) return null;
  if (ref.kind === "question") {
    if (ref.id !== row.id) return null;
    return { kind: "question", id: row.id, threadId: row.id, replyCount: row.replyCount, wasAnswered: row.answered, quote: deleteQuote(row.content) };
  }
  const r = row.replies.find((x) => x.id === ref.id);
  if (!r) return null;
  return { kind: "reply", id: r.id, threadId: row.id, wasAnswered: row.answered, quote: deleteQuote(r.content) };
}

/** 確認ダイアログの対象が今の一覧に見つからないときの文言（「削除する」は押せない） */
export const DELETE_TARGET_MISSING_MESSAGE = "削除する対象が一覧に見つかりません。閉じて一覧を再読み込みしてください。";

/** 確認ダイアログの見出し */
export function deleteDialogTitle(kind: DeleteTarget["kind"]): string {
  return kind === "question" ? "質問を削除" : "返信を削除";
}

/**
 * 確認ダイアログの本文。返信が 0 件の質問は「この質問を削除します。」とする（「返信 0 件」とは書かない）。
 * 件数は画面に出ている返信の数（別レッスンの古い返信など、画面に出ない返信も一緒に消える）
 */
export function deleteConfirmMessage(target: DeleteTarget): string {
  if (target.kind === "reply") return "この返信を削除します。元に戻せません。";
  const n = Number.isInteger(target.replyCount) && target.replyCount > 0 ? target.replyCount : 0;
  return n === 0 ? "この質問を削除します。元に戻せません。" : `この質問と返信 ${n} 件を削除します。元に戻せません。`;
}

/** 404（ほかの講師が先に消した等）のときの知らせ。行は一覧から除く */
export const COMMENT_ALREADY_DELETED_MESSAGE = "すでに削除されています";
/** 返信を消せたときの知らせ */
export const REPLY_DELETED_MESSAGE = "返信を削除しました";
/** 返信を消して、質問が未回答に戻ったときの知らせ */
export const REPLY_DELETED_NOW_UNANSWERED_MESSAGE = "返信を削除しました。この質問は未回答に戻りました";
/** 回答の送信中・送信結果を確かめる前は、その質問と返信を削除できないことの補足（削除ボタンの説明） */
export const DELETE_BLOCKED_HINT = "回答の送信結果が分かるまで、この質問と返信は削除できません。";

/** 質問を消せたときの知らせ。deletedReplies が読めなければ件数を出さない */
export function questionDeletedMessage(deletedReplies: number | null): string {
  return deletedReplies !== null && deletedReplies > 0 ? `質問と返信 ${deletedReplies} 件を削除しました` : "質問を削除しました";
}

/** 返信を消せたときの知らせ。消す前は回答済みで、消した後は未回答なら「未回答に戻りました」を付ける */
export function replyDeletedMessage(wasAnswered: boolean, thread: Record<string, unknown>): string {
  return wasAnswered && thread.answered !== true ? REPLY_DELETED_NOW_UNANSWERED_MESSAGE : REPLY_DELETED_MESSAGE;
}

/** 通信エラー・502〜504・2xx で応答を読めない：削除できたか分からない。押し直すと確かめられる（消えていれば 404 で一覧から除く） */
export const DELETE_UNKNOWN_RESULT_MESSAGE =
  "削除できたか確かめられませんでした。もう一度「削除する」を押すと確かめられます（すでに削除されていれば一覧から消えます）。";
const DELETE_FORBIDDEN_MESSAGE = "この操作を行う権限がありません。";
const DELETE_INVALID_MESSAGE = "削除する対象が正しくありません。一覧を再読み込みしてください。";
const DELETE_SERVER_ERROR_MESSAGE = "サーバーでエラーが発生し、削除できませんでした。時間をおいて、もう一度お試しください。";
const UNKNOWN_DELETE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * 削除に失敗したときの文言（ダイアログに出す。行は残す）。httpStatus が null なら通信エラー。
 * redirected・401 はセッション切れ（authFetch がサインアウトして /login へ移る）
 */
export function deleteErrorMessage(httpStatus: number | null, redirected = false): string {
  if (httpStatus === null) return DELETE_UNKNOWN_RESULT_MESSAGE;
  if (redirected || httpStatus === 401) return COMMENT_SESSION_EXPIRED_MESSAGE;
  if (httpStatus === 403) return DELETE_FORBIDDEN_MESSAGE;
  if (httpStatus === 400) return DELETE_INVALID_MESSAGE;
  if (UNKNOWN_DELETE_STATUSES.has(httpStatus)) return DELETE_UNKNOWN_RESULT_MESSAGE;
  return DELETE_SERVER_ERROR_MESSAGE;
}

export type DeleteOutcome =
  | { kind: "question_deleted"; deletedReplies: number | null }
  | { kind: "reply_deleted"; thread: Record<string, unknown> }
  /** 404：すでに削除されている */
  | { kind: "gone" }
  | { kind: "error"; message: string };

/**
 * DELETE /api/admin/comments/[id] の応答を判定する。body は JSON（読めなければ null）。
 * - redirected：セッション切れ。404（リダイレクトなし）で本文がオブジェクト（API の JSON）：すでに削除されている。
 *   本文がオブジェクトでない 404（HTML・読めない）：削除できたか分からない。それ以外の失敗：deleteErrorMessage
 * - 2xx で、質問なら { kind: "question", id }、返信なら { kind: "reply", id, thread }（thread は根の質問 = target.threadId で、
 *   content が文字列・replies が配列）のときだけ成功。そうでなければ削除できたか分からない
 */
export function interpretDeleteResponse(input: {
  ok: boolean;
  status: number;
  redirected: boolean;
  body: unknown;
  target: DeleteTarget;
}): DeleteOutcome {
  const { ok, status, redirected, body, target } = input;
  if (redirected) return { kind: "error", message: deleteErrorMessage(status, true) };
  if (!ok) {
    // API の 404 は JSON（{ error: "Comment not found" }）。HTML などの 404（経路の誤り・ゲートウェイ）は削除済みと言い切らない
    if (status === 404) return isPlainObject(body) ? { kind: "gone" } : { kind: "error", message: DELETE_UNKNOWN_RESULT_MESSAGE };
    return { kind: "error", message: deleteErrorMessage(status) };
  }
  if (!isPlainObject(body) || body.id !== target.id || body.kind !== target.kind) {
    return { kind: "error", message: DELETE_UNKNOWN_RESULT_MESSAGE };
  }
  if (target.kind === "question") {
    const n = body.deletedReplies;
    return { kind: "question_deleted", deletedReplies: typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null };
  }
  const thread = body.thread;
  if (isPlainObject(thread) && thread.id === target.threadId && typeof thread.content === "string" && Array.isArray(thread.replies)) {
    return { kind: "reply_deleted", thread };
  }
  return { kind: "error", message: DELETE_UNKNOWN_RESULT_MESSAGE };
}

/** 一覧の生の行から、id が同じ質問の行を除く。該当がなければ rows をそのまま返す */
export function removeThreadRow(rows: unknown[], id: string): unknown[] {
  const next = rows.filter((r) => !(isPlainObject(r) && r.id === id));
  return next.length === rows.length ? rows : next;
}

/**
 * 返信の削除が 404（すでに削除されている）のとき、一覧の行から、その返信を除く。
 * replyCount は 1 減らし（0 未満にしない）、answered は残った返信に講師の返信があるかで決め直す（API の answered と同じ考え方。
 * 次に一覧を読み込めばサーバーの値になる）。該当がなければ rows をそのまま返す
 */
export function removeReplyFromRow(rows: unknown[], threadId: string, replyId: string): unknown[] {
  let hit = false;
  const next = rows.map((r) => {
    if (!isPlainObject(r) || r.id !== threadId || !Array.isArray(r.replies)) return r;
    const replies = r.replies.filter((x) => !(isPlainObject(x) && x.id === replyId));
    if (replies.length === r.replies.length) return r;
    hit = true;
    const replyCount = typeof r.replyCount === "number" && Number.isInteger(r.replyCount) ? Math.max(0, r.replyCount - 1) : replies.length;
    const answered = replies.some((x) => isPlainObject(x) && isPlainObject(x.author) && x.author.isInstructor === true);
    return { ...r, replies, replyCount, answered };
  });
  return hit ? next : rows;
}

/** 質問の id ごとの記録（書きかけ・エラー・知らせ・結果不明の記録）から、消した質問の id を除く。なければ prev をそのまま返す */
export function withoutThreadId<V>(prev: Readonly<Record<string, V>>, id: string): Readonly<Record<string, V>> {
  if (!Object.prototype.hasOwnProperty.call(prev, id)) return prev;
  return omitIds(prev, [id]);
}

/**
 * その質問（と返信）の削除ボタンを止めるか。回答の送信中と、送信結果を確かめる前（結果不明の記録がある間）は止める。
 * 送信中・結果不明の回答は、削除の後にサーバーで保存されうる（親がないと保存に失敗するか、子孫を集めた後に保存されると
 * 質問として残りうる。#47 P1 の既知の残存リスク）ため
 */
export function isDeleteBlocked(input: { sending: boolean; awaitingCheck: boolean }): boolean {
  return input.sending || input.awaitingCheck;
}
