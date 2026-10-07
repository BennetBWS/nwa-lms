/**
 * 確認テスト（#32）の入力検証・採点・一覧の集計・画面用の変換。
 *
 * route（src/app/api/quizzes/**）と src/app/page.tsx の QuizPage の両方から使う。
 * DB・時計・DOM に触れない純粋関数だけを置く。
 *
 * Tec の決定（#32、2026-10-07）：
 * - 一覧と受験を実装する。受験の開始ボタンは QUIZ_ATTEMPTS_ENABLED で隠し、#8（DB の分離）のあとに公開する
 * - 結果は点数・合否・正解数・問題ごとの正誤。正解そのものは見せない（API も返さない）
 * - 合格判定は四捨五入前の値で行う（正解率 70% 以上）
 * - レッスンの種類 QUIZ とはつながない（#50）
 */

import type { Prisma } from "@prisma/client";
import { isCourseLocked, type LessonCounts } from "./course-lock";

/** 受験（問題の表示・送信）を画面で開けるか。#8 のあとに true にする */
export const QUIZ_ATTEMPTS_ENABLED = false;

/** 合格に必要な正解率（%）。四捨五入前の値で判定する */
export const PASSING_PERCENT = 70;

/** 1 問あたりの最小の選択肢数 */
export const MIN_OPTIONS = 2;

export type ParseResult<T, R> = { ok: true; value: T } | { ok: false; reason: R };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const byOrderThenId = (a: { order: number; id: string }, b: { order: number; id: string }) =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ───────────── 問題・選択肢 ─────────────

/**
 * QuizQuestion.options（Json）を string[] にする。
 * 配列でない・文字列でない要素が混ざる・2 件未満なら null（壊れている）
 */
export function normalizeOptions(json: unknown): string[] | null {
  if (!Array.isArray(json)) return null;
  if (json.length < MIN_OPTIONS) return null;
  if (!json.every((o) => typeof o === "string")) return null;
  return [...json] as string[];
}

export type QuestionRow = { id: string; question: string; options: Prisma.JsonValue };

export type QuestionView = { id: string; question: string; options: string[] };

/**
 * GET /api/quizzes/[quizId] の questions。並びは受け取った順（route が [order, id] で並べる）。
 * 問題が 0 件、または 1 問でも options が壊れていれば null（受験できない）。
 * correctIndex は受け取らないし返さない
 */
export function toQuestionViews(rows: ReadonlyArray<QuestionRow>): QuestionView[] | null {
  if (rows.length === 0) return null;
  const out: QuestionView[] = [];
  for (const r of rows) {
    const options = normalizeOptions(r.options);
    if (!options) return null;
    out.push({ id: r.id, question: r.question, options });
  }
  return out;
}

export type AnswerKeyRow = { options: Prisma.JsonValue; correctIndex: number };

export type AnswerKey = { optionCounts: number[]; correctIndexes: number[] };

/**
 * 採点用の選択肢数と正解の位置。並びは受け取った順。
 * 問題が 0 件、options が壊れている、correctIndex が選択肢の範囲外なら null（受験できない）
 */
export function toAnswerKey(rows: ReadonlyArray<AnswerKeyRow>): AnswerKey | null {
  if (rows.length === 0) return null;
  const optionCounts: number[] = [];
  const correctIndexes: number[] = [];
  for (const r of rows) {
    const options = normalizeOptions(r.options);
    if (!options) return null;
    if (!isNonNegativeInt(r.correctIndex) || r.correctIndex >= options.length) return null;
    optionCounts.push(options.length);
    correctIndexes.push(r.correctIndex);
  }
  return { optionCounts, correctIndexes };
}

// ───────────── POST /api/quizzes/[quizId]/submit の入力 ─────────────

export type SubmitAnswersReason = "invalid_answers";

/** body が { answers: 配列 } の形か（DB を読む前の確認。中身は parseSubmitAnswers で見る） */
export function hasAnswersArray(body: unknown): boolean {
  return isPlainObject(body) && Array.isArray(body.answers);
}

/**
 * submit の body を検証する。`{ answers: number[] }` で、
 * 長さは問題数（optionCounts.length）と同じ、各要素は 0 以上で、その問題の選択肢数未満の整数。
 * 小数・文字列・null・NaN・Infinity・true などは不可。userId などほかの項目は読まない。
 * 成功時の value は新しい配列（検証済みの値だけ）
 */
export function parseSubmitAnswers(
  body: unknown,
  optionCounts: ReadonlyArray<number>
): ParseResult<number[], SubmitAnswersReason> {
  if (!isPlainObject(body)) return { ok: false, reason: "invalid_answers" };
  const answers = body.answers;
  if (!Array.isArray(answers)) return { ok: false, reason: "invalid_answers" };
  if (optionCounts.length === 0 || answers.length !== optionCounts.length) {
    return { ok: false, reason: "invalid_answers" };
  }
  const value: number[] = [];
  for (let i = 0; i < optionCounts.length; i++) {
    const a: unknown = answers[i];
    if (!isNonNegativeInt(a) || a >= optionCounts[i]) return { ok: false, reason: "invalid_answers" };
    value.push(a);
  }
  return { ok: true, value };
}

