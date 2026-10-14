import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { COURSE_ORDER_BY } from "../../src/lib/course-order";
import { isCourseLocked, type LessonCounts } from "../../src/lib/course-lock";

// #47 P4 POST /api/progress のコースのロック（Tec 決定 D-a）。
// ロックの規則は「このコースの完了が 1 件以上あれば解放」なので、ロック中のコースに progress を書くとロックが外れる。
// 受講生のロック中は 403 course_locked で、upsert を呼ばないことを必ず確かめる。
// DB・ネットワークなし。prisma は globalThis.prisma に置く小さな偽物（呼び出しを記録する）。NextAuth は installFakeAuth で差し替える。
// データはすべてダミー。

type Row = Record<string, unknown>;
type Call = { method: string; args: Row };
type Course = { id: string; order: number; lessons: string[] };
type ProgressRow = { userId: string; lessonId: string; completed: boolean };

const STUDENT = (STUDENT_SESSION as { user: { id: string } }).user.id;
const INSTRUCTOR = (INSTRUCTOR_SESSION as { user: { id: string } }).user.id;

let session: FakeSession;
let calls: Call[];
let courses: Course[];
let progress: ProgressRow[];
let failOn: string | null;
let failWith: unknown;

function record(method: string, args: unknown) {
  calls.push({ method, args: (args ?? {}) as Row });
  if (failOn === method) throw failWith;
}

const sortCourses = (cs: Course[]) => [...cs].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const fakePrisma = {
  lesson: {
    async findUnique(args: { where: { id: string }; select: Row }) {
      record("lesson.findUnique", args);
      const c = courses.find((x) => x.lessons.includes(args.where.id));
      if (!c) return null;
      return args.select.section ? { section: { courseId: c.id } } : { id: args.where.id };
    },
  },
  course: {
    async findMany(args: Row) {
      record("course.findMany", args);
      return sortCourses(courses).map((c) => ({ id: c.id, sections: [{ lessons: c.lessons.map((id) => ({ id })) }] }));
    },
  },
  progress: {
    async findMany(args: { where: { userId: string; completed: boolean } }) {
      record("progress.findMany", args);
      return progress.filter((p) => p.userId === args.where.userId && p.completed === args.where.completed).map((p) => ({ lessonId: p.lessonId }));
    },
    async upsert(args: { where: { userId_lessonId: { userId: string; lessonId: string } } }) {
      record("progress.upsert", args);
      const { userId, lessonId } = args.where.userId_lessonId;
      return { id: `p_${userId}_${lessonId}`, userId, lessonId, completed: true, completedAt: new Date("2026-10-14T00:00:00.000Z") };
    },
  },
};

let route: typeof import("../../src/app/api/progress/route");

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  route = await import("../../src/app/api/progress/route");
});

beforeEach(() => {
  session = STUDENT_SESSION;
  calls = [];
  failOn = null;
  failWith = null;
  progress = [];
  courses = [
    { id: "course_a", order: 1, lessons: ["a1", "a2"] },
    { id: "course_b", order: 2, lessons: ["b1", "b2"] },
    { id: "course_c", order: 3, lessons: ["c1"] },
  ];
});

afterEach(() => {
  mock.restoreAll();
});

