import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { isCourseLocked, type LessonCounts } from "../../src/lib/course-lock";
import { pickActiveCourse } from "../../src/lib/student-dashboard";

// #78 PR A のテスト担当による追加。コースのロックの判定がサーバーの 1 か所（course-gate.ts / lesson-access の loadCourseGates）に
// まとまったあとも、ロックが関わるすべての API の結果が、同じデータで main の規則（course-lock の isCourseLocked）と完全に一致することを
// 乱数の構成（シード固定）で照合する。
//   一覧系：GET /api/courses・/api/dashboard・/api/quizzes・/api/comments
//   確認系：GET /api/courses/[courseId]・POST /api/progress・GET /api/comments/[lessonId]・POST /api/comments・
//           GET /api/quizzes/[quizId]・POST /api/quizzes/[quizId]/submit
// あわせて、講師の扱い、Next Up と「学習を続ける」、/api/dashboard の応答の項目（許可リスト）、DB の読み込みの回数（N+1 がない）、
// 読み込みの間に足された（ロックの判定が知らない）コースの扱いを確かめる。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の偽物（リレーション・where・orderBy・select / include を再現する。
// orderBy のない一覧は DB では順序の保証がないので、毎回シャッフルして返す）。NextAuth は installFakeAuth で差し替える。
// 鍵はダミーの AUTH_SECRET から作る（本物の値は使わない）。データはすべてダミー（メールは example.com）。

type Row = Record<string, unknown>;
type Call = { method: string; args: Row };

const STUDENT = (STUDENT_SESSION as { user: { id: string } }).user.id;
const INSTRUCTOR = (INSTRUCTOR_SESSION as { user: { id: string } }).user.id;
const OTHER = "stu_other_78";
const DUMMY_AUTH_SECRET = "dummy-auth-secret-for-course-gate-tests";
const ITERATIONS = 120;

// ───────────── 乱数（シード固定） ─────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand: () => number = mulberry32(1);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
function shuffle<T>(xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ───────────── データ ─────────────

type Db = {
  users: Row[];
  courses: Row[];
  sections: Row[];
  lessons: Row[];
  progress: Row[];
  quizzes: Row[];
  questions: Row[];
  attempts: Row[];
  comments: Row[];
  notifications: Row[];
};
let db: Db;
let session: FakeSession = STUDENT_SESSION;
let calls: Call[] = [];
/** 設定すると、ロックの判定の course.findMany（select が id と sections だけ）からこの id のコースを除く（読み込みの間に足されたコース） */
let hiddenFromGates: string | null = null;

const cmp = (a: unknown, b: unknown) => {
  const av = a instanceof Date ? a.getTime() : (a as string | number);
  const bv = b instanceof Date ? b.getTime() : (b as string | number);
  return av < bv ? -1 : av > bv ? 1 : 0;
};

type Rel = { model: string; many: boolean; rows: (parent: Row) => Row[] };
const REL: Record<string, Record<string, Rel>> = {
  course: { sections: { model: "section", many: true, rows: (c) => db.sections.filter((s) => s.courseId === c.id) } },
  section: {
    lessons: { model: "lesson", many: true, rows: (s) => db.lessons.filter((l) => l.sectionId === s.id) },
    course: { model: "course", many: false, rows: (s) => db.courses.filter((c) => c.id === s.courseId) },
  },
  lesson: { section: { model: "section", many: false, rows: (l) => db.sections.filter((s) => s.id === l.sectionId) } },
  quiz: {
    lesson: { model: "lesson", many: false, rows: (q) => db.lessons.filter((l) => l.id === q.lessonId) },
    questions: { model: "question", many: true, rows: (q) => db.questions.filter((x) => x.quizId === q.id) },
  },
  progress: { lesson: { model: "lesson", many: false, rows: (p) => db.lessons.filter((l) => l.id === p.lessonId) } },
  comment: {
    user: { model: "user", many: false, rows: (c) => db.users.filter((u) => u.id === c.userId) },
    lesson: { model: "lesson", many: false, rows: (c) => db.lessons.filter((l) => l.id === c.lessonId) },
    replies: { model: "comment", many: true, rows: (c) => db.comments.filter((r) => r.parentId === c.id) },
  },
};

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond as Row).every(([op, v]) => {
      if (op === "not") return v === null ? actual !== null && actual !== undefined : actual !== v;
      if (op === "in") return (v as unknown[]).includes(actual);
      if (op === "gt") return cmp(actual, v) > 0;
      if (op === "lt") return cmp(actual, v) < 0;
      throw new Error(`fake prisma: unsupported operator ${op}`);
    });
  }
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  return actual === cond;
}

