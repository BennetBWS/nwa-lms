import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #32 GET /api/comments（質問スレッド一覧）と、同じファイルの POST /api/comments の回帰。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物
// （受け取った引数を記録し、このルートが使う where（AND / OR、lesson.section.courseId、replies の some / none、
// createdAt / id の lt）・orderBy・take・select（入れ子の user / lesson / replies）だけを再現する。知らない条件は例外）。
// NextAuth は installFakeAuth で差し替える。データはすべてダミー（example.com）。

type Role = "STUDENT" | "INSTRUCTOR";
type UserRow = { id: string; email: string; name: string; role: Role; avatar: string | null; deactivatedAt: Date | null; password: string };
type CommentRow = { id: string; userId: string; lessonId: string; content: string; parentId: string | null; createdAt: Date };
type LessonRow = { id: string; title: string; courseId: string };
type CourseRow = { id: string; name: string; order: number };
type ProgressRow = { userId: string; lessonId: string; completed: boolean };
type Call = { method: string; args: Record<string, unknown> };
type Select = Record<string, unknown>;
type Where = Record<string, unknown>;

const ME = "stu_active";
const DUMMY_EMAIL = "student@example.com";
const BASE = Date.parse("2026-10-08T12:00:00.000Z");

let session: FakeSession;
let calls: Call[];
let users: UserRow[];
let courses: CourseRow[];
let lessons: LessonRow[];
let progress: ProgressRow[];
let comments: CommentRow[];
let failWith: unknown;
let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;

function sortRows<R extends Record<string, unknown>>(rows: R[], orderBy: unknown): R[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, "asc" | "desc">>;
  return [...rows].sort((a, b) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0];
      const av = a[k];
      const bv = b[k];
      const an = av instanceof Date ? av.getTime() : (av as string | number);
      const bn = bv instanceof Date ? bv.getTime() : (bv as string | number);
      if (an === bn) continue;
      const cmp = an < bn ? -1 : 1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

const lessonOf = (id: string) => {
  const l = lessons.find((x) => x.id === id);
  assert.ok(l, `lesson ${id} がない`);
  return l;
};
const userOf = (id: string) => {
  const u = users.find((x) => x.id === id);
  assert.ok(u, `user ${id} がない`);
  return u;
};

function matchUser(u: UserRow, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "role") return u.role === v;
    throw new Error(`fake prisma: unsupported user condition ${k}`);
  });
}

function matchComment(c: CommentRow, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    switch (k) {
      case "AND":
        return (v as Where[]).every((w) => matchComment(c, w));
      case "OR":
        return (v as Where[]).some((w) => matchComment(c, w));
      case "parentId":
        return v === null ? c.parentId === null : c.parentId === v;
      case "userId":
      case "lessonId":
        assert.equal(typeof v, "string");
        return c[k] === v;
      case "createdAt": {
        if (v instanceof Date) return c.createdAt.getTime() === v.getTime();
        const lt = (v as { lt?: unknown }).lt;
        assert.ok(lt instanceof Date && Object.keys(v as object).length === 1, `createdAt: ${inspect(v)}`);
        return c.createdAt.getTime() < lt.getTime();
      }
      case "id": {
        if (typeof v === "string") return c.id === v;
        const lt = (v as { lt?: unknown }).lt;
        assert.ok(typeof lt === "string" && Object.keys(v as object).length === 1, `id: ${inspect(v)}`);
        return c.id < lt;
      }
      case "lesson": {
        const section = (v as { section?: Where }).section;
        assert.ok(section && Object.keys(v as object).length === 1, `lesson: ${inspect(v)}`);
        assert.deepEqual(Object.keys(section), ["courseId"]);
        const cond = section.courseId;
        const courseId = lessonOf(c.lessonId).courseId;
        if (typeof cond === "string") return courseId === cond;
        const list = (cond as { in?: unknown }).in;
        assert.ok(Array.isArray(list), `courseId: ${inspect(cond)}`);
        return list.includes(courseId);
      }
      case "replies": {
        const spec = v as { some?: Where; none?: Where };
        const children = comments.filter((r) => r.parentId === c.id);
        const hit = (w: Where) =>
          children.some((r) =>
            Object.entries(w).every(([rk, rv]) => {
              if (rk === "user") return matchUser(userOf(r.userId), rv as Where);
              throw new Error(`fake prisma: unsupported replies condition ${rk}`);
            })
          );
        if (spec.some) return hit(spec.some);
        if (spec.none) return !hit(spec.none);
        throw new Error(`fake prisma: unsupported replies ${inspect(v)}`);
      }
      default:
        throw new Error(`fake prisma: unsupported comment condition ${k}`);
    }
  });
}