function post(body: unknown, raw?: string) {
  return route.POST(
    new Request("http://localhost/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    })
  );
}

const upserts = () => calls.filter((c) => c.method === "progress.upsert");
const done = (lessonId: string, userId = STUDENT): ProgressRow => ({ userId, lessonId, completed: true });

describe("POST /api/progress：認証と入力", () => {
  it("未ログインは 401 で、DB を読まない・書かない", async () => {
    for (const s of [null, { user: {} }] as FakeSession[]) {
      session = s;
      calls = [];
      const res = await post({ lessonId: "a1" });
      assert.equal(res.status, 401, `session ${JSON.stringify(s)} で 401 にならない`);
      assert.deepEqual(calls, [], "未ログインで DB に触れている");
    }
  });

  const bad: Array<[string, unknown, string | undefined]> = [
    ["JSON でない", undefined, "{not json"],
    ["body が null", null, undefined],
    ["body が配列", ["a1"], undefined],
    ["lessonId がない", {}, undefined],
    ["lessonId が空文字", { lessonId: "" }, undefined],
    ["lessonId が数値", { lessonId: 1 }, undefined],
    ["lessonId がオブジェクト", { lessonId: { id: "a1" } }, undefined],
    ["lessonId が 65 文字", { lessonId: "x".repeat(65) }, undefined],
  ];
  for (const [label, body, raw] of bad) {
    it(`${label} は 400 で、DB を読まない・書かない`, async () => {
      const res = await post(body, raw);
      assert.equal(res.status, 400, `status ${res.status}`);
      assert.deepEqual(calls, [], "400 の前に DB に触れている");
    });
  }

  it("64 文字の lessonId は検証を通る（存在しないので 404）", async () => {
    const res = await post({ lessonId: "x".repeat(64) });
    assert.equal(res.status, 404, `status ${res.status}`);
  });
});

describe("POST /api/progress：レッスンがない（以前は FK エラーで 500）", () => {
  for (const [label, s] of [
    ["受講生", STUDENT_SESSION],
    ["講師", INSTRUCTOR_SESSION],
  ] as Array<[string, FakeSession]>) {
    it(`${label}：404 で upsert を呼ばない`, async () => {
      session = s;
      const res = await post({ lessonId: "missing" });
      assert.equal(res.status, 404, `status ${res.status}`);
      assert.deepEqual(await res.json(), { error: "Lesson not found" });
      assert.deepEqual(upserts(), [], "存在しないレッスンに upsert している");
    });
  }
});

describe("POST /api/progress：受講生のロック（#47 P4）", () => {
  it("ロック中のコースのレッスンは 403 course_locked で、upsert を呼ばない（ロックを外せない）", async () => {
    progress = [done("a1")];
    for (const lessonId of ["b1", "b2", "c1"]) {
      calls = [];
      const res = await post({ lessonId });
      assert.equal(res.status, 403, `${lessonId} の status ${res.status}`);
      assert.deepEqual(await res.json(), { error: "Forbidden", reason: "course_locked" });
      assert.deepEqual(upserts(), [], `${lessonId}：ロック中のコースに upsert している`);
    }
  });

  it("403 を何度受けても、ロックは外れない（書き込みが 1 件もない）", async () => {
    for (let i = 0; i < 3; i++) assert.equal((await post({ lessonId: "b1" })).status, 403, `${i + 1} 回目が 403 でない`);
    assert.deepEqual(upserts(), [], "upsert が呼ばれた");
  });

  it("最初のコースのレッスンは 200 で、自分の userId に upsert する（body の userId は使わない）", async () => {
    const res = await post({ lessonId: "a1", userId: "stu_other" });
    assert.equal(res.status, 200, `status ${res.status}`);
    assert.equal(res.headers.get("Cache-Control"), "no-cache, no-store");
    const u = upserts();
    assert.equal(u.length, 1, "upsert が 1 回でない");
    assert.deepEqual((u[0].args.where as Row).userId_lessonId, { userId: STUDENT, lessonId: "a1" });
    assert.equal(((await res.json()) as { userId: string }).userId, STUDENT);
  });

  it("前のコースを全部終えれば次のコースは 200、このコースに完了があっても 200", async () => {
    progress = [done("a1"), done("a2")];
    assert.equal((await post({ lessonId: "b1" })).status, 200);
    progress = [done("c1")];
    assert.equal((await post({ lessonId: "c1" })).status, 200);
  });

  it("他の受講生の進捗では解放されない", async () => {
    progress = [done("a1", "stu_other"), done("a2", "stu_other")];
    assert.equal((await post({ lessonId: "b1" })).status, 403);
    assert.deepEqual(upserts(), []);
  });

  it("ロックの判定は COURSE_ORDER_BY で並べたコースと、自分の完了だけで行う", async () => {
    await post({ lessonId: "b1" });
    const course = calls.find((c) => c.method === "course.findMany");
    assert.ok(course, "course.findMany が呼ばれていない");
    assert.equal(course.args.orderBy, COURSE_ORDER_BY, "COURSE_ORDER_BY（同じ参照）で並べていない");
    const prog = calls.find((c) => c.method === "progress.findMany");
    assert.ok(prog, "progress.findMany が呼ばれていない");
    assert.deepEqual(prog.args.where, { userId: STUDENT, completed: true });
  });

  it("ロールのないセッションも受講生と同じくロックを確かめる", async () => {
    session = { user: { id: STUDENT } };
    assert.equal((await post({ lessonId: "b1" })).status, 403);
    assert.deepEqual(upserts(), []);
  });
});

describe("POST /api/progress：講師はロックを見ない", () => {
  it("ロック中のコースでも 200 で、コース・進捗を読まない", async () => {
    session = INSTRUCTOR_SESSION;
    const res = await post({ lessonId: "c1" });
    assert.equal(res.status, 200, `status ${res.status}`);
    assert.deepEqual(calls.map((c) => c.method), ["lesson.findUnique", "progress.upsert"]);
    assert.deepEqual((upserts()[0].args.where as Row).userId_lessonId, { userId: INSTRUCTOR, lessonId: "c1" });
  });
});

describe("POST /api/progress：isCourseLocked との照合（乱数）", () => {
  /** 再現できるよう、シード固定の簡単な乱数（mulberry32） */
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("200 通りの構成で、403 になるのは画面がロック表示するコースのレッスンだけ（そのとき upsert しない）", async () => {
    const rand = rng(47);
    const pick = (n: number) => Math.floor(rand() * n);
    let checked = 0;
    let lockedSeen = 0;
    for (let trial = 0; trial < 200; trial++) {
      courses = Array.from({ length: 1 + pick(4) }, (_, ci) => ({
        id: `t${trial}_course_${String.fromCharCode(97 + pick(26))}${ci}`,
        order: pick(3),
        lessons: Array.from({ length: pick(3) }, (_, li) => `t${trial}_c${ci}_l${li}`),
      }));
      progress = [];
      for (const l of courses.flatMap((c) => c.lessons)) {
        const r = rand();
        if (r < 0.35) progress.push(done(l));
        else if (r < 0.45) progress.push({ userId: STUDENT, lessonId: l, completed: false });
        else if (r < 0.6) progress.push(done(l, "stu_other"));
      }
      const doneSet = new Set(progress.filter((p) => p.userId === STUDENT && p.completed).map((p) => p.lessonId));
      let prev: LessonCounts | null = null;
      for (const c of sortCourses(courses)) {
        const counts = { totalLessons: c.lessons.length, completedLessons: c.lessons.filter((l) => doneSet.has(l)).length };
        const locked = isCourseLocked(prev, counts);
        prev = counts;
        for (const lessonId of c.lessons) {
          calls = [];
          const res = await post({ lessonId });
          const ctx = `trial ${trial} lesson ${lessonId}: ${JSON.stringify({ courses, progress })}`;
          assert.equal(res.status, locked ? 403 : 200, ctx);
          assert.equal(upserts().length, locked ? 0 : 1, `upsert の回数が違う ${ctx}`);
          checked++;
          if (locked) lockedSeen++;
        }
      }
    }
    assert.ok(checked > 200, `照合したレッスンが少ない: ${checked}`);
    assert.ok(lockedSeen > 0 && lockedSeen < checked, `403 と 200 の両方を照合できていない: ${lockedSeen}/${checked}`);
  });
});

describe("POST /api/progress：例外とログ", () => {
  class PrismaClientKnownRequestError extends Error {
    code = "P2003";
    meta = { field_name: "Progress_lessonId_fkey" };
    constructor(message: string) {
      super(message);
      this.name = "PrismaClientKnownRequestError";
    }
  }

  for (const method of ["lesson.findUnique", "course.findMany", "progress.findMany", "progress.upsert"]) {
    it(`${method} の例外は 500 で、ログはエラー名だけ（メッセージ・code・meta を出さない）`, async () => {
      failOn = method;
      failWith = new PrismaClientKnownRequestError(`failed for ${STUDENT} student@example.com`);
      const logged = mock.method(console, "error", () => {});
      const res = await post({ lessonId: "a1" });
      assert.equal(res.status, 500, `status ${res.status}`);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.ok(calls.some((c) => c.method === method), `${method} が呼ばれていない`);
      assert.deepEqual(logged.mock.calls.map((c) => c.arguments), [["POST /api/progress error:", "PrismaClientKnownRequestError"]]);
    });
  }
});

describe("見えない文字", () => {
  it("このファイルのソースに見えない文字・全角空白を直接書いていない", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(__filename, "utf8");
    assert.doesNotMatch(text, new RegExp("[\\u00A0\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u3000\\uFEFF]", "u"));
  });
});
