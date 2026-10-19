import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { deriveQuizKeys, optionPermutation } from "../../src/lib/quiz-shuffle";
import { QUIZ_RATE_LIMITS } from "../../src/lib/quiz-rate-limit";

// #51 PR 2（受験の公開）：本番の route（QUIZ_ATTEMPTS_ENABLED は true のまま）を通しで確かめる。
// 一覧 → 問題を開く（シャッフルされた選択肢とトークン）→ 送信 → 結果 → 一覧の最高点の更新 → もう一度受ける。
// route は now を受け取らず実際の時刻（new Date()）で間隔・回数を判定するので、
// node:test の mock.timers で Date だけを決まった時刻に固定し、tick で進める（setTimeout などは差し替えない）。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物。NextAuth は installFakeAuth で差し替える。
// 鍵はダミーの AUTH_SECRET から作る（本物の値は使わない）。データはすべてダミー。

const DUMMY_AUTH_SECRET = "dummy-auth-secret-for-quiz-flow-tests";
const KEYS = deriveQuizKeys(DUMMY_AUTH_SECRET);
const BASE = Date.parse("2026-10-07T12:00:00.000Z");
const MINI = QUIZ_RATE_LIMITS.MINI;
const FINAL = QUIZ_RATE_LIMITS.FINAL;

type Row = Record<string, unknown>;
type Select = Record<string, unknown>;
type Call = { method: string; args: Row };

const STUDENT = STUDENT_SESSION!.user.id as string;

let session: FakeSession;
let calls: Call[];
let db: { courses: Row[]; sections: Row[]; lessons: Row[]; progress: Row[]; quizzes: Row[]; questions: Row[]; attempts: Row[] };

let LIST: () => Promise<Response>;
let GET_ONE: (req: Request, ctx: { params: Promise<{ quizId: string }> }) => Promise<Response>;
let SUBMIT: (req: Request, ctx: { params: Promise<{ quizId: string }> }) => Promise<Response>;
let ATTEMPTS_ENABLED: boolean;

// ───────────── 偽 prisma（where は値の一致と createdAt の gt、select は入れ子のリレーションまで） ─────────────

type Relation = { model: string; many: boolean; rows: (parent: Row) => Row[] };

const RELATIONS: Record<string, Record<string, Relation>> = {
  course: { sections: { model: "section", many: true, rows: (c) => db.sections.filter((s) => s.courseId === c.id) } },
  section: { lessons: { model: "lesson", many: true, rows: (s) => db.lessons.filter((l) => l.sectionId === s.id) } },
  lesson: { section: { model: "section", many: false, rows: (l) => db.sections.filter((s) => s.id === l.sectionId) } },
  quiz: {
    lesson: { model: "lesson", many: false, rows: (q) => db.lessons.filter((l) => l.id === q.lessonId) },
    questions: { model: "question", many: true, rows: (q) => db.questions.filter((x) => x.quizId === q.id) },
  },
  question: {},
  attempt: {},
  progress: {},
};

function matchWhere(row: Row, where: unknown): boolean {
  if (!where) return true;
  return Object.entries(where as Row).every(([k, v]) => {
    if (typeof v === "object" && v !== null) {
      const keys = Object.keys(v);
      const gt = (v as { gt?: unknown }).gt;
      if (keys.length !== 1 || !(gt instanceof Date) || !(row[k] instanceof Date)) throw new Error(`fake prisma: unsupported where ${k}`);
      return (row[k] as Date).getTime() > gt.getTime();
    }
    return row[k] === v;
  });
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, "asc" | "desc">>;
  return [...rows].sort((a, b) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0];
      const av = a[k] instanceof Date ? (a[k] as Date).getTime() : (a[k] as string | number);
      const bv = b[k] instanceof Date ? (b[k] as Date).getTime() : (b[k] as string | number);
      if (av === bv) continue;
      const cmp = av < bv ? -1 : 1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

function project(model: string, row: Row, select: Select | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    const rel = RELATIONS[model]?.[k];
    if (rel) {
      const spec = (v === true ? {} : v) as { where?: unknown; orderBy?: unknown; select?: Select };
      const rows = sortRows(rel.rows(row).filter((r) => matchWhere(r, spec.where)), spec.orderBy);
      out[k] = rel.many ? rows.map((r) => project(rel.model, r, spec.select)) : rows[0] ? project(rel.model, rows[0], spec.select) : null;
      continue;
    }
    if (v !== true) throw new Error(`fake prisma: unsupported select ${model}.${k}`);
    out[k] = row[k];
  }
  return out;
}

