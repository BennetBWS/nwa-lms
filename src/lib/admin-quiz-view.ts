/**
 * 管理画面の「クイズ管理」（#81 Q2。page.tsx の AdminQuiz）の文言・判定・送る body の組み立て。
 * page.tsx は表示だけを持ち、ここの純粋関数を呼ぶ（DB・時計・DOM・node:crypto に触れない）。
 *
 * 使う API（#81 Q1）：クイズの一覧の GET・クイズの詳細の GET・問題の PATCH（1 問の問題文・選択肢の文・正解を直す。
 * revision による楽観ロック）。閉じた書き込み API（#81 Q3。POST・PUT・DELETE）は使わない。
 * パスは下の「URL」の 3 行だけに書く（admin-closed-apis.test.ts が、ほかの行のパスを呼び出し元とみなし、
 * このファイルにメソッドの名前を書いていないこと、page.tsx が GET と PATCH だけで呼ぶことを検査している）。
 *
 * revision の計算（admin-quiz-revision.ts・node:crypto）は import しない。revision はサーバーの値をそのまま送り返す。
 * 入力の検証はサーバーと同じ parsePatchQuestionBody（admin-quizzes.ts）を使い、保存の前に文言を出す。
 */

import {
  MAX_OPTIONS,
  OPTION_MAX_LENGTH,
  QUESTION_MAX_LENGTH,
  REVISION_PATTERN,
  parsePatchQuestionBody,
  type AdminQuizDetail,
  type AdminQuizQuestion,
  type AdminQuizStatus,
  type AdminQuizSummary,
  type ChangedField,
  type PatchQuestionReason,
} from "./admin-quizzes";
import { MIN_OPTIONS, type QuizType } from "./student-quizzes";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

// ───────────── URL ─────────────

/** クイズの一覧（GET だけに使う） */
export const ADMIN_QUIZ_LIST_URL = "/api/admin/quizzes";

/** クイズの詳細（GET だけに使う） */
export function adminQuizDetailUrl(quizId: string): string {
  return `/api/admin/quizzes/${encodeURIComponent(quizId)}`;
}

/** 問題の修正（PATCH だけに使う） */
export function adminQuestionUrl(questionId: string): string {
  return `/api/admin/questions/${encodeURIComponent(questionId)}`;
}

// ───────────── 表示の文言 ─────────────

export const QUIZ_LIST_LOAD_FAILED_MESSAGE = "クイズの一覧を読み込めませんでした";
export const QUIZ_DETAIL_LOAD_FAILED_MESSAGE = "クイズを読み込めませんでした";
export const QUIZ_DETAIL_NOT_FOUND_MESSAGE = "このクイズは見つかりませんでした。一覧に戻って開き直してください。";
export const QUIZ_REFRESH_FAILED_MESSAGE = "最新の内容を読み込めませんでした。";
export const QUIZ_LIST_EMPTY_MESSAGE = "クイズはまだありません";
export const QUIZ_QUESTIONS_EMPTY_MESSAGE = "問題がありません（受講生はこのクイズを受験できません）";
export const NO_COURSE_GROUP_LABEL = "コースなし";
export const QUIZ_EDIT_SCOPE_NOTE = "問題文・選択肢・正解を 1 問ずつ直せます。問題の追加・削除・並べ替えはできません。";

export function adminQuizTypeLabel(type: QuizType): string {
  return type === "FINAL" ? "修了テスト" : "ミニテスト";
}

export type QuizStatusBadge = { label: string; description: string };

/**
 * 一覧・詳細の状態のバッジ（ok は null）。
 * unavailable（問題が 0 件・選択肢か正解が壊れた問題がある）と no_course（振り分け先のコースがない）は、
 * どちらも受講生の一覧に出ない（student-quizzes の toQuizCourseItems）
 */
export function quizStatusBadge(status: AdminQuizStatus): QuizStatusBadge | null {
  if (status === "unavailable") {
    return { label: "受験できない", description: "問題がないか、選択肢・正解が正しくない問題があるため、受講生の一覧に出ません。" };
  }
  if (status === "no_course") {
    return { label: "コースなし", description: "振り分け先のコースがないため、受講生の一覧に出ません。" };
  }
  return null;
}

// ───────────── 一覧（クイズの一覧の GET） ─────────────

const QUIZ_TYPES: ReadonlyArray<QuizType> = ["MINI", "FINAL"];
const QUIZ_STATUSES: ReadonlyArray<AdminQuizStatus> = ["ok", "unavailable", "no_course"];

