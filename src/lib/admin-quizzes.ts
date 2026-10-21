/**
 * クイズ管理 API（#81 Q1）の入力検証・応答の組み立て・変わった項目の判定。
 *
 * クイズ管理の route（一覧の GET・詳細の GET・問題の PATCH）から使う。
 * （admin-closed-apis.test.ts が src の中の管理用クイズ API のパスを呼び出し元とみなすため、ここにはパスを書かない）
 * DB・時計・DOM・node:crypto に触れない純粋関数だけを置く（Q2 で画面の文言・判定を足し、page.tsx から import できるようにするため）。
 * revision（内容の sha256）の計算はサーバー専用の admin-quiz-revision.ts が、ここの revisionSource を使って行う。
 *
 * Tec の決定（#81、2026-10-20）：
 * - D1 a：編集できるのは問題文・選択肢の文・正解だけ。選択肢の数は 2〜10 件の範囲で変えてよい。問題の追加・削除・並べ替えはしない
 * - D2 a：過去の受験記録は再採点しない（件数だけを返す）
 * - D3 b：QuizQuestionRevision に履歴を残す（changedFields は 1 件以上。before / after は {question, options, correctIndex}）
 * - D4 a：revision による楽観ロック
 */

import type { Prisma } from "@prisma/client";
import { commentLength, hasVisibleText } from "./lesson-comments";
import { MIN_OPTIONS, normalizeOptions, quizCourseId, toAnswerKey, type AnswerKeyRow, type ParseResult, type QuizType } from "./student-quizzes";

/** 問題文の最大の文字数（前後の空白を除いたあと。サロゲートペアは 1 文字） */
export const QUESTION_MAX_LENGTH = 1000;

/** 選択肢 1 つの最大の文字数（前後の空白を除いたあと） */
export const OPTION_MAX_LENGTH = 300;

/** 1 問あたりの最大の選択肢数（最小は student-quizzes の MIN_OPTIONS = 2） */
export const MAX_OPTIONS = 10;

/** revision の形（sha256 の 16 進 64 字、小文字） */
export const REVISION_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const byOrderThenId = (a: { order: number; id: string }, b: { order: number; id: string }) =>
  a.order - b.order || compareText(a.id, b.id);

const byTitleThenId = (a: { title: string; id: string }, b: { title: string; id: string }) =>
  compareText(a.title, b.title) || compareText(a.id, b.id);

// ───────────── 状態 ─────────────

/**
 * - ok：受講生が受験できる
 * - unavailable：問題が 0 件、options が壊れている、correctIndex が範囲外の問題を 1 つでも含む（toAnswerKey が null）
 * - no_course：振り分け先のコースがない（quizCourseId が null、または修了テストの courseId のコースが存在しない）
 * 両方に当たるときは unavailable を優先する（コースがないことは、一覧の並びで最後の「コースなし」にまとめることで分かる）
 */
export type AdminQuizStatus = "ok" | "unavailable" | "no_course";

export function adminQuizStatus(questions: ReadonlyArray<AnswerKeyRow>, hasCourse: boolean): AdminQuizStatus {
  if (!toAnswerKey(questions)) return "unavailable";
  if (!hasCourse) return "no_course";
  return "ok";
}

// ───────────── 一覧（GET） ─────────────

export type AdminQuizSummary = {
  id: string;
  title: string;
  type: QuizType;
  courseId: string | null;
  courseName: string | null;
  lessonTitle: string | null;
  questionCount: number;
  attemptCount: number;
  status: AdminQuizStatus;
};

export type AdminQuizListResponse = { quizzes: AdminQuizSummary[] };

export type AdminCourseRef = { id: string; name: string };

/** 一覧の route が読む 1 件（prisma の select と同じ形） */
export type AdminQuizListRow = {
  id: string;
  title: string;
  type: QuizType;
  courseId: string | null;
  lesson: {
    id: string;
    title: string;
    order: number;
    section: { id: string; order: number; courseId: string };
  } | null;
  /** 状態（toAnswerKey）の判定と件数だけに使う。応答には選択肢・正解を出さない */
  questions: ReadonlyArray<AnswerKeyRow>;
  _count: { attempts: number };
};