function matches(model: string, row: Row, where: unknown): boolean {
  if (!where) return true;
  return Object.entries(where as Row).every(([k, v]) => {
    if (k === "AND") return (v as unknown[]).every((w) => matches(model, row, w));
    if (k === "OR") return (v as unknown[]).some((w) => matches(model, row, w));
    const rel = REL[model]?.[k];
    if (rel) {
      const rows = rel.rows(row);
      if (rel.many) {
        const some = (v as { some?: unknown }).some;
        if (some === undefined) throw new Error(`fake prisma: unsupported relation filter ${model}.${k}`);
        return rows.some((r) => matches(rel.model, r, some));
      }
      return rows.length > 0 && matches(rel.model, rows[0], v);
    }
    return matchValue(row[k], v);
  });
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (orderBy === undefined) return shuffle(rows); // 順序の保証なし
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
  return [...rows].sort((a, b) => {
    for (const o of keys) {
      const [field, dir] = Object.entries(o)[0];
      const c = cmp(a[field], b[field]);
      if (c !== 0) return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

type Spec = { select?: Row; include?: Row; where?: unknown; orderBy?: unknown; take?: number };

function project(model: string, row: Row, args: Spec | undefined): Row {
  const out: Row = {};
  const select = args?.select;
  const include = args?.include;
  if (!select) for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? new Date(v) : v;
  for (const [k, v] of Object.entries(select ?? include ?? {})) {
    if (!v) continue;
    const rel = REL[model]?.[k];
    if (!rel) {
      if (v !== true) throw new Error(`fake prisma: unsupported select ${model}.${k}`);
      out[k] = row[k];
      continue;
    }
    const spec = (v === true ? {} : v) as Spec;
    let rows = sortRows(rel.rows(row).filter((r) => matches(rel.model, r, spec.where)), spec.orderBy);
    if (typeof spec.take === "number") rows = rows.slice(0, spec.take);
    const shaped = rows.map((r) => project(rel.model, r, spec));
    out[k] = rel.many ? shaped : (shaped[0] ?? null);
  }
  return out;
}

function table(model: string): Row[] {
  const t: Record<string, Row[]> = {
    user: db.users,
    course: db.courses,
    section: db.sections,
    lesson: db.lessons,
    progress: db.progress,
    quiz: db.quizzes,
    question: db.questions,
    quizAttempt: db.attempts,
    comment: db.comments,
    notification: db.notifications,
  };
  return t[model];
}

/** ロックの判定（loadCourseGates）の読み込みか（コースの id とレッスンの id だけを読む） */
const isGateCourseRead = (args: Spec) =>
  JSON.stringify(args?.select) === JSON.stringify({ id: true, sections: { select: { lessons: { select: { id: true } } } } });

function model(name: string, relModel = name) {
  return {
    async findMany(args: Spec = {}) {
      calls.push({ method: `${name}.findMany`, args: args as Row });
      let rows = table(name).filter((r) => matches(relModel, r, args.where));
      if (name === "course" && hiddenFromGates && isGateCourseRead(args)) rows = rows.filter((r) => r.id !== hiddenFromGates);
      rows = sortRows(rows, args.orderBy);
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      return rows.map((r) => project(relModel, r, args));
    },
    async findUnique(args: Spec & { where: { id: string } }) {
      calls.push({ method: `${name}.findUnique`, args: args as Row });
      const row = table(name).find((r) => r.id === args.where.id);
      return row ? project(relModel, row, args) : null;
    },
    async count(args: Spec = {}) {
      calls.push({ method: `${name}.count`, args: args as Row });
      return table(name).filter((r) => matches(relModel, r, args.where)).length;
    },
  };
}

let created = 0;
const fakePrisma = {
  user: model("user"),
  course: model("course"),
  lesson: model("lesson"),
  progress: {
    ...model("progress"),
    async upsert(args: { where: { userId_lessonId: { userId: string; lessonId: string } } }) {
      calls.push({ method: "progress.upsert", args: args as unknown as Row });
      const { userId, lessonId } = args.where.userId_lessonId;
      const now = new Date();
      const hit = db.progress.find((p) => p.userId === userId && p.lessonId === lessonId);
      if (hit) Object.assign(hit, { completed: true, completedAt: now });
      else db.progress.push({ id: `p_new_${created++}`, userId, lessonId, completed: true, completedAt: now });
      return { id: "p_dummy", userId, lessonId, completed: true, completedAt: now };
    },
  },
  quiz: model("quiz"),
  quizAttempt: {
    ...model("quizAttempt", "attempt"),
    async create(args: { data: Row; select?: Row }) {
      calls.push({ method: "quizAttempt.create", args: args as unknown as Row });
      const row: Row = { id: `att_${created++}`, createdAt: new Date(), ...args.data };
      db.attempts.push(row);
      return project("attempt", row, args);
    },
  },
  comment: {
    ...model("comment"),
    async create(args: { data: Row; select?: Row }) {
      calls.push({ method: "comment.create", args: args as unknown as Row });
      const row: Row = { id: `cm_new_${created++}`, createdAt: new Date(), ...args.data };
      db.comments.push(row);
      return project("comment", row, args);
    },
  },
  notification: model("notification"),
};

// ───────────── 乱数の構成 ─────────────

type Scenario = "zero_prev" | "same_order" | "started_here" | "all_done" | "others_only" | "mixed";
const SCENARIOS: Scenario[] = ["zero_prev", "same_order", "started_here", "all_done", "others_only", "mixed"];

/** 正解の並び（[order, id]）のコースと、そのレッスンの id（セクション・レッスンも [order, id]） */
function orderedCourses(): Array<{ id: string; name: string; lessons: string[] }> {
  const byOrderThenId = (a: Row, b: Row) => (a.order as number) - (b.order as number) || cmp(a.id, b.id);
  return [...db.courses].sort(byOrderThenId).map((c) => ({
    id: c.id as string,
    name: c.name as string,
    lessons: db.sections
      .filter((s) => s.courseId === c.id)
      .sort(byOrderThenId)
      .flatMap((s) => db.lessons.filter((l) => l.sectionId === s.id).sort(byOrderThenId).map((l) => l.id as string)),
  }));
}

function generate(scenario: Scenario) {
  db = { users: [], courses: [], sections: [], lessons: [], progress: [], quizzes: [], questions: [], attempts: [], comments: [], notifications: [] };
  db.users.push(
    { id: STUDENT, name: "ダミー受講生", email: "stu-78@example.com", role: "STUDENT", deactivatedAt: null },
    { id: OTHER, name: "ダミー他人", email: "other-78@example.com", role: "STUDENT", deactivatedAt: null },
    { id: INSTRUCTOR, name: "ダミー講師", email: "ins-78@example.com", role: "INSTRUCTOR", deactivatedAt: null }
  );
  const nCourses = int(2, 6);
  for (let ci = 0; ci < nCourses; ci++) {
    const courseId = `c${String.fromCharCode(97 + int(0, 25))}${ci}`;
    // same_order：全コースが同じ order（id で並ぶ）。それ以外も 1〜3 なので同じ order がよくできる
    db.courses.push({ id: courseId, name: `STEP${ci + 1} ダミー${ci}`, description: null, icon: "it", color: "#123456", order: scenario === "same_order" ? 1 : int(1, 3) });
    // zero_prev：レッスン 0 件のコースを多めに作る（空のセクションだけのコースも）
    const nSections = scenario === "zero_prev" && rand() < 0.4 ? 0 : int(0, 2);
    for (let si = 0; si < nSections; si++) {
      const sectionId = `${courseId}_s${si}`;
      db.sections.push({ id: sectionId, courseId, title: `S${si}`, order: int(1, 2) });
      const nLessons = scenario === "zero_prev" && rand() < 0.3 ? 0 : int(1, 3);
      for (let li = 0; li < nLessons; li++) {
        const id = `${sectionId}_l${li}`;
        db.lessons.push({
          id,
          sectionId,
          title: `ダミー${id}`,
          type: "VIDEO",
          order: int(1, 2),
          duration: "10:00",
          videoUrl: `https://example.com/SECRET_${id}_video`,
          content: `SECRET_${id}_content`,
          pdfUrl: null,
        });
      }
    }
  }
  const ordered = orderedCourses();

  const complete = (userId: string, lessonIds: Iterable<string>) => {
    for (const lessonId of Array.from(lessonIds)) {
      if (db.progress.some((p) => p.userId === userId && p.lessonId === lessonId)) continue;
      db.progress.push({ id: `p${db.progress.length}`, userId, lessonId, completed: true, completedAt: new Date(Date.UTC(2026, 9, 1 + int(0, 18))) });
    }
  };
  const all = ordered.flatMap((c) => c.lessons);

  // 受講生本人
  if (scenario === "all_done") complete(STUDENT, all);
  else if (scenario === "started_here") {
    // 前のコースは途中、このコースに完了 1 件（開始済みは維持）
    const withLessons = ordered.map((c, i) => [c, i] as const).filter(([c]) => c.lessons.length > 0);
    if (withLessons.length >= 2) {
      const k = int(1, withLessons.length - 1);
      const [prev] = withLessons[k - 1];
      const [cur] = withLessons[k];
      if (prev.lessons.length > 1) complete(STUDENT, prev.lessons.slice(0, int(1, prev.lessons.length - 1)));
      complete(STUDENT, [cur.lessons[int(0, cur.lessons.length - 1)]]);
    }
  } else if (scenario !== "others_only") {
    const k = int(0, ordered.length);
    for (let i = 0; i < k; i++) complete(STUDENT, ordered[i].lessons);
    if (k < ordered.length) complete(STUDENT, ordered[k].lessons.filter(() => rand() < 0.5));
    if (scenario === "mixed") complete(STUDENT, all.filter(() => rand() < 0.2));
  }
  // 完了でない行（completed: false）も置く（数えない）
  for (const l of all.filter(() => rand() < 0.1)) {
    if (!db.progress.some((p) => p.userId === STUDENT && p.lessonId === l)) {
      db.progress.push({ id: `p${db.progress.length}`, userId: STUDENT, lessonId: l, completed: false, completedAt: null });
    }
  }
  // 他人は（ほぼ）全部終えている。受講生のロックに影響してはいけない
  complete(OTHER, all.filter(() => rand() < (scenario === "others_only" ? 1 : 0.7)));
  // 講師の自分の完了（/api/quizzes は講師も自分の完了で計算する）
  complete(INSTRUCTOR, all.filter(() => rand() < 0.4));

  // クイズ：各コースに受験できる修了テスト、レッスンのあるコースには 1 件目のレッスンにミニテスト
  for (const c of ordered) {
    const fin = `fin_${c.id}`;
    db.quizzes.push({ id: fin, title: "修了テスト", type: "FINAL", courseId: c.id, lessonId: null });
    db.questions.push({ id: `${fin}_q1`, quizId: fin, question: "ダミー問", options: ["ダミーA", "ダミーB", "ダミーC"], correctIndex: 1, order: 1 });
    if (c.lessons.length > 0) {
      const mini = `mini_${c.id}`;
      db.quizzes.push({ id: mini, title: "ミニテスト", type: "MINI", courseId: null, lessonId: c.lessons[0] });
      db.questions.push({ id: `${mini}_q1`, quizId: mini, question: "ダミー問", options: ["ダミーA", "ダミーB"], correctIndex: 0, order: 1 });
    }
  }
  // 質問：レッスンのある各コースに、他人の質問と自分の質問を 1 件ずつ（合計 12 件以下。1 ページ 20 件に収まる）
  let t = 0;
  for (const c of ordered) {
    if (c.lessons.length === 0) continue;
    for (const userId of [OTHER, STUDENT]) {
      db.comments.push({ id: `cm_${userId}_${c.id}`, userId, lessonId: c.lessons[0], parentId: null, content: `ダミー質問 ${c.id}`, createdAt: new Date(Date.UTC(2020, 0, 1, 0, t++)) });
    }
  }
  db.notifications.push({ id: "n1", userId: STUDENT, title: "お知らせ", message: "本文", read: false, createdAt: new Date(Date.UTC(2026, 9, 1)) });
}

// ───────────── 正解（main の規則。ルートのコードを使わない） ─────────────

function doneOf(userId: string): Set<string> {
  return new Set(db.progress.filter((p) => p.userId === userId && p.completed === true).map((p) => p.lessonId as string));
}

function countsOf(lessons: string[], done: Set<string>): LessonCounts {
  return { totalLessons: lessons.length, completedLessons: lessons.filter((l) => done.has(l)).length };
}

/** main の isCourseLocked を、[order, id] の並びで前のコースと比べて呼ぶ（main の画面・question-threads と同じ使い方） */
function mainLocks(userId: string): boolean[] {
  const done = doneOf(userId);
  let prev: LessonCounts | null = null;
  return orderedCourses().map((c) => {
    const counts = countsOf(c.lessons, done);
    const locked = isCourseLocked(prev, counts);
    prev = counts;
    return locked;
  });
}

/** main の「学習を続ける」と Next Up のコース（ロックを見ない）：受講中 → 最初の未完了 → 最初のコース */
function mainActiveIndex(userId: string): number | null {
  const done = doneOf(userId);
  const counts = orderedCourses().map((c) => countsOf(c.lessons, done));
  const inProgress = counts.findIndex((c) => c.completedLessons > 0 && c.completedLessons < c.totalLessons);
  if (inProgress >= 0) return inProgress;
  const unfinished = counts.findIndex((c) => c.completedLessons < c.totalLessons);
  if (unfinished >= 0) return unfinished;
  return counts.length > 0 ? 0 : null;
}

// ───────────── ルート ─────────────

type Handler<A extends unknown[]> = (...args: A) => Promise<Response>;
let R: {
  courses: Handler<[]>;
  courseDetail: Handler<[string]>;
  dashboard: Handler<[]>;
  quizzes: Handler<[]>;
  comments: Handler<[]>;
  postComment: Handler<[string]>;
  lessonComments: Handler<[string]>;
  progress: Handler<[string]>;
  quiz: Handler<[string]>;
  submit: Handler<[string, Row]>;
};

let savedSecret: string | undefined;
before(async () => {
  savedSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = DUMMY_AUTH_SECRET;
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  const courses = await import("../../src/app/api/courses/route");
  const courseDetail = await import("../../src/app/api/courses/[courseId]/route");
  const dashboard = await import("../../src/app/api/dashboard/route");
  const quizzes = await import("../../src/app/api/quizzes/route");
  const comments = await import("../../src/app/api/comments/route");
  const lessonComments = await import("../../src/app/api/comments/[lessonId]/route");
  const progress = await import("../../src/app/api/progress/route");
  const quiz = await import("../../src/app/api/quizzes/[quizId]/route");
  const submit = await import("../../src/app/api/quizzes/[quizId]/submit/route");
  const jsonReq = (url: string, body: unknown) =>
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  R = {
    courses: () => courses.GET(),
    courseDetail: (id) => courseDetail.GET(new Request(`http://localhost/api/courses/${id}`), { params: Promise.resolve({ courseId: id }) }),
    dashboard: () => dashboard.GET(),
    quizzes: () => quizzes.GET(),
    comments: () => comments.GET(new Request("http://localhost/api/comments")),
    postComment: (lessonId) => comments.POST(jsonReq("http://localhost/api/comments", { lessonId, content: `ダミーの質問 ${created++}` })),
    lessonComments: (id) => lessonComments.GET(new Request(`http://localhost/api/comments/${id}`), { params: Promise.resolve({ lessonId: id }) }),
    progress: (lessonId) => progress.POST(jsonReq("http://localhost/api/progress", { lessonId })),
    quiz: (id) => quiz.GET(new Request(`http://localhost/api/quizzes/${id}`), { params: Promise.resolve({ quizId: id }) }),
    submit: (id, body) => submit.POST(jsonReq(`http://localhost/api/quizzes/${id}/submit`, body), { params: Promise.resolve({ quizId: id }) }),
  };
});

after(() => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
});

async function json<T>(res: Promise<Response>, label: string, status = 200): Promise<T> {
  const r = await res;
  assert.equal(r.status, status, `${label} が ${status} を返さない（status ${r.status}）`);
  return (await r.json()) as T;
}

/** 書き込みのある API を呼ぶ間だけ使い、データを元に戻す（ロックの状態を変えないため） */
async function withRestore<T>(fn: () => Promise<T>): Promise<T> {
  const snapshot = { progress: db.progress.map((r) => ({ ...r })), comments: [...db.comments], attempts: [...db.attempts] };
  try {
    return await fn();
  } finally {
    db.progress = snapshot.progress;
    db.comments = snapshot.comments;
    db.attempts = snapshot.attempts;
  }
}

type TakeView = { questions: Array<{ id: string; options: string[] }>; attemptToken: string };
const submitBody = (view: TakeView) => ({ answers: view.questions.map(() => 0), questionIds: view.questions.map((q) => q.id), attemptToken: view.attemptToken });

/** 講師で問題を開き、形の正しいトークンを得る（ロック中のコースの submit が、形の確認を通ってロックの確認まで届くようにする） */
async function instructorView(quizId: string): Promise<TakeView> {
  const saved = session;
  session = INSTRUCTOR_SESSION;
  try {
    return await json<TakeView>(R.quiz(quizId), `講師の GET /api/quizzes/${quizId}`);
  } finally {
    session = saved;
  }
}

const LOCKED_BODY = { error: "Forbidden", reason: "course_locked" };

// ───────────── 1. 受講生：全 API のロックの結果が main と一致する ─────────────

describe("受講生：ロックが関わる全 API の結果が、同じデータで main の isCourseLocked と完全に一致する（#78 PR A）", () => {
  it(`${ITERATIONS} 通りの構成（レッスン 0 件のコースの次・同じ order・前は途中でこのコースに完了 1 件・全部完了・他人の完了だけ）で照合する`, async () => {
    const seen = { locked: 0, unlocked: 0, zeroPrevLocked: 0, startedHere: 0, allDone: 0, othersOnly: 0, sameOrder: 0, miniLocked: 0 };
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      rand = mulberry32(7800 + seed);
      const scenario = SCENARIOS[seed % SCENARIOS.length];
      generate(scenario);
      session = STUDENT_SESSION;
      const ctx = `seed ${seed}（${scenario}）`;
      const ordered = orderedCourses();
      const ids = ordered.map((c) => c.id);
      const expected = mainLocks(STUDENT);
      const lockedOf = (courseId: string) => expected[ids.indexOf(courseId)];

      // 照合が空振りしていないことの記録
      const done = doneOf(STUDENT);
      expected.forEach((l, i) => {
        if (l) seen.locked++;
        else seen.unlocked++;
        if (l && i > 0 && ordered[i - 1].lessons.length === 0) seen.zeroPrevLocked++;
        const prev = i > 0 ? countsOf(ordered[i - 1].lessons, done) : null;
        if (!l && prev && prev.completedLessons < prev.totalLessons && countsOf(ordered[i].lessons, done).completedLessons > 0) seen.startedHere++;
      });
      if (scenario === "all_done") seen.allDone++;
      if (scenario === "others_only") seen.othersOnly++;
      if (scenario === "same_order") seen.sameOrder++;

      // 一覧系
      const list = await json<Array<{ id: string; locked: unknown }>>(R.courses(), `${ctx} /api/courses`);
      assert.deepEqual(list.map((c) => [c.id, c.locked]), ids.map((id, i) => [id, expected[i]]), `${ctx}: /api/courses の locked が main と違う`);

      const dash = await json<{ courses: Array<{ id: string; locked: unknown }> }>(R.dashboard(), `${ctx} /api/dashboard`);
      assert.deepEqual(dash.courses.map((c) => [c.id, c.locked]), ids.map((id, i) => [id, expected[i]]), `${ctx}: /api/dashboard の locked が main と違う`);

      const quizzes = await json<{ courses: Array<{ id: string; locked: unknown }> }>(R.quizzes(), `${ctx} /api/quizzes`);
      assert.deepEqual(quizzes.courses.map((c) => [c.id, c.locked]), ids.map((id, i) => [id, expected[i]]), `${ctx}: /api/quizzes の locked が main と違う`);

      // 質問の一覧：他人の質問はロック中のコースのものを除き、自分の質問は常に出る
      const threads = await json<{ threads: Array<{ id: string; course: { id: string } }> }>(R.comments(), `${ctx} GET /api/comments`);
      const expectedThreads = db.comments
        .filter((c) => c.parentId === null)
        .filter((c) => {
          const courseId = ordered.find((o) => o.lessons.includes(c.lessonId as string))!.id;
          return c.userId === STUDENT || !lockedOf(courseId);
        })
        .map((c) => c.id)
        .sort();
      assert.deepEqual(threads.threads.map((t) => t.id).sort(), expectedThreads, `${ctx}: GET /api/comments の質問が main のロックと違う`);

      // 確認系（コース単位）
      for (let i = 0; i < ordered.length; i++) {
        const c = ordered[i];
        const label = `${ctx} コース ${c.id}（main: ${expected[i] ? "ロック" : "解放"}）`;
        const detail = await R.courseDetail(c.id);
        assert.equal(detail.status, expected[i] ? 403 : 200, `${label}: GET /api/courses/[courseId] の status`);
        if (expected[i]) assert.deepEqual(await detail.json(), LOCKED_BODY, `${label}: 403 の本文`);

        // 修了テスト（quiz.courseId のコース）
        const fin = `fin_${c.id}`;
        const quiz = await R.quiz(fin);
        assert.equal(quiz.status, expected[i] ? 403 : 200, `${label}: GET /api/quizzes/${fin} の status`);
        if (expected[i]) {
          assert.deepEqual(await quiz.json(), LOCKED_BODY, `${label}: 403 の本文`);
          const view = await instructorView(fin);
          const sub = await withRestore(() => R.submit(fin, submitBody(view)));
          assert.equal(sub.status, 403, `${label}: ロック中の submit が 403 でない`);
          assert.deepEqual(await sub.json(), LOCKED_BODY, `${label}: submit の 403 の本文`);
        } else {
          const view = (await quiz.json()) as TakeView;
          const sub = await withRestore(() => R.submit(fin, submitBody(view)));
          assert.equal(sub.status, 200, `${label}: 解放済みの submit が 200 でない（status ${sub.status}）`);
        }

        if (c.lessons.length === 0) continue;
        // ミニテスト（レッスンのコース）
        const mini = `mini_${c.id}`;
        const miniRes = await R.quiz(mini);
        assert.equal(miniRes.status, expected[i] ? 403 : 200, `${label}: GET /api/quizzes/${mini} の status`);
        if (expected[i]) {
          seen.miniLocked++;
          const view = await instructorView(mini);
          const sub = await withRestore(() => R.submit(mini, submitBody(view)));
          assert.equal(sub.status, 403, `${label}: ロック中のミニテストの submit が 403 でない`);
        }

        // 確認系（レッスン単位）。どのレッスンでも同じ結果
        for (const lessonId of c.lessons) {
          const lc = await R.lessonComments(lessonId);
          assert.equal(lc.status, expected[i] ? 403 : 200, `${label}: GET /api/comments/${lessonId} の status`);
          const pr = await withRestore(() => R.progress(lessonId));
          assert.equal(pr.status, expected[i] ? 403 : 200, `${label}: POST /api/progress ${lessonId} の status`);
        }
        const pc = await withRestore(() => R.postComment(c.lessons[0]));
        assert.equal(pc.status, expected[i] ? 403 : 201, `${label}: POST /api/comments の status`);
        if (expected[i]) assert.deepEqual(await pc.json(), LOCKED_BODY, `${label}: POST /api/comments の 403 の本文`);
      }
    }
    assert.ok(seen.locked > 50 && seen.unlocked > 50, `ロック・解放の両方を十分に照合できていない: ${JSON.stringify(seen)}`);
    assert.ok(seen.zeroPrevLocked > 5, `レッスン 0 件のコースの次（ロック）を照合できていない: ${JSON.stringify(seen)}`);
    assert.ok(seen.startedHere > 5, `前は途中でこのコースに完了 1 件（解放）を照合できていない: ${JSON.stringify(seen)}`);
    assert.ok(seen.allDone > 5 && seen.othersOnly > 5 && seen.sameOrder > 5, `構成の種類が足りない: ${JSON.stringify(seen)}`);
    assert.ok(seen.miniLocked > 5, `ロック中のミニテストを照合できていない: ${JSON.stringify(seen)}`);
  });

  it("他人の完了は受講生のロックに影響しない（他人が全部終えていても、本人が未着手なら 2 つ目以降はロック）", async () => {
    rand = mulberry32(78);
    generate("others_only");
    session = STUDENT_SESSION;
    const ordered = orderedCourses();
    const list = await json<Array<{ locked: boolean }>>(R.courses(), "/api/courses");
    assert.deepEqual(list.map((c) => c.locked), ordered.map((_, i) => i > 0), "他人の完了でロックが外れている");
    const dash = await json<{ courses: Array<{ locked: boolean }> }>(R.dashboard(), "/api/dashboard");
    assert.deepEqual(dash.courses.map((c) => c.locked), ordered.map((_, i) => i > 0), "他人の完了でダッシュボードのロックが外れている");
  });
});

// ───────────── 2. 講師 ─────────────

describe("講師：courses / dashboard は常に locked: false、quizzes は講師自身の完了で main と同じ計算、確認系は通す", () => {
  it(`${ITERATIONS} 通りの構成で照合する`, async () => {
    let quizLockedSeen = 0;
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      rand = mulberry32(17800 + seed);
      const scenario = SCENARIOS[seed % SCENARIOS.length];
      generate(scenario);
      session = INSTRUCTOR_SESSION;
      const ctx = `seed ${seed}（${scenario}）`;
      const ordered = orderedCourses();
      const ids = ordered.map((c) => c.id);

      const list = await json<Array<{ id: string; locked: unknown }>>(R.courses(), `${ctx} /api/courses`);
      assert.deepEqual(list.map((c) => [c.id, c.locked]), ids.map((id) => [id, false]), `${ctx}: 講師の /api/courses に locked: true がある`);
      // 講師にはレッスンの中身を隠さない（main と同じ）
      for (const c of list as unknown as Array<{ sections: Array<{ lessons: Row[] }> }>) {
        for (const l of c.sections.flatMap((s) => s.lessons)) assert.ok("videoUrl" in l, `${ctx}: 講師の /api/courses でレッスンの中身が隠れている`);
      }

      const dash = await json<{ courses: Array<{ id: string; locked: unknown }>; nextLessons: Array<{ courseId: string }> }>(R.dashboard(), `${ctx} /api/dashboard`);
      assert.deepEqual(dash.courses.map((c) => [c.id, c.locked]), ids.map((id) => [id, false]), `${ctx}: 講師の /api/dashboard に locked: true がある`);
      // 講師の Next Up は main と同じ（ロックを見ない）
      const mainIdx = mainActiveIndex(INSTRUCTOR);
      if (dash.nextLessons.length > 0) assert.equal(dash.nextLessons[0].courseId, ids[mainIdx!], `${ctx}: 講師の Next Up のコースが main と違う`);

      // /api/quizzes はロールを見ず、講師も自分の完了で計算する（main と同じ）
      const expected = mainLocks(INSTRUCTOR);
      quizLockedSeen += expected.filter(Boolean).length;
      const quizzes = await json<{ courses: Array<{ id: string; locked: unknown }> }>(R.quizzes(), `${ctx} /api/quizzes`);
      assert.deepEqual(quizzes.courses.map((c) => [c.id, c.locked]), ids.map((id, i) => [id, expected[i]]), `${ctx}: 講師の /api/quizzes の locked が main と違う`);

      // 確認系はロックを見ない
      for (const c of ordered) {
        assert.equal((await R.courseDetail(c.id)).status, 200, `${ctx}: 講師の GET /api/courses/${c.id}`);
        assert.equal((await R.quiz(`fin_${c.id}`)).status, 200, `${ctx}: 講師の GET /api/quizzes/fin_${c.id}`);
        for (const lessonId of c.lessons) {
          assert.equal((await R.lessonComments(lessonId)).status, 200, `${ctx}: 講師の GET /api/comments/${lessonId}`);
          assert.equal((await withRestore(() => R.progress(lessonId))).status, 200, `${ctx}: 講師の POST /api/progress ${lessonId}`);
        }
      }
      // 質問の一覧は全件（ロックの絞り込みなし）
      const threads = await json<{ threads: unknown[] }>(R.comments(), `${ctx} GET /api/comments`);
      assert.equal(threads.threads.length, db.comments.length, `${ctx}: 講師の質問一覧が絞り込まれている`);
    }
    assert.ok(quizLockedSeen > 20, `講師の /api/quizzes でロック中のコースを照合できていない: ${quizLockedSeen}`);
  });
});

// ───────────── 3. Next Up と「学習を続ける」 ─────────────

describe("Next Up と「学習を続ける」：ロック中のコースを指さず、それ以外の場面では main と同じ", () => {
  it(`${ITERATIONS} 通りの構成で照合する`, async () => {
    let sameAsMain = 0;
    let skipped = 0;
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      rand = mulberry32(27800 + seed);
      const scenario = SCENARIOS[seed % SCENARIOS.length];
      generate(scenario);
      session = STUDENT_SESSION;
      const ctx = `seed ${seed}（${scenario}）`;
      const ordered = orderedCourses();
      const ids = ordered.map((c) => c.id);
      const locks = mainLocks(STUDENT);
      const done = doneOf(STUDENT);

      type DashCourse = { id: string; progress: number; totalLessons: number; completedLessons: number; locked: boolean };
      const dash = await json<{ courses: DashCourse[]; nextLessons: Array<{ lessonId: string; courseId: string }> }>(R.dashboard(), `${ctx} /api/dashboard`);

      // 画面の「学習を続ける」と同じ組み立て（page.tsx の StudentDashboard の courses）
      const pageCourses = dash.courses.map((c) => ({ ...c, locked: c.locked === true }));
      const active = pickActiveCourse(pageCourses);
      if (active) assert.equal(active.locked, false, `${ctx}: 「学習を続ける」がロック中のコース ${active.id} を指している`);
      for (const l of dash.nextLessons) {
        assert.equal(locks[ids.indexOf(l.courseId)], false, `${ctx}: Next Up がロック中のコース ${l.courseId} を指している`);
      }
      // Next Up と「学習を続ける」は同じコース
      if (dash.nextLessons.length > 0) assert.equal(dash.nextLessons[0].courseId, active?.id, `${ctx}: Next Up と「学習を続ける」のコースが違う`);

      const mainIdx = mainActiveIndex(STUDENT);
      if (mainIdx === null) {
        assert.equal(active, null, `${ctx}: コースがないのに「学習を続ける」がある`);
        continue;
      }
      if (!locks[mainIdx]) {
        // main の選んだコースが開いていれば、結果は main と同じ
        sameAsMain++;
        assert.equal(active?.id, ids[mainIdx], `${ctx}: 「学習を続ける」が main と違う`);
        const expectedNext = ordered[mainIdx].lessons.filter((l) => !done.has(l)).slice(0, 3);
        assert.deepEqual(dash.nextLessons.map((l) => l.lessonId), expectedNext, `${ctx}: Next Up が main と違う`);
      } else {
        // main ではロック中のコースを指していた場面（意図した変化）：開いているコースの中で、受講中 → 最初の未完了 → 最初のコース
        skipped++;
        const open = ordered.map((c, i) => ({ c, i, n: countsOf(c.lessons, done) })).filter((x) => !locks[x.i]);
        const pick =
          open.find((x) => x.n.completedLessons > 0 && x.n.completedLessons < x.n.totalLessons) ??
          open.find((x) => x.n.completedLessons < x.n.totalLessons) ??
          open[0];
        assert.equal(active?.id, pick?.c.id, `${ctx}: ロック中を飛ばした「学習を続ける」が正解と違う`);
        const expectedNext = pick ? pick.c.lessons.filter((l) => !done.has(l)).slice(0, 3) : [];
        assert.deepEqual(dash.nextLessons.map((l) => l.lessonId), expectedNext, `${ctx}: ロック中を飛ばした Next Up が正解と違う`);
      }
    }
    assert.ok(sameAsMain > 30, `main と同じになる場面を照合できていない: ${sameAsMain}`);
    assert.ok(skipped > 5, `main ではロック中のコースを指していた場面を照合できていない: ${skipped}`);
  });

  it("レッスン 0 件のコースの直後の未着手のコース（main ではロック中なのに「学習を続ける」が指していた）を飛ばす", async () => {
    db = { users: [], courses: [], sections: [], lessons: [], progress: [], quizzes: [], questions: [], attempts: [], comments: [], notifications: [] };
    db.users.push({ id: STUDENT, name: "ダミー受講生", email: "stu-78@example.com", role: "STUDENT", deactivatedAt: null });
    const addCourse = (id: string, order: number, lessons: string[]) => {
      db.courses.push({ id, name: `ダミー${id}`, description: null, icon: "it", color: "#123456", order });
      if (lessons.length === 0) return;
      db.sections.push({ id: `${id}_s`, courseId: id, title: "S", order: 1 });
      lessons.forEach((l, i) => db.lessons.push({ id: l, sectionId: `${id}_s`, title: `ダミー${l}`, type: "VIDEO", order: i, duration: null, videoUrl: null, content: null, pdfUrl: null }));
    };
    addCourse("c1", 1, ["a1"]);
    addCourse("c2", 2, []); // レッスン 0 件
    addCourse("c3", 3, ["b1", "b2"]);
    db.progress.push({ id: "p1", userId: STUDENT, lessonId: "a1", completed: true, completedAt: new Date(Date.UTC(2026, 9, 1)) });
    session = STUDENT_SESSION;
    // main：c1 は完了、c2 は 0 件（未完了でない）、c3 は未着手 → 「学習を続ける」は c3。しかし c3 は前が 0 件なのでロック中
    assert.equal(mainActiveIndex(STUDENT), 2, "前提：main は c3 を選ぶ");
    assert.deepEqual(mainLocks(STUDENT), [false, false, true], "前提：main で c3 はロック中");
    const dash = await json<{ courses: Array<{ id: string; locked: boolean }>; nextLessons: unknown[] }>(R.dashboard(), "/api/dashboard");
    assert.deepEqual(dash.courses.map((c) => c.locked), [false, false, true], "ダッシュボードの locked");
    assert.deepEqual(dash.nextLessons, [], "Next Up がロック中の c3 のレッスンを出している");
    const active = pickActiveCourse(dash.courses as Array<{ id: string; locked: boolean; completedLessons: number; totalLessons: number }>);
    assert.equal(active?.id, "c1", "「学習を続ける」は開いているコースの最初（全部終えたので c1）");
  });
});