function readSummary(value: unknown): AdminQuizSummary | null {
  if (!isPlainObject(value)) return null;
  const { id, title, type, courseId, courseName, lessonTitle, questionCount, attemptCount, status } = value;
  if (typeof id !== "string" || id === "" || typeof title !== "string") return null;
  if (typeof type !== "string" || !QUIZ_TYPES.includes(type as QuizType)) return null;
  if (!isStringOrNull(courseId) || !isStringOrNull(courseName) || !isStringOrNull(lessonTitle)) return null;
  if (!isNonNegativeInt(questionCount) || !isNonNegativeInt(attemptCount)) return null;
  if (typeof status !== "string" || !QUIZ_STATUSES.includes(status as AdminQuizStatus)) return null;
  return {
    id,
    title,
    type: type as QuizType,
    courseId,
    courseName,
    lessonTitle,
    questionCount,
    attemptCount,
    status: status as AdminQuizStatus,
  };
}

/** 一覧の応答（{ quizzes: AdminQuizSummary[] }）を読む。形が違えば（1 件でも）null（読み込みの失敗として扱う） */
export function readAdminQuizList(body: unknown): AdminQuizSummary[] | null {
  if (!isPlainObject(body) || !Array.isArray(body.quizzes)) return null;
  const out: AdminQuizSummary[] = [];
  for (const q of body.quizzes) {
    const s = readSummary(q);
    if (!s) return null;
    out.push(s);
  }
  return out;
}

export type AdminQuizRowView = {
  id: string;
  title: string;
  typeLabel: string;
  /** ミニテストのレッスン名。修了テスト・レッスンがないときは "—" */
  lessonLabel: string;
  questionCount: number;
  attemptCount: number;
  badge: QuizStatusBadge | null;
};

export type AdminQuizGroupView = {
  /** React の key（コースの id。コースなしは別の印） */
  key: string;
  courseName: string;
  noCourse: boolean;
  rows: AdminQuizRowView[];
};

const NO_COURSE_KEY = "no-course";

/**
 * 一覧をコースごとにまとめる。並びはサーバーの並び（コース順 → 修了テスト → ミニテスト、コースなしは最後）のまま。
 * コースなし（courseId が null）は最後に 1 つのまとまりにする（サーバーも最後に並べる）
 */
export function toAdminQuizGroups(quizzes: ReadonlyArray<AdminQuizSummary>): AdminQuizGroupView[] {
  const groups: AdminQuizGroupView[] = [];
  const byCourse = new Map<string, AdminQuizGroupView>();
  let noCourse: AdminQuizGroupView | null = null;
  for (const q of quizzes) {
    const row: AdminQuizRowView = {
      id: q.id,
      title: q.title,
      typeLabel: adminQuizTypeLabel(q.type),
      lessonLabel: q.type === "MINI" && q.lessonTitle ? q.lessonTitle : "—",
      questionCount: q.questionCount,
      attemptCount: q.attemptCount,
      badge: quizStatusBadge(q.status),
    };
    if (q.courseId === null) {
      if (!noCourse) noCourse = { key: NO_COURSE_KEY, courseName: NO_COURSE_GROUP_LABEL, noCourse: true, rows: [] };
      noCourse.rows.push(row);
      continue;
    }
    let g = byCourse.get(q.courseId);
    if (!g) {
      g = { key: `course-${q.courseId}`, courseName: q.courseName ?? "（名前のないコース）", noCourse: false, rows: [] };
      byCourse.set(q.courseId, g);
      groups.push(g);
    }
    g.rows.push(row);
  }
  if (noCourse) groups.push(noCourse);
  return groups;
}

// ───────────── 詳細（クイズの詳細の GET） ─────────────

function readQuestion(value: unknown): AdminQuizQuestion | null {
  if (!isPlainObject(value)) return null;
  const { id, order, question, options, correctIndex, valid, revision } = value;
  if (typeof id !== "string" || id === "" || typeof question !== "string") return null;
  if (typeof order !== "number" || !Number.isInteger(order)) return null;
  if (typeof correctIndex !== "number" || !Number.isInteger(correctIndex)) return null;
  if (typeof valid !== "boolean") return null;
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) return null;
  let opts: string[] | null = null;
  if (options !== null) {
    if (!Array.isArray(options) || !options.every((o) => typeof o === "string")) return null;
    opts = [...(options as string[])];
  }
  return { id, order, question, options: opts, correctIndex, valid, revision };
}