/**
 * 一覧の GET の quizzes（AdminQuizSummary の配列）。
 * 並び：
 * - コースの並び（courses は route が COURSE_ORDER_BY で読んだ順）ごとに、修了テスト（タイトル・id 順）→
 *   ミニテスト（セクションの [order, id] → レッスンの [order, id] → タイトル・id 順）
 * - コースがないクイズは最後に、修了テスト → ミニテストの順で、それぞれタイトル・id 順
 * コースは quizCourseId（受講生の一覧・ロックの確認と同じ規則）で決める。修了テストの courseId は FK がないので、
 * courses にないコースを指していれば「コースなし」（courseId・courseName は null）として扱う。
 * lessonTitle はミニテストだけ（受講生の一覧と同じ）
 */
export function buildAdminQuizList(
  courses: ReadonlyArray<AdminCourseRef>,
  quizzes: ReadonlyArray<AdminQuizListRow>
): AdminQuizSummary[] {
  const courseById = new Map<string, AdminCourseRef>();
  for (const c of courses) if (!courseById.has(c.id)) courseById.set(c.id, c);

  const finals = new Map<string, AdminQuizListRow[]>();
  const minis = new Map<string, AdminQuizListRow[]>();
  const orphanFinals: AdminQuizListRow[] = [];
  const orphanMinis: AdminQuizListRow[] = [];
  const courseOf = new Map<string, AdminCourseRef | null>();

  for (const q of quizzes) {
    const cid = quizCourseId(q);
    const course = cid === null ? null : courseById.get(cid) ?? null;
    courseOf.set(q.id, course);
    if (course === null) {
      (q.type === "FINAL" ? orphanFinals : orphanMinis).push(q);
      continue;
    }
    const target = q.type === "FINAL" ? finals : minis;
    const list = target.get(course.id);
    if (list) list.push(q);
    else target.set(course.id, [q]);
  }

  const byLessonOrder = (a: AdminQuizListRow, b: AdminQuizListRow) => {
    // コースのあるミニテストは lesson がある（quizCourseId が lesson.section.courseId を使うため）
    const la = a.lesson;
    const lb = b.lesson;
    if (!la || !lb) return byTitleThenId(a, b);
    return byOrderThenId(la.section, lb.section) || byOrderThenId(la, lb) || byTitleThenId(a, b);
  };

  const toSummary = (q: AdminQuizListRow): AdminQuizSummary => {
    const course = courseOf.get(q.id) ?? null;
    return {
      id: q.id,
      title: q.title,
      type: q.type,
      courseId: course?.id ?? null,
      courseName: course?.name ?? null,
      lessonTitle: q.type === "MINI" ? q.lesson?.title ?? null : null,
      questionCount: q.questions.length,
      attemptCount: q._count.attempts,
      status: adminQuizStatus(q.questions, course !== null),
    };
  };

  const out: AdminQuizSummary[] = [];
  const seenCourses = new Set<string>();
  for (const c of courses) {
    if (seenCourses.has(c.id)) continue;
    seenCourses.add(c.id);
    out.push(...[...(finals.get(c.id) ?? [])].sort(byTitleThenId).map(toSummary));
    out.push(...[...(minis.get(c.id) ?? [])].sort(byLessonOrder).map(toSummary));
  }
  out.push(...[...orphanFinals].sort(byTitleThenId).map(toSummary));
  out.push(...[...orphanMinis].sort(byTitleThenId).map(toSummary));
  return out;
}

// ───────────── 詳細（GET） ─────────────

/** 内容（revision の元）。QuizQuestion の列と同じ形 */
export type QuestionContent = { question: string; options: Prisma.JsonValue; correctIndex: number };

export type AdminQuestionRow = QuestionContent & { id: string; order: number };

export type AdminQuizQuestion = {
  id: string;
  order: number;
  question: string;
  /** 壊れていれば null（normalizeOptions）。元の並び（シャッフルしない） */
  options: string[] | null;
  correctIndex: number;
  /** その問題だけで toAnswerKey が通るか */
  valid: boolean;
  /** 現在の内容の sha256（楽観ロック用。秘密の鍵は使わない） */
  revision: string;
};