// ───────────── 4. /api/dashboard の応答の項目 ─────────────

describe("GET /api/dashboard：応答の項目は main と同じで、コースに locked が増えただけ（許可リスト）", () => {
  const TOP = ["activeCourses", "completedLast7Days", "completedLessons", "courses", "nextLessons", "notifications", "overallProgress", "recentActivity", "totalLessons", "unreadNotifications"];
  // main のコースの項目（id / name / icon / color / order / progress / totalLessons / completedLessons）＋ locked
  const COURSE = ["color", "completedLessons", "icon", "id", "locked", "name", "order", "progress", "totalLessons"];
  const NEXT = ["courseId", "courseName", "lessonId", "title"];
  const ACTIVITY = ["completedAt", "courseName", "lessonTitle"];
  const NOTIFICATION = ["createdAt", "id", "message", "read", "title"];

  for (const [role, s] of [["受講生", STUDENT_SESSION], ["講師", INSTRUCTOR_SESSION]] as const) {
    it(`${role}：すべての項目が許可リストのとおりで、メールアドレス・userId・他人の情報・レッスンの中身を含まない`, async () => {
      for (let seed = 1; seed <= 30; seed++) {
        rand = mulberry32(37800 + seed);
        generate(SCENARIOS[seed % SCENARIOS.length]);
        session = s;
        const ctx = `${role} seed ${seed}`;
        const text = await (await R.dashboard()).text();
        const body = JSON.parse(text) as Record<string, unknown>;
        assert.deepEqual(Object.keys(body).sort(), TOP, `${ctx}: 最上位の項目が違う`);
        for (const c of body.courses as Row[]) {
          assert.deepEqual(Object.keys(c).sort(), COURSE, `${ctx}: courses の項目が違う`);
          assert.equal(typeof c.locked, "boolean", `${ctx}: locked が boolean でない`);
        }
        for (const n of body.nextLessons as Row[]) assert.deepEqual(Object.keys(n).sort(), NEXT, `${ctx}: nextLessons の項目が違う`);
        for (const a of body.recentActivity as Row[]) assert.deepEqual(Object.keys(a).sort(), ACTIVITY, `${ctx}: recentActivity の項目が違う`);
        for (const n of body.notifications as Row[]) assert.deepEqual(Object.keys(n).sort(), NOTIFICATION, `${ctx}: notifications の項目が違う`);
        assert.doesNotMatch(text, /@example\.com/, `${ctx}: メールアドレスが含まれる`);
        assert.doesNotMatch(text, /userId|sessionVersion|password/, `${ctx}: userId などの項目名が含まれる`);
        for (const u of [STUDENT, OTHER, INSTRUCTOR]) assert.ok(!text.includes(u), `${ctx}: ユーザーの id ${u} が含まれる`);
        assert.doesNotMatch(text, /SECRET_/, `${ctx}: レッスンの中身（videoUrl・content）が含まれる`);
      }
    });
  }
});