function pick(obj: Record<string, unknown>, select: Select): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v !== true) throw new Error(`fake prisma: unsupported select ${k}`);
    out[k] = obj[k];
  }
  return out;
}

function projectLesson(l: LessonRow, select: Select): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (k === "section") {
      const courseSelect = ((v as { select: Select }).select.course as { select: Select }).select;
      const course = courses.find((x) => x.id === l.courseId);
      assert.ok(course);
      out.section = { course: pick(course as unknown as Record<string, unknown>, courseSelect) };
      continue;
    }
    if (v !== true) throw new Error(`fake prisma: unsupported lesson select ${k}`);
    out[k] = l[k as keyof LessonRow];
  }
  return out;
}

function projectComment(c: CommentRow, select: Select | undefined): Record<string, unknown> {
  if (!select) return { ...c };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    if (k === "user") {
      out.user = pick(userOf(c.userId) as unknown as Record<string, unknown>, (v as { select: Select }).select);
      continue;
    }
    if (k === "lesson") {
      out.lesson = projectLesson(lessonOf(c.lessonId), (v as { select: Select }).select);
      continue;
    }
    if (k === "replies") {
      const spec = v as { where?: Where; select?: Select; orderBy?: unknown };
      const children = comments.filter((r) => r.parentId === c.id && (!spec.where || matchComment(r, spec.where)));
      const rows = sortRows(children as unknown as Record<string, unknown>[], spec.orderBy) as unknown as CommentRow[];
      out.replies = rows.map((r) => projectComment(r, spec.select));
      continue;
    }
    if (v !== true) throw new Error(`fake prisma: unsupported select ${k}`);
    out[k] = c[k as keyof CommentRow];
  }
  return out;
}

const fakePrisma = {
  comment: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "comment.findMany", args });
      if (failWith !== undefined) throw failWith;
      let rows = comments.filter((r) => matchComment(r, (args.where ?? {}) as Where));
      rows = sortRows(rows as unknown as Record<string, unknown>[], args.orderBy) as unknown as CommentRow[];
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      return rows.map((r) => projectComment(r, args.select as Select | undefined));
    },
    async findUnique(args: Record<string, unknown>) {
      calls.push({ method: "comment.findUnique", args });
      if (failWith !== undefined) throw failWith;
      const id = (args.where as { id: string }).id;
      const c = comments.find((x) => x.id === id);
      return c ? projectComment(c, args.select as Select | undefined) : null;
    },
    async create(args: Record<string, unknown>) {
      calls.push({ method: "comment.create", args });
      if (failWith !== undefined) throw failWith;
      const data = args.data as Omit<CommentRow, "id" | "createdAt">;
      const row: CommentRow = { id: `c_new_${comments.length}`, createdAt: new Date(BASE), ...data };
      comments.push(row);
      return projectComment(row, args.select as Select | undefined);
    },
  },
  lesson: {
    async findUnique(args: Record<string, unknown>) {
      calls.push({ method: "lesson.findUnique", args });
      if (failWith !== undefined) throw failWith;
      const id = (args.where as { id: string }).id;
      return lessons.some((l) => l.id === id) ? { id } : null;
    },
  },
  course: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "course.findMany", args });
      if (failWith !== undefined) throw failWith;
      const rows = sortRows(courses as unknown as Record<string, unknown>[], args.orderBy) as unknown as CourseRow[];
      // select は { id, sections: { select: { lessons: { select: { id } } } } } だけを想定（テストで固定する）
      return rows.map((c) => ({
        id: c.id,
        sections: [{ lessons: lessons.filter((l) => l.courseId === c.id).map((l) => ({ id: l.id })) }],
      }));
    },
  },
  progress: {
    async findMany(args: Record<string, unknown>) {
      calls.push({ method: "progress.findMany", args });
      if (failWith !== undefined) throw failWith;
      const where = args.where as { userId: string; completed: boolean };
      return progress.filter((p) => p.userId === where.userId && p.completed === where.completed).map((p) => ({ lessonId: p.lessonId }));
    },
  },
};

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;
  installFakeAuth(() => session);
  ({ GET, POST } = await import("../../src/app/api/comments/route"));
});