export type AdminQuizDetail = {
  id: string;
  title: string;
  type: QuizType;
  courseName: string | null;
  lessonTitle: string | null;
  attemptCount: number;
  status: AdminQuizStatus;
  /** [order, id] の順（受験と同じ並び） */
  questions: AdminQuizQuestion[];
};

/**
 * revision の元の文字列。内容（問題文・options の JSON・正解）だけで決まり、id・order・時刻は含めない。
 * 形を変えると、画面が持っている revision がすべて 409 edit_conflict になる（v1 の印を変える）
 */
export function revisionSource(content: QuestionContent): string {
  return JSON.stringify(["nwa-lms:quiz-question-revision:v1", content.question, content.options, content.correctIndex]);
}

/** 1 問を応答の形にする（許可リストで組み立てる）。revision は呼び出し元が revisionSource から計算して渡す */
export function toAdminQuizQuestion(row: AdminQuestionRow, revision: string): AdminQuizQuestion {
  return {
    id: row.id,
    order: row.order,
    question: row.question,
    options: normalizeOptions(row.options),
    correctIndex: row.correctIndex,
    valid: toAnswerKey([{ options: row.options, correctIndex: row.correctIndex }]) !== null,
    revision,
  };
}

/** 詳細の route が読む 1 件（prisma の select と同じ形） */
export type AdminQuizDetailRow = {
  id: string;
  title: string;
  type: QuizType;
  courseId: string | null;
  lesson: { title: string; section: { courseId: string } } | null;
  questions: ReadonlyArray<AdminQuestionRow>;
  _count: { attempts: number };
};

/**
 * 詳細の GET の応答。courseName は route が quizCourseId のコースを読んだ結果（なければ null）。
 * 問題は [order, id] の順に並べ直す（route も同じ順で読む）。選択肢は元の並び
 */
export function buildAdminQuizDetail(
  quiz: AdminQuizDetailRow,
  courseName: string | null,
  revisionOf: (content: QuestionContent) => string
): AdminQuizDetail {
  const rows = [...quiz.questions].sort(byOrderThenId);
  return {
    id: quiz.id,
    title: quiz.title,
    type: quiz.type,
    courseName,
    lessonTitle: quiz.type === "MINI" ? quiz.lesson?.title ?? null : null,
    attemptCount: quiz._count.attempts,
    status: adminQuizStatus(rows, courseName !== null),
    questions: rows.map((r) => toAdminQuizQuestion(r, revisionOf(r))),
  };
}

// ───────────── 問題の修正（PATCH） ─────────────

export type ChangedField = "question" | "options" | "correctIndex";

/** changedFields・changed の並び（固定） */
export const CHANGED_FIELD_ORDER: ReadonlyArray<ChangedField> = ["question", "options", "correctIndex"];

/** body で受け付ける項目。これ以外（order・quizId・id など）があれば 400 unknown_field */
export const PATCH_QUESTION_FIELDS: ReadonlyArray<string> = ["revision", "question", "options", "correctIndex"];

export type PatchQuestionReason =
  | "invalid_json"
  | "unknown_field"
  | "invalid_revision"
  | "invalid_question"
  | "invalid_options"
  | "invalid_correct_index"
  | "no_changes";

export type PatchQuestionInput = {
  revision: string;
  /** 前後の空白を除いた値 */
  question?: string;
  /** 各要素の前後の空白を除いた値 */
  options?: string[];
  correctIndex?: number;
};

/** NUL（U+0000）。Postgres の text・jsonb は受け付けない */
const NUL = /\u0000/;

/** 対になっていないサロゲート（isWellFormed がない環境での代わり） */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 重複の判定で取り除く文字：書式文字（ZWSP・ZWJ・ソフトハイフン・BOM など）と異体字セレクタ */
// tsconfig の target が ES5 のため、u フラグの正規表現はリテラルでなく RegExp で作る
const IGNORED_FOR_DUPLICATE = new RegExp("[\\p{Cf}\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]", "gu");