// ───────────── 5. DB の読み込みの回数（N+1 がない） ─────────────

describe("DB の読み込み：回数がコース数に依存せず（N+1 がない）、ロックのための読み込みは loadCourseGates の 2 件だけ", () => {
  type Count = Record<string, number>;
  const tally = (): Count => {
    const out: Count = {};
    for (const c of calls) out[c.method] = (out[c.method] ?? 0) + 1;
    return out;
  };

  // 現在の回数。括弧内は main の回数（#78 PR A でロックの判定を loadCourseGates に寄せたため、一覧系は 1〜2 件増えた）
  const EXPECTED: Array<[string, FakeSession, () => Promise<Response>, Count]> = [
    // main：course 1・progress 1 → loadCourseGates の course 1・progress 1 が増えた
    ["受講生 GET /api/courses", STUDENT_SESSION, () => R.courses(), { "course.findMany": 2, "progress.findMany": 2 }],
    ["講師 GET /api/courses", INSTRUCTOR_SESSION, () => R.courses(), { "course.findMany": 1, "progress.findMany": 1 }],
    // main：course 1・progress 2・notification 2 → loadCourseGates の course 1・progress 1 が増えた
    ["受講生 GET /api/dashboard", STUDENT_SESSION, () => R.dashboard(), { "course.findMany": 2, "progress.findMany": 3, "notification.findMany": 1, "notification.count": 1 }],
    ["講師 GET /api/dashboard", INSTRUCTOR_SESSION, () => R.dashboard(), { "course.findMany": 1, "progress.findMany": 2, "notification.findMany": 1, "notification.count": 1 }],
    // main：course 1・progress 1・quiz 1・quizAttempt 1 → course が 1 件増えた（ロールを見ないので講師も同じ）
    ["受講生 GET /api/quizzes", STUDENT_SESSION, () => R.quizzes(), { "course.findMany": 2, "progress.findMany": 1, "quiz.findMany": 1, "quizAttempt.findMany": 1 }],
    ["講師 GET /api/quizzes", INSTRUCTOR_SESSION, () => R.quizzes(), { "course.findMany": 2, "progress.findMany": 1, "quiz.findMany": 1, "quizAttempt.findMany": 1 }],
    // main と同じ
    ["受講生 GET /api/comments", STUDENT_SESSION, () => R.comments(), { "course.findMany": 1, "progress.findMany": 1, "comment.findMany": 1 }],
    ["講師 GET /api/comments", INSTRUCTOR_SESSION, () => R.comments(), { "comment.findMany": 1 }],
  ];

  it("一覧系 API の読み込みの回数（コースが 2〜6 件のどの構成でも同じ）", async () => {
    for (const [label, s, call, expected] of EXPECTED) {
      for (let seed = 1; seed <= 12; seed++) {
        rand = mulberry32(47800 + seed);
        generate(SCENARIOS[seed % SCENARIOS.length]);
        session = s;
        calls = [];
        const res = await call();
        assert.equal(res.status, 200, `${label} seed ${seed}: status ${res.status}`);
        assert.deepEqual(tally(), expected, `${label} seed ${seed}（コース ${db.courses.length} 件）: 読み込みの回数が違う`);
      }
    }
  });

  it("確認系 API（受講生）の読み込みの回数は main と同じ（ロックの判定は course 1・progress 1 の 2 件）", async () => {
    rand = mulberry32(78078);
    generate("mixed");
    session = STUDENT_SESSION;
    const ordered = orderedCourses();
    const locks = mainLocks(STUDENT);
    const open = ordered.find((c, i) => !locks[i] && c.lessons.length > 0)!;
    const locked = ordered.find((c, i) => locks[i] && c.lessons.length > 0);
    assert.ok(open, "前提：開いているレッスンのあるコースがある");
    const cases: Array<[string, () => Promise<Response>, Count]> = [
      ["GET /api/courses/[courseId]（開いている）", () => R.courseDetail(open.id), { "course.findMany": 1, "progress.findMany": 2, "course.findUnique": 1 }],
      ["GET /api/comments/[lessonId]（開いている）", () => R.lessonComments(open.lessons[0]), { "lesson.findUnique": 1, "course.findMany": 1, "progress.findMany": 1, "comment.findMany": 1 }],
      ["GET /api/quizzes/[quizId]（開いている）", () => R.quiz(`fin_${open.id}`), { "quiz.findUnique": 2, "course.findMany": 1, "progress.findMany": 1, "quizAttempt.findMany": 1 }],
    ];
    if (locked) {
      cases.push(
        ["GET /api/courses/[courseId]（ロック中）", () => R.courseDetail(locked.id), { "course.findMany": 1, "progress.findMany": 1 }],
        ["POST /api/progress（ロック中）", () => R.progress(locked.lessons[0]), { "lesson.findUnique": 1, "course.findMany": 1, "progress.findMany": 1 }]
      );
    }
    for (const [label, call, expected] of cases) {
      calls = [];
      const res = await withRestore(call);
      assert.ok(res.status === 200 || res.status === 403, `${label}: status ${res.status}`);
      assert.deepEqual(tally(), expected, `${label}: 読み込みの回数が違う`);
    }
  });

  it("ロックの判定の読み込みは、コースとレッスンの id・自分の完了だけ（他人の進捗やレッスンの中身を読まない）", async () => {
    rand = mulberry32(7);
    generate("mixed");
    session = STUDENT_SESSION;
    for (const call of [() => R.courses(), () => R.dashboard(), () => R.quizzes(), () => R.comments()]) {
      calls = [];
      await call();
      const gateCourse = calls.filter((c) => c.method === "course.findMany" && isGateCourseRead(c.args as Spec));
      assert.equal(gateCourse.length, 1, "ロックの判定のコースの読み込みが 1 件でない");
      assert.deepEqual(gateCourse[0].args.orderBy, [{ order: "asc" }, { id: "asc" }], "ロックの判定のコースが [order, id] で並んでいない");
      for (const p of calls.filter((c) => c.method === "progress.findMany")) {
        assert.equal((p.args.where as { userId?: string }).userId, STUDENT, "自分以外の進捗を読んでいる");
      }
    }
  });
});