const at = (minutesAgo: number) => new Date(BASE - minutesAgo * 60_000);

beforeEach(() => {
  session = STUDENT_SESSION;
  calls = [];
  failWith = undefined;
  users = [
    { id: ME, email: DUMMY_EMAIL, name: "受講生エー", role: "STUDENT", avatar: "avatar-a.png", deactivatedAt: null, password: "hash-a" },
    { id: "stu_b", email: "b@example.com", name: "受講生ビー", role: "STUDENT", avatar: null, deactivatedAt: null, password: "hash-b" },
    { id: "stu_gone", email: "gone@example.com", name: "受講生ゴーン", role: "STUDENT", avatar: null, deactivatedAt: new Date(BASE - 86_400_000), password: "hash-g" },
    { id: "ins_1", email: "teacher@example.com", name: "講師シー", role: "INSTRUCTOR", avatar: null, deactivatedAt: null, password: "hash-i" },
  ];
  // co2 は order が後でも id の順で並べ替えられないこと（order が先）を兼ねる
  courses = [
    { id: "co2", name: "STEP2", order: 2 },
    { id: "co1", name: "STEP1", order: 1 },
    { id: "co3", name: "STEP3", order: 3 },
  ];
  lessons = [
    { id: "l1", title: "レッスン1", courseId: "co1" },
    { id: "l2", title: "レッスン2", courseId: "co1" },
    { id: "l3", title: "レッスン3", courseId: "co2" },
    { id: "l4", title: "レッスン4", courseId: "co3" },
  ];
  progress = [];
  comments = [
    // co1（解放済み）
    { id: "q1", userId: "stu_b", lessonId: "l1", content: "質問1", parentId: null, createdAt: at(500) },
    { id: "q2", userId: "stu_gone", lessonId: "l2", content: "質問2", parentId: null, createdAt: at(400) },
    // co2（受講生 ME にはロック中）
    { id: "q3", userId: "stu_b", lessonId: "l3", content: "ロック中コースの質問", parentId: null, createdAt: at(300) },
    { id: "q4", userId: ME, lessonId: "l3", content: "ロック中コースの自分の質問", parentId: null, createdAt: at(200) },
    // co3（ロック中）
    { id: "q5", userId: "stu_b", lessonId: "l4", content: "STEP3 の質問", parentId: null, createdAt: at(100) },
    // co1。q6 は自分の質問
    { id: "q6", userId: ME, lessonId: "l1", content: "自分の質問", parentId: null, createdAt: at(50) },
    // 返信：q1 は講師が回答済み、q2 は受講生の返信だけ、q6 は別レッスンの講師の返信だけ（同じレッスンでは未回答）
    { id: "r1", userId: "ins_1", lessonId: "l1", content: "回答1", parentId: "q1", createdAt: at(450) },
    { id: "r2", userId: "stu_b", lessonId: "l1", content: "追記", parentId: "q1", createdAt: at(440) },
    { id: "r3", userId: ME, lessonId: "l2", content: "受講生の返信", parentId: "q2", createdAt: at(390) },
    { id: "rx", userId: "ins_1", lessonId: "l4", content: "別レッスンの回答", parentId: "q6", createdAt: at(10) },
    { id: "r4", userId: "ins_1", lessonId: "l3", content: "ロック中の回答", parentId: "q4", createdAt: at(150) },
  ];
});