/** 詳細の応答を読む。形が違う・別のクイズの応答なら null */
export function readAdminQuizDetail(body: unknown, quizId: string): AdminQuizDetail | null {
  if (!isPlainObject(body)) return null;
  const { id, title, type, courseName, lessonTitle, attemptCount, status, questions } = body;
  if (id !== quizId || typeof title !== "string") return null;
  if (typeof type !== "string" || !QUIZ_TYPES.includes(type as QuizType)) return null;
  if (!isStringOrNull(courseName) || !isStringOrNull(lessonTitle) || !isNonNegativeInt(attemptCount)) return null;
  if (typeof status !== "string" || !QUIZ_STATUSES.includes(status as AdminQuizStatus)) return null;
  if (!Array.isArray(questions)) return null;
  const qs: AdminQuizQuestion[] = [];
  for (const q of questions) {
    const r = readQuestion(q);
    if (!r) return null;
    qs.push(r);
  }
  return {
    id: quizId,
    title,
    type: type as QuizType,
    courseName,
    lessonTitle,
    attemptCount,
    status: status as AdminQuizStatus,
    questions: sortQuestions(qs),
  };
}

/** 問題を [order, id] の順に並べる（受験と同じ並び。サーバーもこの順で返す） */
export function sortQuestions(questions: ReadonlyArray<AdminQuizQuestion>): AdminQuizQuestion[] {
  return [...questions].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 詳細の見出しの下の 1 行（種類・コース・レッスン・問題数・受験数） */
export function quizDetailMeta(detail: AdminQuizDetail): string {
  const parts = [adminQuizTypeLabel(detail.type), detail.courseName ?? NO_COURSE_GROUP_LABEL];
  if (detail.type === "MINI" && detail.lessonTitle) parts.push(detail.lessonTitle);
  parts.push(`問題 ${detail.questions.length} 問`, `受験 ${detail.attemptCount} 件`);
  return parts.join(" · ");
}

export type QuestionOptionView = { text: string; correct: boolean };

export type QuestionView = {
  id: string;
  /** 1 から（[order, id] の順の位置） */
  number: number;
  question: string;
  /** 元の並び。壊れていれば null */
  options: QuestionOptionView[] | null;
  /** valid: false のときの警告。valid なら null */
  warning: string | null;
};

export const BROKEN_OPTIONS_WARNING =
  "選択肢のデータが壊れているため表示できません。受講生はこのクイズを受験できません。「編集」で選択肢を入力し直してください。";
export const CORRECT_OUT_OF_RANGE_WARNING =
  "正解の位置が選択肢の範囲外です。受講生はこのクイズを受験できません。「編集」で正解を選び直してください。";

/** 詳細の 1 問の表示。選択肢は並べ替えず、正解に印を付ける */
export function toQuestionView(q: AdminQuizQuestion, index: number): QuestionView {
  const options = q.options === null ? null : q.options.map((text, i) => ({ text, correct: i === q.correctIndex }));
  let warning: string | null = null;
  if (!q.valid) warning = q.options === null ? BROKEN_OPTIONS_WARNING : CORRECT_OUT_OF_RANGE_WARNING;
  return { id: q.id, number: index + 1, question: q.question, options, warning };
}

/** 問題を直したあとのクイズの状態（サーバーの adminQuizStatus と同じ規則：全問 valid かつ 1 問以上で、コースがあれば ok） */
export function quizStatusAfterEdit(questions: ReadonlyArray<AdminQuizQuestion>, courseName: string | null): AdminQuizStatus {
  if (questions.length === 0 || questions.some((q) => !q.valid)) return "unavailable";
  if (courseName === null) return "no_course";
  return "ok";
}

// ───────────── 編集ダイアログの下書き ─────────────

export type OptionDraft = { key: number; text: string };

/**
 * 編集中の内容。正解は位置ではなく選択肢の key で持つ（並べ替え・削除しても同じ選択肢を指す）。
 * 送るときに今の位置（correctIndex）に直す（questionEditOutcome）
 */
export type QuestionDraft = {
  question: string;
  options: OptionDraft[];
  /** 正解の選択肢の key。選んでいない（元の正解が範囲外・正解の選択肢を消した）なら null */
  correctKey: number | null;
  /** 次に足す選択肢の key */
  nextKey: number;
};

export function initialQuestionDraft(q: AdminQuizQuestion): QuestionDraft {
  const texts = q.options ?? Array.from({ length: MIN_OPTIONS }, () => "");
  const options = texts.map((text, key) => ({ key, text }));
  const correctKey = q.options !== null && isNonNegativeInt(q.correctIndex) && q.correctIndex < q.options.length ? q.correctIndex : null;
  return { question: q.question, options, correctKey, nextKey: options.length };
}

export function setDraftQuestion(d: QuestionDraft, question: string): QuestionDraft {
  return { ...d, question };
}

export function setDraftOptionText(d: QuestionDraft, key: number, text: string): QuestionDraft {
  return { ...d, options: d.options.map((o) => (o.key === key ? { ...o, text } : o)) };
}

export function setDraftCorrect(d: QuestionDraft, key: number): QuestionDraft {
  return d.options.some((o) => o.key === key) ? { ...d, correctKey: key } : d;
}

export function canAddOption(d: QuestionDraft): boolean {
  return d.options.length < MAX_OPTIONS;
}

export function canRemoveOption(d: QuestionDraft): boolean {
  return d.options.length > MIN_OPTIONS;
}

/** 空の選択肢を最後に足す（MAX_OPTIONS 件までは何もしない） */
export function addDraftOption(d: QuestionDraft): QuestionDraft {
  if (!canAddOption(d)) return d;
  return { ...d, options: [...d.options, { key: d.nextKey, text: "" }], nextKey: d.nextKey + 1 };
}

/** 選択肢を消す（MIN_OPTIONS 件のときは何もしない）。正解の選択肢を消したら、正解は未選択に戻す */
export function removeDraftOption(d: QuestionDraft, key: number): QuestionDraft {
  if (!canRemoveOption(d) || !d.options.some((o) => o.key === key)) return d;
  return { ...d, options: d.options.filter((o) => o.key !== key), correctKey: d.correctKey === key ? null : d.correctKey };
}

/** 選択肢を 1 つ上（-1）・下（+1）へ動かす。端なら何もしない。正解は key で持つので、同じ選択肢のまま */
export function moveDraftOption(d: QuestionDraft, key: number, delta: -1 | 1): QuestionDraft {
  const i = d.options.findIndex((o) => o.key === key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= d.options.length) return d;
  const options = [...d.options];
  [options[i], options[j]] = [options[j], options[i]];
  return { ...d, options };
}

/** 正解の今の位置（0 から）。選んでいなければ null */
export function draftCorrectIndex(d: QuestionDraft): number | null {
  if (d.correctKey === null) return null;
  const i = d.options.findIndex((o) => o.key === d.correctKey);
  return i < 0 ? null : i;
}

// ───────────── 送る body ─────────────

export type QuestionPatchBody = {
  revision: string;
  question?: string;
  options?: string[];
  correctIndex?: number;
};

export type QuestionEditOutcome =
  | { kind: "unchanged" }
  | { kind: "invalid"; message: string }
  | { kind: "ready"; body: QuestionPatchBody; changed: ChangedField[] };

export const EDIT_UNCHANGED_MESSAGE = "変更がありません。";
export const CORRECT_NOT_SELECTED_MESSAGE = "正解の選択肢を選んでください。";

/** 400 の reason ごとの文言（保存の前の検証と、サーバーの 400 の両方に使う） */
const REASON_MESSAGES: Readonly<Record<PatchQuestionReason | "invalid_id", string>> = {
  invalid_question: `問題文は ${QUESTION_MAX_LENGTH} 文字以内で入力してください（空白・見えない文字だけにはできません。使えない文字が含まれていないかも確かめてください）。`,
  invalid_options: `選択肢は ${MIN_OPTIONS}〜${MAX_OPTIONS} 件、それぞれ ${OPTION_MAX_LENGTH} 文字以内で入力してください（空の選択肢・同じ内容の選択肢・使えない文字は使えません）。`,
  invalid_correct_index: CORRECT_NOT_SELECTED_MESSAGE,
  no_changes: "変更がありません。最新の内容と同じです。",
  invalid_revision: "保存できませんでした。画面を再読み込みしてから、もう一度お試しください。",
  unknown_field: "保存できませんでした。画面を再読み込みしてから、もう一度お試しください。",
  invalid_json: "保存できませんでした。画面を再読み込みしてから、もう一度お試しください。",
  invalid_id: "保存できませんでした。画面を再読み込みしてから、もう一度お試しください。",
};

/** 400 の reason の文言。知らない reason は「再読み込みしてから」の文言 */
export function patchReasonMessage(reason: unknown): string {
  if (typeof reason === "string" && Object.prototype.hasOwnProperty.call(REASON_MESSAGES, reason)) {
    return REASON_MESSAGES[reason as PatchQuestionReason];
  }
  return REASON_MESSAGES.invalid_json;
}

function sameTrimmed(a: ReadonlyArray<string>, b: ReadonlyArray<string> | null): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i].trim());
}