// ───────────── 採点 ─────────────

export type AttemptScore = {
  correct: number;
  total: number;
  /** 正解率（%）を四捨五入した整数 */
  score: number;
  /** 四捨五入前の正解率が PASSING_PERCENT 以上 */
  passed: boolean;
  /** 問題ごとの正誤（並びは問題の順） */
  results: boolean[];
};

/**
 * 採点する。answers は parseSubmitAnswers で検証済み（長さが correctIndexes と同じ）であること。
 * 問題 0 件は score 0・不合格（route はその前に 409 を返す）
 */
export function scoreAttempt(answers: ReadonlyArray<number>, correctIndexes: ReadonlyArray<number>): AttemptScore {
  const total = correctIndexes.length;
  const results = correctIndexes.map((c, i) => answers[i] === c);
  const correct = results.filter(Boolean).length;
  if (total === 0) return { correct: 0, total: 0, score: 0, passed: false, results: [] };
  return {
    correct,
    total,
    // 浮動小数の誤差を避けるため整数だけで四捨五入する（ちょうど .5 は切り上げ。23/40 = 57.5% → 58）
    score: Math.floor((200 * correct + total) / (2 * total)),
    passed: correct * 100 >= PASSING_PERCENT * total,
    results,
  };
}

// ───────────── 受験記録の集計 ─────────────

export type AttemptRow = { score: number; passed: boolean; createdAt: Date };

export type AttemptStats = {
  attemptCount: number;
  /** 最高点。未受験は null */
  bestScore: number | null;
  /** 1 回でも合格していれば true、受験して合格がなければ false、未受験は null */
  passed: boolean | null;
  /** 最後に受けた日時（ISO 文字列）。未受験は null */
  lastAttemptAt: string | null;
};

/**
 * 受験記録をまとめる。渡されたものをすべて数える（他人の記録を除くのは route の where userId の役目）。
 * 合否は記録の passed をそのまま使う（四捨五入後の点数からは判定しない）
 */
export function summarizeAttempts(rows: ReadonlyArray<AttemptRow>): AttemptStats {
  if (rows.length === 0) return { attemptCount: 0, bestScore: null, passed: null, lastAttemptAt: null };
  let best = -Infinity;
  let last = -Infinity;
  let passed = false;
  for (const r of rows) {
    if (r.score > best) best = r.score;
    const t = r.createdAt.getTime();
    if (t > last) last = t;
    if (r.passed) passed = true;
  }
  return {
    attemptCount: rows.length,
    bestScore: best,
    passed,
    lastAttemptAt: Number.isFinite(last) ? new Date(last).toISOString() : null,
  };
}

// ───────────── GET /api/quizzes の集計 ─────────────

export type QuizType = "MINI" | "FINAL";

export type QuizCourseInput = {
  id: string;
  name: string;
  order: number;
  icon: string;
  color: string;
  sections: ReadonlyArray<{ lessons: ReadonlyArray<{ id: string }> }>;
};

export type QuizInput = {
  id: string;
  title: string;
  type: QuizType;
  courseId: string | null;
  lessonId: string | null;
  lesson: {
    id: string;
    title: string;
    order: number;
    section: { id: string; order: number; courseId: string };
  } | null;
  /** 受験できるかの確認だけに使う（応答には件数だけを出し、選択肢・正解は出さない） */
  questions: ReadonlyArray<AnswerKeyRow>;
};

export type QuizAttemptInput = AttemptRow & { quizId: string };

export type QuizSummary = {
  id: string;
  title: string;
  type: QuizType;
  lessonId: string | null;
  lessonTitle: string | null;
  questionCount: number;
} & AttemptStats;

export type QuizCourse = {
  id: string;
  name: string;
  order: number;
  icon: string;
  color: string;
  locked: boolean;
  finalQuizzes: QuizSummary[];
  miniQuizzes: QuizSummary[];
};

function countLessons(course: QuizCourseInput, completedLessonIds: ReadonlySet<string>): LessonCounts {
  let totalLessons = 0;
  let completedLessons = 0;
  for (const s of course.sections) {
    for (const l of s.lessons) {
      totalLessons++;
      if (completedLessonIds.has(l.id)) completedLessons++;
    }
  }
  return { completedLessons, totalLessons };
}