const get = (query = "") => GET(new Request(`https://nwa-lms.example.com/api/comments${query}`));
const ids = (body: { threads: Array<{ id: string }> }) => body.threads.map((t) => t.id);
const commentCall = () => {
  const c = calls.filter((x) => x.method === "comment.findMany");
  assert.equal(c.length, 1);
  return c[0].args;
};

function captureLogs() {
  const logged = mock.method(console, "error", () => {});
  return () => {
    const args = logged.mock.calls.flatMap((c) => c.arguments);
    logged.mock.restore();
    return args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ");
  };
}

function piiError() {
  const err = new Error(`lookup failed for ${DUMMY_EMAIL} (${ME})`);
  Object.assign(err, { code: "P2025", meta: { email: DUMMY_EMAIL, userId: ME } });
  return err;
}

// ───────────── 認証・入力 ─────────────

describe("GET /api/comments：認証・入力", () => {
  it("セッションがなければ 401 で、DB を読まない", async () => {
    session = null;
    const res = await get();
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  it("user.id のないセッションも 401", async () => {
    session = { user: { role: "STUDENT" } };
    assert.equal((await get()).status, 401);
    assert.equal(calls.length, 0);
  });

  it("未ログインならクエリが不正でも 401（入力より認証が先）", async () => {
    session = null;
    assert.equal((await get("?status=bogus")).status, 401);
  });

  for (const [query, reason] of [
    ["?mine=yes", "invalid_mine"],
    ["?status=open", "invalid_status"],
    ["?status=", "invalid_status"],
    ["?courseId=", "invalid_course_id"],
    [`?courseId=${"a".repeat(65)}`, "invalid_course_id"],
    ["?cursor=abc", "invalid_cursor"],
    ["?cursor=-1.q1", "invalid_cursor"],
  ] as Array<[string, string]>) {
    it(`${query.slice(0, 30)} は 400（${reason}）で、DB を読まない`, async () => {
      const res = await get(query);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason });
      assert.equal(calls.length, 0);
    });
  }

  it("知らないパラメータは無視する（userId で他人の質問に絞れない）", async () => {
    const res = await get("?userId=stu_b&take=1000");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(ids(body), ["q6", "q4", "q2", "q1"]);
    assert.equal(commentCall().take, 21);
  });
});

// ───────────── 受講生のロック ─────────────

describe("GET /api/comments：受講生（ロック中のコースを除く）", () => {
  it("ロック中のコース（co2・co3）の他人の質問は除き、自分の質問は残す。新しい順", async () => {
    const body = await (await get()).json();
    assert.deepEqual(ids(body), ["q6", "q4", "q2", "q1"]);
  });

  it("コースは [order, id] で読み、進捗は自分の完了分だけを読む", async () => {
    await get();
    const course = calls.find((c) => c.method === "course.findMany");
    assert.deepEqual(course?.args, {
      orderBy: [{ order: "asc" }, { id: "asc" }],
      select: { id: true, sections: { select: { lessons: { select: { id: true } } } } },
    });
    const prog = calls.find((c) => c.method === "progress.findMany");
    assert.deepEqual(prog?.args, { where: { userId: ME, completed: true }, select: { lessonId: true } });
  });

  it("where：親だけ・自分の質問か解放済みコース", async () => {
    await get();
    assert.deepEqual(commentCall().where, {
      parentId: null,
      AND: [{ OR: [{ userId: ME }, { lesson: { section: { courseId: { in: ["co1"] } } } }] }],
    });
  });

  it("co1 を全部終えると co2 が解放される（co3 はロックのまま）", async () => {
    progress = [
      { userId: ME, lessonId: "l1", completed: true },
      { userId: ME, lessonId: "l2", completed: true },
    ];
    const body = await (await get()).json();
    assert.deepEqual(ids(body), ["q6", "q4", "q3", "q2", "q1"]);
  });

  it("他人の進捗や未完了の進捗では解放されない", async () => {
    progress = [
      { userId: "stu_b", lessonId: "l1", completed: true },
      { userId: "stu_b", lessonId: "l2", completed: true },
      { userId: ME, lessonId: "l2", completed: false },
      { userId: ME, lessonId: "l1", completed: true },
    ];
    const body = await (await get()).json();
    assert.deepEqual(ids(body), ["q6", "q4", "q2", "q1"]);
  });

  it("role のない受講生のセッションもロックをかける", async () => {
    session = { user: { id: ME } };
    const body = await (await get()).json();
    assert.deepEqual(ids(body), ["q6", "q4", "q2", "q1"]);
  });

  it("courseId でロック中のコースを指定しても、他人の質問は出ない（自分の質問だけ）", async () => {
    const body = await (await get("?courseId=co2")).json();
    assert.deepEqual(ids(body), ["q4"]);
  });
});