/** 対になっていないサロゲートを含まない（Postgres の jsonb は拒否し、text は U+FFFD に置き換えて revision が食い違う） */
function isWellFormedText(s: string): boolean {
  return typeof s.isWellFormed === "function" ? s.isWellFormed() : !LONE_SURROGATE.test(s);
}

/**
 * 前後の空白を除いて、見える文字が 1 文字以上あり、max 文字以内なら除いた値。違えば null。
 * NUL と対になっていないサロゲートを含む値も null（DB に送らずに 400 にする）。
 * 重い正規化（hasVisibleText）の前に、UTF-16 の長さが max の 2 倍を超えたら断る
 * （1 文字は UTF-16 で 2 単位以下なので、2 倍を超えれば必ず max 文字を超える。結果は文字数の規則と同じ）
 */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t === "" || t.length > max * 2) return null;
  if (NUL.test(t) || !isWellFormedText(t)) return null;
  if (commentLength(t) > max || !hasVisibleText(t)) return null;
  return t;
}

/**
 * 選択肢の重複を判定するための形：NFC で正規化し、書式文字と異体字セレクタを除く（除いたあとにもう一度 NFC）。
 * 見た目が同じ選択肢（"a" と "a" + ZWSP、NFC と NFD の「が」など）を同じとみなす。保存する値には使わない
 */
export function optionDuplicateKey(text: string): string {
  return text.normalize("NFC").replace(IGNORED_FOR_DUPLICATE, "").normalize("NFC");
}

/**
 * PATCH の body を検証する（DB を読む前。正解の位置が選択肢の範囲内かは planQuestionEdit が DB の値と合わせて見る）。
 * 判定の順：
 * 1. オブジェクトでない：invalid_json
 * 2. PATCH_QUESTION_FIELDS 以外の項目がある（order・quizId など）：unknown_field（黙って無視せず、変えられないことを知らせる）
 * 3. revision が REVISION_PATTERN に合わない・ない：invalid_revision
 * 4. question：文字列で、前後の空白を除いて 1〜QUESTION_MAX_LENGTH 字、見える文字を含む、NUL・対になっていない
 *    サロゲートを含まない。違えば invalid_question
 * 5. options：配列で MIN_OPTIONS〜MAX_OPTIONS 件、各要素が文字列で前後の空白を除いて 1〜OPTION_MAX_LENGTH 字、
 *    見える文字を含む、NUL・対になっていないサロゲートを含まない、optionDuplicateKey で比べて重複しない。
 *    違えば invalid_options（保存するのは前後の空白を除いただけの値）
 * 6. correctIndex：0 以上の整数で MAX_OPTIONS 未満。違えば invalid_correct_index
 * 7. question・options・correctIndex のどれもない：no_changes
 * 成功時の value は新しい値（options は新しい配列）
 */
export function parsePatchQuestionBody(body: unknown): ParseResult<PatchQuestionInput, PatchQuestionReason> {
  if (!isPlainObject(body)) return { ok: false, reason: "invalid_json" };
  if (Object.keys(body).some((k) => !PATCH_QUESTION_FIELDS.includes(k))) return { ok: false, reason: "unknown_field" };
  const { revision } = body;
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) return { ok: false, reason: "invalid_revision" };

  const value: PatchQuestionInput = { revision };

  if ("question" in body) {
    const q = cleanText(body.question, QUESTION_MAX_LENGTH);
    if (q === null) return { ok: false, reason: "invalid_question" };
    value.question = q;
  }

  if ("options" in body) {
    const raw = body.options;
    if (!Array.isArray(raw) || raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) return { ok: false, reason: "invalid_options" };
    const options: string[] = [];
    const keys = new Set<string>();
    for (const o of raw) {
      const t = cleanText(o, OPTION_MAX_LENGTH);
      if (t === null) return { ok: false, reason: "invalid_options" };
      const key = optionDuplicateKey(t);
      if (keys.has(key)) return { ok: false, reason: "invalid_options" };
      keys.add(key);
      options.push(t);
    }
    value.options = options;
  }

  if ("correctIndex" in body) {
    const ci = body.correctIndex;
    if (!isNonNegativeInt(ci) || ci >= MAX_OPTIONS) return { ok: false, reason: "invalid_correct_index" };
    value.correctIndex = ci;
  }

  if (value.question === undefined && value.options === undefined && value.correctIndex === undefined) {
    return { ok: false, reason: "no_changes" };
  }
  return { ok: true, value };
}