// ───────────── 6. 読み込みの間に足されたコース ─────────────

describe("ロックの判定が知らないコース（読み込みの間に足されたもの）はロックとして扱う", () => {
  it("受講生：/api/courses・/api/dashboard・/api/quizzes で locked: true、詳細は 404。Next Up・「学習を続ける」も選ばない", async () => {
    rand = mulberry32(780);
    generate("all_done");
    session = STUDENT_SESSION;
    // 全部終えた受講生に、最後に未着手のコースが足された（判定の読み込みには間に合わなかった）
    db.courses.push({ id: "zz_new", name: "ダミー新コース", description: null, icon: "it", color: "#123456", order: 99 });
    db.sections.push({ id: "zz_new_s", courseId: "zz_new", title: "S", order: 1 });
    db.lessons.push({ id: "zz_new_l", sectionId: "zz_new_s", title: "ダミー新レッスン", type: "VIDEO", order: 1, duration: null, videoUrl: "https://example.com/SECRET_new", content: null, pdfUrl: null });
    db.quizzes.push({ id: "fin_zz_new", title: "修了テスト", type: "FINAL", courseId: "zz_new", lessonId: null });
    db.questions.push({ id: "fin_zz_new_q", quizId: "fin_zz_new", question: "ダミー問", options: ["ダミーA", "ダミーB"], correctIndex: 0, order: 1 });
    hiddenFromGates = "zz_new";
    try {
      const list = await json<Array<{ id: string; locked: boolean; sections: Array<{ lessons: Row[] }> }>>(R.courses(), "/api/courses");
      const added = list.find((c) => c.id === "zz_new")!;
      assert.equal(added.locked, true, "/api/courses で足されたコースがロックでない");
      assert.ok(!JSON.stringify(added).includes("SECRET_"), "足されたコースのレッスンの中身が出ている");
      const dash = await json<{ courses: Array<{ id: string; locked: boolean; completedLessons: number; totalLessons: number }>; nextLessons: Array<{ courseId: string }> }>(R.dashboard(), "/api/dashboard");
      assert.equal(dash.courses.find((c) => c.id === "zz_new")?.locked, true, "/api/dashboard で足されたコースがロックでない");
      assert.ok(dash.nextLessons.every((l) => l.courseId !== "zz_new"), "Next Up が足されたコースを指している");
      assert.notEqual(pickActiveCourse(dash.courses)?.id, "zz_new", "「学習を続ける」が足されたコースを指している");
      const quizzes = await json<{ courses: Array<{ id: string; locked: boolean }> }>(R.quizzes(), "/api/quizzes");
      assert.equal(quizzes.courses.find((c) => c.id === "zz_new")?.locked, true, "/api/quizzes で足されたコースがロックでない");
      // 確認系は判定の読み込みにないコースを not_found（main と同じ）
      assert.equal((await R.courseDetail("zz_new")).status, 404, "詳細が 404 でない");
      assert.equal((await withRestore(() => R.progress("zz_new_l"))).status, 403, "足されたコースのレッスンの完了が 403 でない");
    } finally {
      hiddenFromGates = null;
    }
  });

  it("講師：/api/courses・/api/dashboard では locked: false のまま", async () => {
    rand = mulberry32(781);
    generate("mixed");
    db.courses.push({ id: "zz_new", name: "ダミー新コース", description: null, icon: "it", color: "#123456", order: 99 });
    hiddenFromGates = "zz_new";
    session = INSTRUCTOR_SESSION;
    try {
      const list = await json<Array<{ id: string; locked: boolean }>>(R.courses(), "/api/courses");
      assert.equal(list.find((c) => c.id === "zz_new")?.locked, false, "講師の /api/courses でロックになっている");
      const dash = await json<{ courses: Array<{ id: string; locked: boolean }> }>(R.dashboard(), "/api/dashboard");
      assert.equal(dash.courses.find((c) => c.id === "zz_new")?.locked, false, "講師の /api/dashboard でロックになっている");
    } finally {
      hiddenFromGates = null;
    }
  });
});