/**
 * 元の問題（ダイアログを開いたときの内容）と下書きから、送る body を決める。送るのは変わった項目と revision だけ。
 * - 問題文：前後の空白を除いて、元（前後の空白を除いたもの）と違えば送る
 * - 選択肢：各要素の前後の空白を除いて、元と件数・並び・文のどれかが違えば送る（元が壊れていれば必ず送る）
 * - 正解：下書きの正解の今の位置（並べ替え・削除のあとの位置）が元の correctIndex と違えば送る
 * 選択肢を送るのに正解を選んでいなければ invalid。サーバーと同じ parsePatchQuestionBody で確かめ、通らなければ reason の文言
 */
export function questionEditOutcome(original: AdminQuizQuestion, draft: QuestionDraft): QuestionEditOutcome {
  const question = draft.question.trim();
  const options = draft.options.map((o) => o.text.trim());
  const finalIndex = draftCorrectIndex(draft);

  const questionChanged = question !== original.question.trim();
  const optionsChanged = !sameTrimmed(options, original.options);
  const correctChanged = finalIndex !== null && finalIndex !== original.correctIndex;

  if (!questionChanged && !optionsChanged && !correctChanged) return { kind: "unchanged" };
  if (optionsChanged && finalIndex === null) return { kind: "invalid", message: CORRECT_NOT_SELECTED_MESSAGE };

  const body: QuestionPatchBody = { revision: original.revision };
  const changed: ChangedField[] = [];
  if (questionChanged) {
    body.question = question;
    changed.push("question");
  }
  if (optionsChanged) {
    body.options = options;
    changed.push("options");
  }
  if (correctChanged) {
    body.correctIndex = finalIndex;
    changed.push("correctIndex");
  }

  const parsed = parsePatchQuestionBody(body);
  // tsconfig は strict: false なので ok では絞り込めない。"reason" in で失敗側に絞る（route と同じ）
  if ("reason" in parsed) return { kind: "invalid", message: patchReasonMessage(parsed.reason) };
  return { kind: "ready", body, changed };
}