/** 履歴（QuizQuestionRevision.before / after）に書く形。options は DB の JSON のまま（壊れた値もそのまま残す） */
export type QuestionSnapshot = { question: string; options: Prisma.JsonValue; correctIndex: number };

export type QuestionEditPlan = {
  /** updateMany の data（変わった項目だけ） */
  data: { question?: string; options?: string[]; correctIndex?: number };
  /** 変わった項目（CHANGED_FIELD_ORDER の順、1 件以上） */
  changed: ChangedField[];
  before: QuestionSnapshot;
  after: QuestionSnapshot;
};

function sameStrings(a: ReadonlyArray<string>, b: ReadonlyArray<string> | null): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

/**
 * 今の内容（DB の行）と検証済みの入力から、更新の内容を決める。
 * - options か correctIndex を送ったときは、変更後の正解が変更後の選択肢の範囲内であることを求める
 *   （今の options が壊れていて options を送らない場合は確かめられないので invalid_correct_index）。
 *   問題文だけを送ったときは確かめない（壊れた問題の問題文も直せる）
 * - 送った値が今と同じ項目は変えない。1 つも変わらなければ no_changes（履歴を書かない）
 * - options は、今の値が壊れている（normalizeOptions が null）なら、送れば必ず変わったとみなす
 */
export function planQuestionEdit(
  current: QuestionContent,
  input: PatchQuestionInput
): ParseResult<QuestionEditPlan, "invalid_correct_index" | "no_changes"> {
  const currentOptions = normalizeOptions(current.options);

  if (input.options !== undefined || input.correctIndex !== undefined) {
    const finalOptions = input.options ?? currentOptions;
    const finalIndex = input.correctIndex ?? current.correctIndex;
    if (!finalOptions || !isNonNegativeInt(finalIndex) || finalIndex >= finalOptions.length) {
      return { ok: false, reason: "invalid_correct_index" };
    }
  }

  const data: QuestionEditPlan["data"] = {};
  const changed: ChangedField[] = [];
  if (input.question !== undefined && input.question !== current.question) {
    data.question = input.question;
    changed.push("question");
  }
  if (input.options !== undefined && !sameStrings(input.options, currentOptions)) {
    data.options = [...input.options];
    changed.push("options");
  }
  if (input.correctIndex !== undefined && input.correctIndex !== current.correctIndex) {
    data.correctIndex = input.correctIndex;
    changed.push("correctIndex");
  }
  if (changed.length === 0) return { ok: false, reason: "no_changes" };

  const before: QuestionSnapshot = { question: current.question, options: current.options, correctIndex: current.correctIndex };
  const after: QuestionSnapshot = {
    question: data.question ?? current.question,
    options: data.options ? [...data.options] : current.options,
    correctIndex: data.correctIndex ?? current.correctIndex,
  };
  return { ok: true, value: { data, changed, before, after } };
}

export type PatchQuestionResponse = {
  /** 新しい revision 付き */
  question: AdminQuizQuestion;
  changed: ChangedField[];
  /** options が変わった（受験中の受講生の送信は 409 quiz_changed になる） */
  inProgressInvalidated: boolean;
  /** 過去の受験記録の件数（点数・合否は変えていない。D2 a） */
  attemptCount: number;
};

export function patchQuestionResponse(question: AdminQuizQuestion, changed: ReadonlyArray<ChangedField>, attemptCount: number): PatchQuestionResponse {
  return {
    question,
    changed: [...changed],
    inProgressInvalidated: changed.includes("options"),
    attemptCount,
  };
}

/** 成功のログ（固定文と変わった項目の名前だけ。id・本文・選択肢は出さない） */
export function questionUpdatedLogMessage(changed: ReadonlyArray<ChangedField>): string {
  return `[admin] quiz question updated: ${CHANGED_FIELD_ORDER.filter((f) => changed.includes(f)).join(",")}`;
}