function findMany(model: string, method: string, rows: () => Row[]) {
  return async (args: Row = {}) => {
    calls.push({ method, args });
    const hit = sortRows(rows().filter((r) => matchWhere(r, args.where)), args.orderBy);
    const taken = typeof args.take === "number" ? hit.slice(0, args.take) : hit;
    return taken.map((r) => project(model, r, args.select as Select | undefined));
  };
}

const fakePrisma = {
  course: { findMany: findMany("course", "course.findMany", () => db.courses) },
  progress: { findMany: findMany("progress", "progress.findMany", () => db.progress) },
  quiz: {
    findMany: findMany("quiz", "quiz.findMany", () => db.quizzes),
    async findUnique(args: Row) {
      calls.push({ method: "quiz.findUnique", args });
      const q = db.quizzes.find((x) => x.id === (args.where as { id: string }).id);
      return q ? project("quiz", q, args.select as Select | undefined) : null;
    },
  },
  quizAttempt: {
    findMany: findMany("attempt", "quizAttempt.findMany", () => db.attempts),
    async create(args: Row) {
      calls.push({ method: "quizAttempt.create", args });
      // createdAt は（固定した）いまの時刻。id は作った順に大きくなる
      const row: Row = { id: `att_${String(db.attempts.length).padStart(3, "0")}`, createdAt: new Date(), ...(args.data as Row) };
      db.attempts.push(row);
      return project("attempt", row, args.select as Select | undefined);
    },
  },
};

before(async () => {
  process.env.AUTH_SECRET = DUMMY_AUTH_SECRET;
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ GET: LIST } = await import("../../src/app/api/quizzes/route"));
  ({ GET: GET_ONE } = await import("../../src/app/api/quizzes/[quizId]/route"));
  ({ POST: SUBMIT } = await import("../../src/app/api/quizzes/[quizId]/submit/route"));
  ({ QUIZ_ATTEMPTS_ENABLED: ATTEMPTS_ENABLED } = await import("../../src/lib/student-quizzes"));
});

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: BASE });
  session = STUDENT_SESSION;
  calls = [];
  db = {
    courses: [
      { id: "c1", name: "STEP1 ダミー", order: 1, icon: "it", color: "#6366F1" },
      { id: "c2", name: "STEP2 ダミー", order: 2, icon: "html", color: "#EF4444" },
    ],
    sections: [
      { id: "s1", courseId: "c1", title: "S1", order: 1 },
      { id: "s2", courseId: "c2", title: "S2", order: 1 },
    ],
    lessons: [
      { id: "l1", sectionId: "s1", title: "ダミーレッスン1", order: 1 },
      { id: "l2", sectionId: "s2", title: "ダミーレッスン2", order: 1 },
    ],
    progress: [],
    quizzes: [
      { id: "mini1", title: "ダミーミニ", type: "MINI", courseId: null, lessonId: "l1" },
      { id: "fin1", title: "ダミー修了", type: "FINAL", courseId: "c1", lessonId: null },
    ],
    questions: [
      // 並べ替えが見えるよう選択肢は 4 つ。正解の文には「正」を付ける（テストが表示位置から正解を探すため）
      { id: "q1", quizId: "mini1", question: "ダミー問1", options: ["正A", "誤B", "誤C", "誤D"], correctIndex: 0, order: 1 },
      { id: "q2", quizId: "mini1", question: "ダミー問2", options: ["誤E", "誤F", "正G", "誤H"], correctIndex: 2, order: 2 },
      { id: "f1", quizId: "fin1", question: "ダミー修了問", options: ["誤I", "正J", "誤K"], correctIndex: 1, order: 1 },
    ],
    attempts: [],
  };
});

afterEach(() => {
  mock.timers.reset();
});