/**
 * GET /api/quizzes の courses。
 * - courses は表示順（route が [order, id] で並べる）。ロックは course-lock の isCourseLocked と同じ規則で、
 *   クイズのないコースも含めた全コースの並びで前のコースを見る
 * - 修了テスト（FINAL）は quiz.courseId のコースへ、ミニテスト（MINI）は lesson.section.courseId のコースへ振り分ける
 * - 受験できないクイズ（問題が 0 件、options が壊れている、correctIndex が選択肢の範囲外の問題を 1 つでも含む。
 *   toAnswerKey が null）と、振り分け先のコースがないクイズは除く。クイズが 1 件もないコースは返さない
 * - 修了テストはタイトル順（同じなら id 順）、ミニテストはセクション順・レッスン順（同じなら id 順）、同じレッスンならタイトル・id 順
 * - attempts は渡されたものをすべて数える（route が自分の分だけを読む）
 */
export function buildQuizCourses(
  courses: ReadonlyArray<QuizCourseInput>,
  completedLessonIds: ReadonlySet<string>,
  quizzes: ReadonlyArray<QuizInput>,
  attempts: ReadonlyArray<QuizAttemptInput>
): QuizCourse[] {
  const attemptsByQuiz = new Map<string, AttemptRow[]>();
  for (const a of attempts) {
    const list = attemptsByQuiz.get(a.quizId);
    if (list) list.push(a);
    else attemptsByQuiz.set(a.quizId, [a]);
  }

  const finals = new Map<string, QuizInput[]>();
  const minis = new Map<string, QuizInput[]>();
  for (const q of quizzes) {
    if (!toAnswerKey(q.questions)) continue;
    let courseId: string | null = null;
    let target: Map<string, QuizInput[]> | null = null;
    if (q.type === "FINAL") {
      courseId = q.courseId;
      target = finals;
    } else if (q.type === "MINI") {
      courseId = q.lesson?.section.courseId ?? null;
      target = minis;
    }
    if (courseId === null || target === null) continue;
    const list = target.get(courseId);
    if (list) list.push(q);
    else target.set(courseId, [q]);
  }

  const toSummary = (q: QuizInput): QuizSummary => ({
    id: q.id,
    title: q.title,
    type: q.type,
    lessonId: q.type === "MINI" ? q.lesson?.id ?? null : null,
    lessonTitle: q.type === "MINI" ? q.lesson?.title ?? null : null,
    questionCount: q.questions.length,
    ...summarizeAttempts(attemptsByQuiz.get(q.id) ?? []),
  });

  const byTitleThenId = (a: QuizInput, b: QuizInput) =>
    a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const byLessonOrder = (a: QuizInput, b: QuizInput) => {
    // MINI は lesson がある（ないものは振り分けの時点で除いている）
    const la = a.lesson!;
    const lb = b.lesson!;
    return byOrderThenId(la.section, lb.section) || byOrderThenId(la, lb) || byTitleThenId(a, b);
  };

  const out: QuizCourse[] = [];
  let prev: LessonCounts | null = null;
  for (const c of courses) {
    const counts = countLessons(c, completedLessonIds);
    const locked = isCourseLocked(prev, counts);
    prev = counts;
    const finalQuizzes = [...(finals.get(c.id) ?? [])].sort(byTitleThenId).map(toSummary);
    const miniQuizzes = [...(minis.get(c.id) ?? [])].sort(byLessonOrder).map(toSummary);
    if (finalQuizzes.length === 0 && miniQuizzes.length === 0) continue;
    out.push({ id: c.id, name: c.name, order: c.order, icon: c.icon, color: c.color, locked, finalQuizzes, miniQuizzes });
  }
  return out;
}

// ───────────── 画面側の変換 ─────────────

export type QuizStatus = "passed" | "failed" | "untaken";

export type QuizItem = {
  id: string;
  title: string;
  lessonTitle: string | null;
  questionCount: number;
  attemptCount: number;
  bestScore: number | null;
  status: QuizStatus;
  statusLabel: string;
};

export type QuizCourseItem = {
  id: string;
  name: string;
  icon: string;
  color: string;
  locked: boolean;
  finalQuizzes: QuizItem[];
  miniQuizzes: QuizItem[];
};

const STATUS_LABELS: Readonly<Record<QuizStatus, string>> = {
  passed: "合格",
  failed: "不合格",
  untaken: "未受験",
};

/** 合格／不合格／未受験。受験回数が 0（または不明）なら未受験 */
export function quizStatus(q: { attemptCount?: unknown; passed?: unknown }): QuizStatus {
  if (!isNonNegativeInt(q.attemptCount) || q.attemptCount === 0) return "untaken";
  return q.passed === true ? "passed" : "failed";
}

export function quizStatusLabel(status: QuizStatus): string {
  return STATUS_LABELS[status];
}

function isScore(value: unknown): value is number {
  return isNonNegativeInt(value) && value <= 100;
}