// ───────────── 保存の前の確認 ─────────────

const CHANGED_FIELD_LABELS: Readonly<Record<ChangedField, string>> = {
  question: "問題文",
  options: "選択肢",
  correctIndex: "正解",
};

const FIELD_ORDER: ReadonlyArray<ChangedField> = ["question", "options", "correctIndex"];

export function changedFieldsLabel(changed: ReadonlyArray<ChangedField>): string {
  return FIELD_ORDER.filter((f) => changed.includes(f)).map((f) => CHANGED_FIELD_LABELS[f]).join("・");
}

export const OPTIONS_CHANGE_NOTICE = "選択肢を変えると、いま受験中の受講生は回答のやり直しになります";

export function pastAttemptsNotice(attemptCount: number): string {
  return `過去の受験 ${attemptCount} 件の点数・合否は変わりません`;
}

/**
 * 保存の前に出す確認文。
 * - 選択肢を変えるときだけ OPTIONS_CHANGE_NOTICE（受験中のトークンでの送信は 409 quiz_changed になる）
 * - 受験記録が 1 件以上あるときだけ pastAttemptsNotice（過去の記録は再採点しない。D2 a）
 */
export function questionEditConfirmLines(changed: ReadonlyArray<ChangedField>, attemptCount: number): string[] {
  const lines: string[] = [];
  if (changed.includes("options")) lines.push(OPTIONS_CHANGE_NOTICE);
  if (isNonNegativeInt(attemptCount) && attemptCount >= 1) lines.push(pastAttemptsNotice(attemptCount));
  return lines;
}

export function editDialogTitle(number: number): string {
  return `問題 ${number} を編集`;
}

// ───────────── 保存の応答（問題の PATCH） ─────────────