describe("GET /api/comments：講師（ロックなし）", () => {
  it("全コースの質問を返し、コース・進捗を読まない", async () => {
    session = INSTRUCTOR_SESSION;
    const body = await (await get()).json();
    assert.deepEqual(ids(body), ["q6", "q5", "q4", "q3", "q2", "q1"]);
    assert.deepEqual(calls.map((c) => c.method), ["comment.findMany"]);
    assert.deepEqual(commentCall().where, { parentId: null, AND: [] });
  });
});

// ───────────── 絞り込み ─────────────

describe("GET /api/comments：絞り込み", () => {
  it("mine=1：自分の質問だけ（ロック中のコースのものも）", async () => {
    const body = await (await get("?mine=1")).json();
    assert.deepEqual(ids(body), ["q6", "q4"]);
    assert.ok(body.threads.every((t: { mine: boolean }) => t.mine));
  });

  it("講師の mine=1 は講師自身の質問だけ（ここでは 0 件）", async () => {
    session = INSTRUCTOR_SESSION;
    const body = await (await get("?mine=1")).json();
    assert.deepEqual(body, { threads: [], nextCursor: null });
  });

  it("courseId=co1", async () => {
    const body = await (await get("?courseId=co1")).json();
    assert.deepEqual(ids(body), ["q6", "q2", "q1"]);
  });

  it("status=answered：同じレッスンに講師の返信があるものだけ（別レッスンの講師の返信は数えない）", async () => {
    const body = await (await get("?status=answered")).json();
    assert.deepEqual(ids(body), ["q4", "q1"]);
    assert.ok(body.threads.every((t: { answered: boolean }) => t.answered));
    const and = commentCall().where as { AND: unknown[] };
    assert.deepEqual(and.AND[1], { replies: { some: { user: { role: "INSTRUCTOR" } } } });
  });

  it("status=unanswered：講師の返信がないもの", async () => {
    const body = await (await get("?status=unanswered")).json();
    assert.deepEqual(ids(body), ["q2"]);
    assert.ok(body.threads.every((t: { answered: boolean }) => !t.answered));
    const and = commentCall().where as { AND: unknown[] };
    assert.deepEqual(and.AND[1], { replies: { none: { user: { role: "INSTRUCTOR" } } } });
  });

  it("status=all は全部（answered の値は同じレッスンの講師の返信で決まる）", async () => {
    session = INSTRUCTOR_SESSION;
    const body = await (await get("?status=all")).json();
    assert.deepEqual(
      body.threads.map((t: { id: string; answered: boolean }) => [t.id, t.answered]),
      [["q6", false], ["q5", false], ["q4", true], ["q3", false], ["q2", false], ["q1", true]]
    );
  });

  it("mine と status と courseId の組み合わせ", async () => {
    const body = await (await get("?mine=1&status=answered&courseId=co2")).json();
    assert.deepEqual(ids(body), ["q4"]);
  });
});

// ───────────── ページング ─────────────