// ───────────── 7. 未認証 ─────────────

describe("未認証：ロックが関わる API はすべて 401 で、DB を読まない", () => {
  it("セッションなし・user.id なし", async () => {
    rand = mulberry32(1);
    generate("mixed");
    const c = orderedCourses().find((x) => x.lessons.length > 0)!;
    for (const s of [null, { user: { role: "STUDENT" } }] as FakeSession[]) {
      session = s;
      const all: Array<[string, () => Promise<Response>]> = [
        ["GET /api/courses", () => R.courses()],
        ["GET /api/dashboard", () => R.dashboard()],
        ["GET /api/quizzes", () => R.quizzes()],
        ["GET /api/comments", () => R.comments()],
        ["GET /api/courses/[courseId]", () => R.courseDetail(c.id)],
        ["GET /api/comments/[lessonId]", () => R.lessonComments(c.lessons[0])],
        ["POST /api/comments", () => R.postComment(c.lessons[0])],
        ["POST /api/progress", () => R.progress(c.lessons[0])],
        ["GET /api/quizzes/[quizId]", () => R.quiz(`fin_${c.id}`)],
        ["POST /api/quizzes/[quizId]/submit", () => R.submit(`fin_${c.id}`, { answers: [0], questionIds: ["x"], attemptToken: "x" })],
      ];
      for (const [label, call] of all) {
        calls = [];
        const res = await withRestore(call);
        assert.equal(res.status, 401, `${label}（${JSON.stringify(s)}）が 401 でない`);
        assert.deepEqual(calls, [], `${label}（${JSON.stringify(s)}）で DB を読んでいる`);
      }
    }
  });
});