export const EDIT_CONFLICT_MESSAGE = "他の講師が先に更新しました。最新の内容を読み込みます";
export const SAVE_UNCERTAIN_MESSAGE = "保存できたか確認できません。読み直してください";
export const QUESTION_GONE_MESSAGE = "この問題は見つかりませんでした。最新の内容を読み込みます";
export const SAVE_FORBIDDEN_MESSAGE = "この操作を行う権限がありません。";
export const SAVE_SERVER_ERROR_MESSAGE = "サーバーでエラーが発生しました。時間をおいて、もう一度お試しください。";
export const SAVE_SESSION_EXPIRED_MESSAGE = "ログインの有効期限が切れました。もう一度ログインしてください。";

/** 保存できたときの知らせ（role="status"） */
export function questionSavedMessage(number: number, changed: ReadonlyArray<ChangedField>): string {
  const label = changedFieldsLabel(changed);
  return label ? `問題 ${number} を保存しました（${label}）` : `問題 ${number} を保存しました`;
}

const CHANGED_FIELDS: ReadonlyArray<string> = FIELD_ORDER;

/**
 * PATCH の応答の扱い：
 * - success：2xx・リダイレクトなし・本文が対象の問題（新しい revision 付き）。ダイアログを閉じて、詳細のその問題を置き換える
 * - conflict：409（edit_conflict）。ダイアログを閉じ、詳細を読み直す
 * - gone：404。ダイアログを閉じ、詳細を読み直す
 * - uncertain：結果が分からない（通信エラーは呼び出し側。502 / 503 / 504・ログイン以外へのリダイレクト・2xx で本文を読めない）。
 *   ダイアログを閉じ、詳細を読み直す
 * - error：保存されていない（400・401・403・500 など）。ダイアログに文言を出し、下書きは残す
 * セッション切れ（classifyAuthFailure が expired）は、呼び出し側がこの関数より先に扱う
 */
export type QuestionPatchOutcome =
  | { kind: "success"; question: AdminQuizQuestion; changed: ChangedField[]; attemptCount: number }
  | { kind: "conflict"; message: string }
  | { kind: "gone"; message: string }
  | { kind: "uncertain"; message: string }
  | { kind: "error"; message: string };

export function interpretQuestionPatchResponse(input: {
  ok: boolean;
  status: number;
  redirected: boolean;
  body: unknown;
  questionId: string;
}): QuestionPatchOutcome {
  const { ok, status, redirected, body, questionId } = input;
  if (redirected) return { kind: "uncertain", message: SAVE_UNCERTAIN_MESSAGE };
  if (!ok) {
    const reason = isPlainObject(body) ? body.reason : undefined;
    if (status === 409) return { kind: "conflict", message: EDIT_CONFLICT_MESSAGE };
    if (status === 404) return { kind: "gone", message: QUESTION_GONE_MESSAGE };
    if (status === 400) return { kind: "error", message: patchReasonMessage(reason) };
    if (status === 401) return { kind: "error", message: SAVE_SESSION_EXPIRED_MESSAGE };
    if (status === 403) return { kind: "error", message: SAVE_FORBIDDEN_MESSAGE };
    if (status === 502 || status === 503 || status === 504) return { kind: "uncertain", message: SAVE_UNCERTAIN_MESSAGE };
    return { kind: "error", message: SAVE_SERVER_ERROR_MESSAGE };
  }
  if (!isPlainObject(body)) return { kind: "uncertain", message: SAVE_UNCERTAIN_MESSAGE };
  const question = readQuestion(body.question);
  const { changed, attemptCount } = body;
  if (
    !question ||
    question.id !== questionId ||
    !Array.isArray(changed) ||
    !changed.every((c) => typeof c === "string" && CHANGED_FIELDS.includes(c)) ||
    !isNonNegativeInt(attemptCount)
  ) {
    return { kind: "uncertain", message: SAVE_UNCERTAIN_MESSAGE };
  }
  return { kind: "success", question, changed: [...changed] as ChangedField[], attemptCount };
}

/** 保存できた問題で詳細を置き換える（受験数は応答の値、状態は quizStatusAfterEdit で決め直す） */
export function applyQuestionUpdate(
  detail: AdminQuizDetail,
  update: { question: AdminQuizQuestion; attemptCount: number }
): AdminQuizDetail {
  if (!detail.questions.some((q) => q.id === update.question.id)) return detail;
  const questions = detail.questions.map((q) => (q.id === update.question.id ? update.question : q));
  return { ...detail, questions, attemptCount: update.attemptCount, status: quizStatusAfterEdit(questions, detail.courseName) };
}