function toQuizItems(rows: unknown, seen: Set<string>): QuizItem[] {
  if (!Array.isArray(rows)) return [];
  const out: QuizItem[] = [];
  for (const r of rows) {
    if (!isPlainObject(r)) continue;
    if (typeof r.id !== "string" || r.id === "" || seen.has(r.id)) continue;
    if (typeof r.title !== "string") continue;
    seen.add(r.id);
    const status = quizStatus(r);
    out.push({
      id: r.id,
      title: r.title,
      lessonTitle: typeof r.lessonTitle === "string" ? r.lessonTitle : null,
      questionCount: isNonNegativeInt(r.questionCount) ? r.questionCount : 0,
      attemptCount: isNonNegativeInt(r.attemptCount) ? r.attemptCount : 0,
      bestScore: status !== "untaken" && isScore(r.bestScore) ? r.bestScore : null,
      status,
      statusLabel: quizStatusLabel(status),
    });
  }
  return out;
}

/**
 * GET /api/quizzes の応答を画面の行にする。壊れた応答（courses が配列でないなど）は空。
 * id か name / title が文字列でない要素、空の id、重複した id（コース・クイズそれぞれ。最初の 1 件を残す）は飛ばす。
 * locked は true のときだけロック。クイズが 1 件も残らないコースは出さない。順序は API のまま
 */
export function toQuizCourseItems(data: unknown): QuizCourseItem[] {
  if (!isPlainObject(data) || !Array.isArray(data.courses)) return [];
  const seenCourses = new Set<string>();
  const seenQuizzes = new Set<string>();
  const out: QuizCourseItem[] = [];
  for (const c of data.courses) {
    if (!isPlainObject(c)) continue;
    if (typeof c.id !== "string" || c.id === "" || seenCourses.has(c.id)) continue;
    if (typeof c.name !== "string") continue;
    seenCourses.add(c.id);
    const finalQuizzes = toQuizItems(c.finalQuizzes, seenQuizzes);
    const miniQuizzes = toQuizItems(c.miniQuizzes, seenQuizzes);
    if (finalQuizzes.length === 0 && miniQuizzes.length === 0) continue;
    out.push({
      id: c.id,
      name: c.name,
      icon: typeof c.icon === "string" ? c.icon : "",
      color: typeof c.color === "string" ? c.color : "",
      locked: c.locked === true,
      finalQuizzes,
      miniQuizzes,
    });
  }
  return out;
}

export type QuizTakeView = { id: string; title: string; questions: QuestionView[] };

/**
 * GET /api/quizzes/[quizId] の応答を受験画面用にする。
 * id・title が文字列でない、問題が 0 件、1 問でも id・question・options が壊れていれば null（受験できない）
 */
export function toQuizTakeView(data: unknown): QuizTakeView | null {
  if (!isPlainObject(data)) return null;
  if (typeof data.id !== "string" || data.id === "" || typeof data.title !== "string") return null;
  if (!Array.isArray(data.questions) || data.questions.length === 0) return null;
  const questions: QuestionView[] = [];
  const seen = new Set<string>();
  for (const q of data.questions) {
    if (!isPlainObject(q)) return null;
    if (typeof q.id !== "string" || q.id === "" || seen.has(q.id)) return null;
    if (typeof q.question !== "string") return null;
    const options = normalizeOptions(q.options);
    if (!options) return null;
    seen.add(q.id);
    questions.push({ id: q.id, question: q.question, options });
  }
  return { id: data.id, title: data.title, questions };
}

export type QuizResultView = { score: number; passed: boolean; total: number; correct: number; results: boolean[] };

/**
 * submit の応答を結果画面用にする（画面では採点しない。サーバーの値をそのまま使う）。
 * 項目の型が違う、total が問題数と違う、results の長さが total と違う、correct が範囲外なら null
 */
export function toQuizResultView(data: unknown, questionCount: number): QuizResultView | null {
  if (!isPlainObject(data)) return null;
  const { score, passed, total, correct, results } = data;
  if (!isScore(score) || typeof passed !== "boolean") return null;
  if (!isNonNegativeInt(total) || total === 0 || total !== questionCount) return null;
  if (!isNonNegativeInt(correct) || correct > total) return null;
  if (!Array.isArray(results) || results.length !== total || !results.every((r) => typeof r === "boolean")) return null;
  return { score, passed, total, correct, results: [...results] };
}

/** 受験画面の回答（未回答は null）から submit の body を作る。未回答が残っていれば null */
export function buildSubmitBody(answers: ReadonlyArray<number | null>): { answers: number[] } | null {
  if (answers.length === 0) return null;
  const out: number[] = [];
  for (const a of answers) {
    if (!isNonNegativeInt(a)) return null;
    out.push(a);
  }
  return { answers: out };
}

/** 結果の見出し（絵文字は使わない） */
export function quizResultTitle(passed: boolean): string {
  return passed ? "合格です" : "不合格です";
}