const ctx = (quizId: string) => ({ params: Promise.resolve({ quizId }) });
const listRoute = async () => {
  const res = await LIST();
  assert.equal(res.status, 200);
  return (await res.json()) as { courses: Array<Row & { miniQuizzes: Row[]; finalQuizzes: Row[] }> };
};
const listItem = async (quizId: string) => {
  const { courses } = await listRoute();
  const hit = courses.flatMap((c) => [...c.miniQuizzes, ...c.finalQuizzes]).find((q) => q.id === quizId);
  assert.ok(hit, `一覧に ${quizId} がない`);
  return hit;
};
type TakeView = { questions: Array<{ id: string; question: string; options: string[] }>; attemptToken: string; retryAfterSeconds: number | null } & Row;
const open = async (quizId: string) => {
  const res = await GET_ONE(new Request(`https://nwa-lms.example.com/api/quizzes/${quizId}`), ctx(quizId));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  return (await res.json()) as TakeView;
};
/** 画面と同じ body（表示位置の answers・questionIds・attemptToken）で route に送る */
const send = (quizId: string, view: TakeView, displayed: number[]) =>
  SUBMIT(
    new Request(`https://nwa-lms.example.com/api/quizzes/${quizId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: displayed, questionIds: view.questions.map((q) => q.id), attemptToken: view.attemptToken }),
    }),
    ctx(quizId)
  );
/** 表示された選択肢から、正解（「正」で始まる文）または不正解の表示位置を選ぶ */
const pick = (view: TakeView, correct: boolean[]) =>
  view.questions.map((q, i) => q.options.findIndex((o) => o.startsWith("正") === correct[i]));
const originalOptions = (questionId: string) => db.questions.find((q) => q.id === questionId)!.options as string[];
const creates = () => calls.filter((c) => c.method === "quizAttempt.create");

describe("前提", () => {
  it("本番の QUIZ_ATTEMPTS_ENABLED は true（このファイルは route を差し替えずに通す）", () => {
    assert.equal(ATTEMPTS_ENABLED, true);
  });

  it("Date は固定した時刻（route の new Date() もこの時刻を使う）", () => {
    assert.equal(Date.now(), BASE);
    assert.equal(new Date().getTime(), BASE);
  });
});

describe("受験の通しの流れ（route、受講生、MINI）", () => {
  it("一覧 → 開く → シャッフルされた選択肢 → 送信 → 結果 → 最高点の更新 → 待つ → もう一度受ける", async () => {
    // 1. 一覧：未受験
    let item = await listItem("mini1");
    assert.equal(item.attemptCount, 0);
    assert.equal(item.bestScore, null);
    assert.equal(item.passed, null);

    // 2. 開く：選択肢はトークンの nonce で並べ替えられ、正解・元の位置は返らない
    const v1 = await open("mini1");
    assert.equal(v1.retryAfterSeconds, null);
    assert.ok(!JSON.stringify(v1).includes("correctIndex"), "応答に correctIndex が含まれる");
    const nonce1 = v1.attemptToken.split(".")[1];
    assert.match(v1.attemptToken, /^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    for (const q of v1.questions) {
      const orig = originalOptions(q.id);
      const perm = optionPermutation(KEYS.shuffleKey, { userId: STUDENT, quizId: "mini1", questionId: q.id, nonce: nonce1, n: orig.length });
      assert.deepEqual(q.options, perm.map((p) => orig[p]), `${q.id} の並びがトークンの nonce の並べ替えと違う`);
      assert.deepEqual([...q.options].sort(), [...orig].sort(), `${q.id} の選択肢の中身が変わった`);
    }

    // 3. 送信（1 問目だけ正解）→ 結果は 50 点・不合格。記録は元の位置で保存される
    const first = await send("mini1", v1, pick(v1, [true, false]));
    assert.equal(first.status, 200);
    const r1 = await first.json();
    assert.deepEqual(
      { score: r1.score, passed: r1.passed, total: r1.total, correct: r1.correct, results: r1.results, duplicate: r1.duplicate },
      { score: 50, passed: false, total: 2, correct: 1, results: [true, false], duplicate: false }
    );
    assert.equal(creates().length, 1, "1 回目の受験を記録していない");
    const saved1 = creates()[0].args.data as Row;
    assert.equal(saved1.userId, STUDENT);
    const ans1 = saved1.answers as number[];
    assert.equal(ans1[0], 0, "1 問目は元の位置（正解 0）で保存されていない");
    assert.notEqual(ans1[1], 2, "2 問目は不正解を選んだのに元の正解の位置で保存された");
    assert.ok(!(originalOptions("q2")[ans1[1]] ?? "").startsWith("正"), "2 問目の保存値が元の位置に戻っていない");

    // 4. 一覧：受験 1 回・最高 50 点・不合格
    item = await listItem("mini1");
    assert.deepEqual([item.attemptCount, item.bestScore, item.passed], [1, 50, false]);

    // 5. すぐ開き直すと、送れるまでの秒数を知らせる。別の回答をすぐ送ると 429（記録しない）
    mock.timers.tick(1_000);
    const vWait = await open("mini1");
    assert.equal(vWait.retryAfterSeconds, (MINI.intervalMs - 1_000) / 1000);
    assert.notEqual(vWait.attemptToken, v1.attemptToken, "開き直してもトークンが同じ");
    const limited = await send("mini1", vWait, pick(vWait, [true, true]));
    assert.equal(limited.status, 429);
    const lj = await limited.json();
    assert.equal(lj.reason, "rate_limited");
    assert.equal(limited.headers.get("Retry-After"), String(lj.retryAfterSeconds));
    assert.ok(!("score" in lj), "429 に点数が入っている");
    assert.equal(creates().length, 1, "429 なのに記録した");

    // 6. 間隔を過ぎてから「もう一度受ける」：新しいトークンで全問正解 → 100 点・合格
    mock.timers.tick(MINI.intervalMs);
    const v2 = await open("mini1");
    assert.equal(v2.retryAfterSeconds, null);
    const second = await send("mini1", v2, pick(v2, [true, true]));
    assert.equal(second.status, 200);
    const r2 = await second.json();
    assert.deepEqual([r2.score, r2.passed, r2.correct, r2.duplicate], [100, true, 2, false]);
    assert.equal(creates().length, 2, "2 回目の受験を記録していない");
    assert.deepEqual((creates()[1].args.data as Row).answers, [0, 2], "全問正解が元の位置（[0, 2]）で保存されていない");

    // 7. 一覧：受験 2 回・最高 100 点・合格
    item = await listItem("mini1");
    assert.deepEqual([item.attemptCount, item.bestScore, item.passed], [2, 100, true]);
  });

  it("結果が届かずに同じ body を再送すると 200 duplicate: true で、記録は増えず、最高点も変わらない", async () => {
    const v = await open("mini1");
    const displayed = pick(v, [true, true]);
    assert.equal((await send("mini1", v, displayed)).status, 200);
    mock.timers.tick(5_000);
    const again = await send("mini1", v, displayed);
    assert.equal(again.status, 200);
    const j = await again.json();
    assert.deepEqual([j.score, j.duplicate], [100, true]);
    assert.equal(creates().length, 1, "再送で記録が増えた");
    const item = await listItem("mini1");
    assert.deepEqual([item.attemptCount, item.bestScore], [1, 100]);
  });

  it("開くたびにトークンが変わり、前に開いたトークン（期限なし）でも、その並びの表示位置で送れば正しく採点される", async () => {
    const v1 = await open("mini1");
    mock.timers.tick(10 * 60_000);
    const v2 = await open("mini1");
    assert.notEqual(v1.attemptToken, v2.attemptToken, "開き直してもトークンが同じ");
    // v1 のトークンと v1 の並びで全問正解を送る（v2 の並びは使わない）
    const res = await send("mini1", v1, pick(v1, [true, true]));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).score, 100);
    assert.deepEqual((creates()[0].args.data as Row).answers, [0, 2], "元の位置に戻っていない");
  });
});

describe("route の時刻の判定（固定した Date で確かめる。観点 1）", () => {
  it("FINAL：直前の受験から 30 分の内側は 429、30 分を過ぎたら 200（route は new Date() で判定する）", async () => {
    db.attempts.push({ id: "att_prev", userId: STUDENT, quizId: "fin1", score: 0, passed: false, answers: [0], createdAt: new Date(BASE - 60_000) });
    const v = await open("fin1");
    assert.equal(v.retryAfterSeconds, (FINAL.intervalMs - 60_000) / 1000);
    const limited = await send("fin1", v, pick(v, [true]));
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).retryAfterSeconds, (FINAL.intervalMs - 60_000) / 1000);
    mock.timers.tick(FINAL.intervalMs - 60_000);
    // ちょうど間隔の時刻（前回 + 30 分）で送れる
    const ok = await send("fin1", v, pick(v, [true]));
    assert.equal(ok.status, 200);
    assert.equal(creates().length, 1, "間隔を過ぎたのに記録していない");
  });

  it("24 時間より前の記録は数えない（固定した時刻からの相対で判定される）", async () => {
    for (let i = 0; i < FINAL.dailyLimit; i++) {
      db.attempts.push({ id: `att_old_${i}`, userId: STUDENT, quizId: "fin1", score: 0, passed: false, answers: [0], createdAt: new Date(BASE - 24 * 3600_000 - (i + 1) * 60_000) });
    }
    const v = await open("fin1");
    assert.equal(v.retryAfterSeconds, null);
    assert.equal((await send("fin1", v, pick(v, [true]))).status, 200);
  });

  it("講師は上限を受けない（route がセッションの role を渡す）", async () => {
    session = INSTRUCTOR_SESSION;
    const inst = INSTRUCTOR_SESSION!.user.id as string;
    db.attempts.push({ id: "att_inst", userId: inst, quizId: "fin1", score: 0, passed: false, answers: [0], createdAt: new Date(BASE - 1_000) });
    const v = await open("fin1");
    assert.equal(v.retryAfterSeconds, null);
    const res = await send("fin1", v, pick(v, [true]));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).duplicate, false);
  });
});