describe("GET /api/comments：ページング", () => {
  function many(n: number, sameTimeFrom = Infinity) {
    comments = Array.from({ length: n }, (_, i) => ({
      id: `m${String(i).padStart(3, "0")}`,
      userId: "stu_b",
      lessonId: "l1",
      content: `質問${i}`,
      parentId: null,
      // sameTimeFrom 以降はすべて同時刻（id の降順で並ぶ）
      createdAt: at(i >= sameTimeFrom ? sameTimeFrom : i),
    }));
  }

  it("親の質問だけを新しい順（同時刻は id の降順）で take 21", async () => {
    await get();
    const args = commentCall();
    assert.deepEqual(args.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
    assert.equal(args.take, 21);
    assert.equal((args.where as { parentId: unknown }).parentId, null);
  });

  it("45 件：20 件ずつ、カーソルで続きを読み、重複も抜けもない", async () => {
    many(45);
    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    for (let i = 0; i < 5; i++) {
      calls = [];
      const body = await (await get(cursor ? `?cursor=${encodeURIComponent(cursor)}` : "")).json();
      sizes.push(body.threads.length);
      seen.push(...ids(body));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    assert.deepEqual(sizes, [20, 20, 5]);
    assert.deepEqual(seen, Array.from({ length: 45 }, (_, i) => `m${String(i).padStart(3, "0")}`));
  });

  it("nextCursor は 20 件目の <epochMillis>.<id>", async () => {
    many(25);
    const body = await (await get()).json();
    assert.equal(body.nextCursor, `${at(19).getTime()}.m019`);
  });

  it("同時刻の行がページをまたいでも、id で続きを読む", async () => {
    many(30, 10); // m010〜m029 が同時刻
    const first = await (await get()).json();
    const second = await (await get(`?cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    const all = [...ids(first), ...ids(second)];
    assert.equal(new Set(all).size, 30);
    assert.equal(second.nextCursor, null);
    // 同時刻の部分は id の降順
    assert.deepEqual(all.slice(10, 13), ["m029", "m028", "m027"]);
  });

  it("カーソルの where は createdAt と id の組", async () => {
    await get("?cursor=1000.q9");
    const and = (commentCall().where as { AND: unknown[] }).AND;
    assert.deepEqual(and[and.length - 1], {
      OR: [{ createdAt: { lt: new Date(1000) } }, { createdAt: new Date(1000), id: { lt: "q9" } }],
    });
  });

  it("ちょうど 20 件なら nextCursor は null", async () => {
    many(20);
    const body = await (await get()).json();
    assert.equal(body.threads.length, 20);
    assert.equal(body.nextCursor, null);
  });

  it("0 件は { threads: [], nextCursor: null }", async () => {
    comments = [];
    assert.deepEqual(await (await get()).json(), { threads: [], nextCursor: null });
  });
});

// ───────────── 応答の項目 ─────────────

describe("GET /api/comments：select と応答", () => {
  it("select は必要な項目だけ（email・avatar・password を読まない）", async () => {
    await get();
    const userSelect = { select: { name: true, role: true, deactivatedAt: true } };
    const base = { id: true, content: true, createdAt: true, userId: true, user: userSelect };
    const args = commentCall();
    assert.deepEqual(args.select, {
      ...base,
      lesson: { select: { id: true, title: true, section: { select: { course: { select: { id: true, name: true } } } } } },
      replies: { select: { ...base, lessonId: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    });
    assert.equal("include" in args, false);
    assert.doesNotMatch(JSON.stringify(args.select), /email|avatar|password/);
  });

  it("1 件の形：名前・講師・mine・lesson・course・返信（同じレッスンだけ、古い順）・件数・最後の返信・回答済み", async () => {
    const body = await (await get()).json();
    const q1 = body.threads.find((t: { id: string }) => t.id === "q1");
    assert.deepEqual(q1, {
      id: "q1",
      content: "質問1",
      createdAt: at(500).toISOString(),
      author: { name: "受講生ビー", isInstructor: false },
      mine: false,
      replies: [
        { id: "r1", content: "回答1", createdAt: at(450).toISOString(), author: { name: "講師シー", isInstructor: true }, mine: false },
        { id: "r2", content: "追記", createdAt: at(440).toISOString(), author: { name: "受講生ビー", isInstructor: false }, mine: false },
      ],
      lesson: { id: "l1", title: "レッスン1" },
      course: { id: "co1", name: "STEP1" },
      replyCount: 2,
      lastReplyAt: at(440).toISOString(),
      answered: true,
    });
  });

  it("無効化された受講生は name: null。別レッスンの返信は含めない", async () => {
    const body = await (await get()).json();
    const byId = new Map<string, Record<string, unknown>>(body.threads.map((t: { id: string }) => [t.id, t]));
    assert.deepEqual(byId.get("q2")?.author, { name: null, isInstructor: false });
    const q6 = byId.get("q6");
    assert.deepEqual(q6?.replies, []);
    assert.equal(q6?.replyCount, 0);
    assert.equal(q6?.answered, false);
    assert.equal(q6?.lastReplyAt, null);
  });

  it("応答に userId・avatar・email・role・deactivatedAt・password・section を含めない", async () => {
    session = INSTRUCTOR_SESSION;
    const text = await (await get()).text();
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), ["nextCursor", "threads"]);
    for (const t of body.threads) {
      assert.deepEqual(Object.keys(t).sort(), ["answered", "author", "content", "course", "createdAt", "id", "lastReplyAt", "lesson", "mine", "replies", "replyCount"]);
      assert.deepEqual(Object.keys(t.author).sort(), ["isInstructor", "name"]);
      assert.deepEqual(Object.keys(t.lesson).sort(), ["id", "title"]);
      assert.deepEqual(Object.keys(t.course).sort(), ["id", "name"]);
      for (const r of t.replies) assert.deepEqual(Object.keys(r).sort(), ["author", "content", "createdAt", "id", "mine"]);
    }
    for (const k of ["userId", "avatar", "email", "role", "deactivatedAt", "password", "hash-", "section", "lessonId", "example\\.com", ME, "stu_b", "stu_gone", "ins_1", "受講生ゴーン", "INSTRUCTOR", "STUDENT"]) {
      assert.doesNotMatch(text, new RegExp(k), k);
    }
  });
});

describe("GET /api/comments：エラー", () => {
  it("例外なら 500 で、ログにメールアドレス・ユーザー ID・メッセージを出さない", async () => {
    failWith = piiError();
    const done = captureLogs();
    const res = await get();
    const out = done();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
    assert.ok(out.length > 0);
    assert.match(out, /GET \/api\/comments error/);
    assert.match(out, /Error/);
    for (const re of [/example\.com/, new RegExp(ME), /lookup failed/, /P2025/]) assert.doesNotMatch(out, re);
  });
});

// ───────────── POST（回帰） ─────────────

const post = (body: unknown) =>
  POST(
    new Request("https://nwa-lms.example.com/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

describe("POST /api/comments：回帰（GET の追加で変わらない）", () => {
  it("未ログインは 401 で、DB を読まない", async () => {
    session = null;
    assert.equal((await post({ lessonId: "l1", content: "質問" })).status, 401);
    assert.equal(calls.length, 0);
  });

  it("入力が不正なら 400 と reason", async () => {
    const res = await post({ lessonId: "l1", content: " " });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "empty");
    assert.equal(calls.length, 0);
  });

  it("201 で作成し、userId はセッションの値。応答の形は変わらない", async () => {
    const res = await post({ lessonId: "l1", content: "新しい質問", userId: "ins_1" });
    assert.equal(res.status, 201);
    const create = calls.find((c) => c.method === "comment.create");
    assert.deepEqual(create?.args.data, { userId: ME, lessonId: "l1", content: "新しい質問", parentId: null });
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["author", "content", "createdAt", "id", "mine", "replies"]);
    assert.equal(body.mine, true);
  });

  it("返信への返信は 400", async () => {
    const res = await post({ lessonId: "l1", content: "返信", parentId: "r1" });
    assert.equal(res.status, 400);
    assert.equal(calls.some((c) => c.method === "comment.create"), false);
  });
});
