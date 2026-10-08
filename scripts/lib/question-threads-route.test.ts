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

  it("status=unanswered：同じレッスンに講師の返信がないもの（別レッスンの講師の返信しかない q6 も含む）", async () => {
    const body = await (await get("?status=unanswered")).json();
    assert.deepEqual(ids(body), ["q6", "q2"]);
    assert.ok(body.threads.every((t: { answered: boolean }) => !t.answered), "未回答でないものが出ている");
    // DB では講師の返信で絞らない（ロックの条件だけ）
    const and = commentCall().where as { AND: unknown[] };
    assert.equal(and.AND.length, 1);
    assert.ok(!JSON.stringify(and.AND).includes("replies"), `replies の条件がある: ${inspect(and.AND)}`);
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

// ───────────── 追加（tester、#32）：他人の情報・ロック ─────────────

describe("GET /api/comments（追加）：ロック中のコースの他人の質問と返信を出さない", () => {
  beforeEach(() => {
    // ロック中のコース（co2・co3）の他人の質問にも返信を付け、応答の文字列に出ないことを確かめる
    comments.push(
      { id: "rl3", userId: "ins_1", lessonId: "l3", content: "ロック中の他人の質問への回答", parentId: "q3", createdAt: at(250) },
      { id: "rl5", userId: "stu_gone", lessonId: "l4", content: "STEP3 の他人の返信", parentId: "q5", createdAt: at(90) }
    );
  });

  for (const query of ["", "?mine=0", "?status=all", "?status=answered", "?status=unanswered", "?courseId=co2", "?courseId=co3", "?courseId=co3&status=answered", "?cursor=9999999999999.zzz"]) {
    it(`受講生 ${query || "（クエリなし）"}：q3・q5 とその返信が応答のどこにも出ない`, async () => {
      const res = await get(query);
      assert.equal(res.status, 200);
      const text = await res.text();
      for (const s of ["q3", "q5", "rl3", "rl5", "ロック中コースの質問", "ロック中の他人の質問への回答", "STEP3 の質問", "STEP3 の他人の返信", "STEP3", "レッスン4"]) {
        assert.ok(!text.includes(s), `${query}: ${s}`);
      }
    });
  }

  it("ロック中のコースの自分の質問は、他人（講師）の返信ごと出る", async () => {
    const body = await (await get("?courseId=co2")).json();
    assert.deepEqual(ids(body), ["q4"]);
    assert.deepEqual(body.threads[0].replies.map((r: { id: string }) => r.id), ["r4"]);
    assert.equal(body.threads[0].mine, true);
    assert.equal(body.threads[0].answered, true);
  });

  it("講師には q3・q5 と返信がすべて出る", async () => {
    session = INSTRUCTOR_SESSION;
    const body = await (await get()).json();
    const byId = new Map<string, { replies: Array<{ id: string }> }>(body.threads.map((t: { id: string; replies: Array<{ id: string }> }) => [t.id, t]));
    assert.deepEqual(byId.get("q3")?.replies.map((r) => r.id), ["rl3"]);
    assert.deepEqual(byId.get("q5")?.replies.map((r) => r.id), ["rl5"]);
  });

  it("講師は courseId を付けてもコース・進捗を読まない", async () => {
    session = INSTRUCTOR_SESSION;
    const body = await (await get("?courseId=co3&mine=0&status=all")).json();
    assert.deepEqual(ids(body), ["q5"]);
    assert.deepEqual(calls.map((c) => c.method), ["comment.findMany"]);
  });
});

describe("GET /api/comments（追加）：解放の順序", () => {
  it("co1・co2 を全部終えると co3 まで解放される", async () => {
    progress = ["l1", "l2", "l3"].map((lessonId) => ({ userId: ME, lessonId, completed: true }));
    const body = await (await get()).json();
    assert.deepEqual(ids(body), ["q6", "q5", "q4", "q3", "q2", "q1"]);
  });

  it("前のコースが途中でも、そのコースを 1 件終えていれば解放（co2 は途中、co3 はロックのまま）", async () => {
    lessons.push({ id: "l3b", title: "レッスン3b", courseId: "co2" });
    progress = [
      { userId: ME, lessonId: "l1", completed: true },
      { userId: ME, lessonId: "l3", completed: true },
    ];
    const body = await (await get()).json();
    assert.deepEqual(ids(body), ["q6", "q4", "q3", "q2", "q1"]);
  });

  it("co1 が途中でも co2 を全部終えれば co3 も解放される（isCourseLocked は直前のコースだけを見る）", async () => {
    progress = [{ userId: ME, lessonId: "l3", completed: true }];
    const body = await (await get()).json();
    assert.deepEqual(ids(body), ["q6", "q5", "q4", "q3", "q2", "q1"]);
  });

  it("コースが 1 つもなければ自分の質問だけ（in: []）", async () => {
    const orig = fakePrisma.course.findMany;
    fakePrisma.course.findMany = async (args: Record<string, unknown>) => {
      calls.push({ method: "course.findMany", args });
      return [];
    };
    try {
      const body = await (await get()).json();
      assert.deepEqual(ids(body), ["q6", "q4"]);
      assert.deepEqual(commentCall().where, {
        parentId: null,
        AND: [{ OR: [{ userId: ME }, { lesson: { section: { courseId: { in: [] } } } }] }],
      });
    } finally {
      fakePrisma.course.findMany = orig;
    }
  });

  it("別の受講生のセッションでは、ME の質問もロックの対象になる（mine は見る人で決まる）", async () => {
    session = { user: { id: "stu_b", role: "STUDENT" } };
    const body = await (await get()).json();
    // stu_b は進捗なし：co1 と、自分の q3・q5 だけ。ME のロック中の q4 は出ない
    assert.deepEqual(ids(body), ["q6", "q5", "q3", "q2", "q1"]);
    const mineIds = body.threads.filter((t: { mine: boolean }) => t.mine).map((t: { id: string }) => t.id);
    assert.deepEqual(mineIds, ["q5", "q3", "q1"]);
  });
});

describe("GET /api/comments（追加）：応答・select に個人情報を出さない", () => {
  for (const [label, s] of [
    ["受講生", () => STUDENT_SESSION],
    ["講師", () => INSTRUCTOR_SESSION],
  ] as Array<[string, () => FakeSession]>) {
    it(`${label}：絞り込みの各組み合わせで、応答 JSON 全体に email・avatar・password・userId・role・deactivatedAt が出ない`, async () => {
      for (const q of ["", "?mine=1", "?status=answered", "?status=unanswered", "?courseId=co1", "?courseId=co2&status=answered"]) {
        session = s();
        const text = await (await get(q)).text();
        for (const k of ["email", "avatar", "password", "userId", "\"role\"", "deactivatedAt", "example.com", "avatar-a.png", "hash-", "STUDENT", "INSTRUCTOR", "受講生ゴーン"]) {
          assert.ok(!text.includes(k), `${label} ${q}: ${k}`);
        }
      }
    });
  }

  it("select の user（親・返信とも）は name・role・deactivatedAt だけ", async () => {
    await get();
    const sel = commentCall().select as { user: unknown; replies: { select: { user: unknown } } };
    const want = { select: { name: true, role: true, deactivatedAt: true } };
    assert.deepEqual(sel.user, want);
    assert.deepEqual(sel.replies.select.user, want);
  });

  it("無効化された受講生の返信も name: null（名前を出さない）", async () => {
    comments.push({ id: "rg", userId: "stu_gone", lessonId: "l1", content: "退会者の返信", parentId: "q1", createdAt: at(430) });
    const body = await (await get()).json();
    const q1 = body.threads.find((t: { id: string }) => t.id === "q1");
    const rg = q1.replies.find((r: { id: string }) => r.id === "rg");
    assert.deepEqual(rg.author, { name: null, isInstructor: false });
  });

  it("返信の mine は見る人の返信だけ true", async () => {
    const body = await (await get()).json();
    const q2 = body.threads.find((t: { id: string }) => t.id === "q2");
    assert.deepEqual(q2.replies.map((r: { id: string; mine: boolean }) => [r.id, r.mine]), [["r3", true]]);
  });
});

// ───────────── 追加：絞り込みの組み合わせ ─────────────

describe("GET /api/comments（追加）：mine × status × courseId の全組み合わせ（整合したデータ）", () => {
  // 別レッスンの返信（rx）を除いた整合したデータで、仕様どおりの答えと突き合わせる
  type Thread = { id: string; userId: string; courseId: string; answered: boolean };
  const oracle = (viewer: string, instructor: boolean, unlocked: string[], mine: boolean, status: string, courseId: string | null) => {
    const ts: Thread[] = comments
      .filter((c) => c.parentId === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((c) => ({
        id: c.id,
        userId: c.userId,
        courseId: lessonOf(c.lessonId).courseId,
        answered: comments.some((r) => r.parentId === c.id && r.lessonId === c.lessonId && userOf(r.userId).role === "INSTRUCTOR"),
      }));
    return ts
      .filter((t) => instructor || t.userId === viewer || unlocked.includes(t.courseId))
      .filter((t) => !mine || t.userId === viewer)
      .filter((t) => courseId === null || t.courseId === courseId)
      .filter((t) => status === "all" || t.answered === (status === "answered"))
      .map((t) => t.id);
  };

  for (const who of ["student", "instructor"] as const) {
    for (const mine of [false, true]) {
      for (const status of ["all", "answered", "unanswered"]) {
        for (const courseId of [null, "co1", "co2", "co3", "co_none"]) {
          const q = new URLSearchParams();
          if (mine) q.set("mine", "1");
          q.set("status", status);
          if (courseId) q.set("courseId", courseId);
          it(`${who} ?${q}`, async () => {
            comments = comments.filter((c) => c.id !== "rx");
            // 講師自身の質問（返信なし）も 1 件入れる
            comments.push({ id: "qi", userId: "ins_1", lessonId: "l3", content: "講師の質問", parentId: null, createdAt: at(30) });
            session = who === "student" ? STUDENT_SESSION : INSTRUCTOR_SESSION;
            const viewer = who === "student" ? ME : "ins_1";
            const body = await (await get(`?${q}`)).json();
            assert.deepEqual(ids(body), oracle(viewer, who === "instructor", ["co1"], mine, status, courseId));
          });
        }
      }
    }
  }
});

// ───────────── 追加：回答済みの判定 ─────────────

describe("GET /api/comments（追加）：回答済みの判定", () => {
  beforeEach(() => {
    session = INSTRUCTOR_SESSION;
  });

  it("講師自身の質問で返信なしは「未回答」", async () => {
    comments = [{ id: "qi", userId: "ins_1", lessonId: "l1", content: "講師の質問", parentId: null, createdAt: at(10) }];
    const body = await (await get()).json();
    assert.equal(body.threads[0].answered, false);
    assert.equal(body.threads[0].author.isInstructor, true);
  });

  it("講師自身の質問に講師自身が返信すると「回答済み」（講師の返信があるため）", async () => {
    comments = [
      { id: "qi", userId: "ins_1", lessonId: "l1", content: "講師の質問", parentId: null, createdAt: at(10) },
      { id: "ri", userId: "ins_1", lessonId: "l1", content: "講師の自己返信", parentId: "qi", createdAt: at(5) },
    ];
    const body = await (await get()).json();
    assert.equal(body.threads[0].answered, true);
  });

  it("同じレッスンの講師の返信と別レッスンの返信が両方ある：回答済み、件数と lastReplyAt は同じレッスンの分だけ", async () => {
    comments = [
      { id: "qa", userId: "stu_b", lessonId: "l1", content: "質問", parentId: null, createdAt: at(100) },
      { id: "ra", userId: "ins_1", lessonId: "l1", content: "回答", parentId: "qa", createdAt: at(50) },
      { id: "rb", userId: "stu_b", lessonId: "l2", content: "別レッスンの追記", parentId: "qa", createdAt: at(10) },
    ];
    const body = await (await get("?status=answered")).json();
    assert.deepEqual(ids(body), ["qa"]);
    assert.equal(body.threads[0].replyCount, 1);
    assert.equal(body.threads[0].lastReplyAt, at(50).toISOString());
    assert.ok(!JSON.stringify(body).includes("別レッスンの追記"), "別レッスンの返信が出ている");
  });

  it("status=answered：1 ページ目の 21 件中 20 件が別レッスンの講師の返信だけでも、nextCursor で続きを読める（抜けない）", async () => {
    comments = [];
    for (let i = 0; i < 25; i++) {
      const id = `p${String(i).padStart(2, "0")}`;
      comments.push({ id, userId: "stu_b", lessonId: "l1", content: id, parentId: null, createdAt: at(i) });
      // p00〜p19 は別レッスン（l2）の講師の返信だけ、p20〜p24 は同じレッスンの講師の返信
      comments.push({ id: `r_${id}`, userId: "ins_1", lessonId: i < 20 ? "l2" : "l1", content: "回答", parentId: id, createdAt: at(i) });
    }
    const first = await (await get("?status=answered")).json();
    assert.deepEqual(first.threads, []);
    assert.equal(first.nextCursor, `${at(19).getTime()}.p19`);
    const second = await (await get(`?status=answered&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    assert.deepEqual(ids(second), ["p20", "p21", "p22", "p23", "p24"]);
    assert.equal(second.nextCursor, null);
  });

  it("status=unanswered：1 ページ目の 20 件がすべて回答済みなら threads は空で、nextCursor で続きを読める", async () => {
    comments = [];
    for (let i = 0; i < 25; i++) {
      const id = `u${String(i).padStart(2, "0")}`;
      comments.push({ id, userId: "stu_b", lessonId: "l1", content: id, parentId: null, createdAt: at(i) });
      // u00〜u19（新しい 20 件）は同じレッスンの講師の返信あり、u20〜u24 は返信なし
      if (i < 20) comments.push({ id: `r_${id}`, userId: "ins_1", lessonId: "l1", content: "回答", parentId: id, createdAt: at(i) });
    }
    const first = await (await get("?status=unanswered")).json();
    assert.deepEqual(first.threads, []);
    assert.equal(first.nextCursor, `${at(19).getTime()}.u19`);
    const second = await (await get(`?status=unanswered&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    assert.deepEqual(ids(second), ["u20", "u21", "u22", "u23", "u24"]);
    assert.equal(second.nextCursor, null);
  });

  // 別レッスンにしか講師の返信がない質問は、「すべて」では answered: false（未回答）と表示される。
  // status=unanswered（画面の「未回答」タブ）にも出る（DB では講師の返信で絞らない）
  it("不整合データ：「すべて」で未回答の q6 は status=unanswered にも出る", async () => {
    session = STUDENT_SESSION;
    const all = await (await get()).json();
    const q6 = all.threads.find((t: { id: string }) => t.id === "q6");
    assert.equal(q6.answered, false);
    const un = await (await get("?status=unanswered")).json();
    assert.ok(ids(un).includes("q6"), `unanswered: ${ids(un).join(",")}`);
  });
});

// ───────────── 追加：ページングの境界・カーソルの改ざん ─────────────

describe("GET /api/comments（追加）：ページングの境界", () => {
  function rows(n: number, time: (i: number) => Date) {
    comments = Array.from({ length: n }, (_, i) => ({
      id: `k${String(i).padStart(3, "0")}`,
      userId: "stu_b",
      lessonId: "l1",
      content: `質問${i}`,
      parentId: null,
      createdAt: time(i),
    }));
  }

  async function walk(prefix = "") {
    const pages: string[][] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const sep = prefix ? "&" : "?";
      const q = cursor === null ? prefix : `${prefix}${sep}cursor=${encodeURIComponent(cursor)}`;
      const body = await (await get(q)).json();
      pages.push(ids(body));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    return pages;
  }

  it("21 件：20 件 + nextCursor、2 ページ目は 1 件で nextCursor は null", async () => {
    rows(21, (i) => at(i));
    const pages = await walk();
    assert.deepEqual(pages.map((p) => p.length), [20, 1]);
    assert.deepEqual(pages[1], ["k020"]);
  });

  it("41 件・すべて同時刻：id の降順で、重複も抜けもなくたどれる", async () => {
    rows(41, () => at(5));
    const pages = await walk();
    assert.deepEqual(pages.map((p) => p.length), [20, 20, 1]);
    const all = pages.flat();
    assert.deepEqual(all, [...all].sort().reverse());
    assert.equal(new Set(all).size, 41);
  });

  it("20 件目と 21 件目が同時刻（境界をまたぐ）でも抜けない", async () => {
    rows(22, (i) => at(i >= 19 ? 19 : i)); // k019・k020・k021 が同時刻
    const pages = await walk();
    assert.deepEqual(pages.map((p) => p.length), [20, 2]);
    assert.equal(new Set(pages.flat()).size, 22);
  });

  it("受講生のロックはカーソル付きの 2 ページ目にもかかる", async () => {
    comments = [];
    for (let i = 0; i < 30; i++) {
      comments.push({ id: `z${String(i).padStart(2, "0")}`, userId: "stu_b", lessonId: i % 2 === 0 ? "l1" : "l3", content: "x", parentId: null, createdAt: at(i) });
    }
    const pages = await walk();
    const all = pages.flat();
    assert.equal(all.length, 15);
    assert.ok(all.every((id) => Number(id.slice(1)) % 2 === 0), all.join(","));
  });

  it("mine=1 のままカーソルで続きを読める", async () => {
    rows(25, (i) => at(i));
    for (const c of comments) c.userId = ME;
    const pages = await walk("?mine=1");
    assert.deepEqual(pages.map((p) => p.length), [20, 5]);
  });
});

describe("GET /api/comments（追加）：カーソルの改ざん・極端な値", () => {
  for (const bad of [
    "1000",
    ".q1",
    "1000.",
    "1e3.q1",
    "+1000.q1",
    " 1000.q1",
    "1000 .q1",
    "0x10.q1",
    "１０００.q1",
    "1000000000000000.q1",
    `1000.${"a".repeat(65)}`,
    "-0.q1",
    "NaN.q1",
    "Infinity.q1",
  ]) {
    it(`cursor=${JSON.stringify(bad.slice(0, 24))} は 400 invalid_cursor で DB を読まない`, async () => {
      const res = await get(`?cursor=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid request", reason: "invalid_cursor" });
      assert.equal(calls.length, 0);
    });
  }

  it("id に . を含むカーソルは最初の . で分ける（1000.5x.q1 の id は 5x.q1）", async () => {
    await get(`?cursor=${encodeURIComponent("1000.5x.q1")}`);
    const and = (commentCall().where as { AND: unknown[] }).AND;
    assert.deepEqual(and[and.length - 1], {
      OR: [{ createdAt: { lt: new Date(1000) } }, { createdAt: new Date(1000), id: { lt: "5x.q1" } }],
    });
  });

  it("cursor=0.<id>（最古）は 0 件で nextCursor は null", async () => {
    const body = await (await get("?cursor=0.zzz")).json();
    assert.deepEqual(body, { threads: [], nextCursor: null });
  });

  it("15 桁の未来のカーソルは 1 ページ目と同じ（ロックは外れない）", async () => {
    const body = await (await get("?cursor=999999999999999.zzz")).json();
    assert.deepEqual(ids(body), ["q6", "q4", "q2", "q1"]);
  });

  it("先頭 0 埋めの数字は読める（000001000.q9 は 1000）", async () => {
    await get("?cursor=000001000.q9");
    const and = (commentCall().where as { AND: unknown[] }).AND;
    assert.deepEqual((and[and.length - 1] as { OR: Array<{ createdAt: unknown }> }).OR[1].createdAt, new Date(1000));
  });

  it("存在しない id のカーソルでも、その位置の続きを読む", async () => {
    const body = await (await get(`?cursor=${at(300).getTime()}.zzz`)).json();
    assert.deepEqual(ids(body), ["q2", "q1"]);
  });

  it("cursor を 2 つ付けたら最初の値を使う", async () => {
    const body = await (await get("?cursor=0.a&cursor=bogus")).json();
    assert.deepEqual(body, { threads: [], nextCursor: null });
  });
});

describe("GET /api/comments（追加）：400 の reason の優先順位", () => {
  for (const [query, reason] of [
    ["?mine=2&status=bogus&courseId=&cursor=x", "invalid_mine"],
    ["?status=ANSWERED", "invalid_status"],
    ["?status=bogus&courseId=&cursor=x", "invalid_status"],
    ["?courseId=&cursor=x", "invalid_course_id"],
    ["?mine=TRUE", "invalid_mine"],
    ["?mine=", "invalid_mine"],
  ] as Array<[string, string]>) {
    it(`${query} は ${reason}`, async () => {
      const res = await get(query);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, reason);
      assert.equal(calls.length, 0);
    });
  }

  it("mine=true / mine=false も読める", async () => {
    assert.deepEqual(ids(await (await get("?mine=true")).json()), ["q6", "q4"]);
    calls = [];
    assert.deepEqual(ids(await (await get("?mine=false")).json()), ["q6", "q4", "q2", "q1"]);
  });
});

// ───────────── 追加：ログ ─────────────

describe("GET /api/comments（追加）：ログ", () => {
  function captureAll() {
    const spies = (["error", "warn", "log", "info"] as const).map((m) => mock.method(console, m, () => {}));
    return () => {
      const out = spies.map((s) => s.mock.calls.map((c) => c.arguments));
      for (const s of spies) s.mock.restore();
      return out;
    };
  }

  for (const q of ["?mine=yes", "?status=x", "?courseId=", `?cursor=${encodeURIComponent(DUMMY_EMAIL)}`]) {
    it(`400（${q}）では何もログに出さない`, async () => {
      const done = captureAll();
      const res = await get(q);
      const out = done();
      assert.equal(res.status, 400);
      assert.deepEqual(out, [[], [], [], []]);
    });
  }

  it("401 でも何もログに出さない", async () => {
    session = null;
    const done = captureAll();
    await get();
    assert.deepEqual(done(), [[], [], [], []]);
  });

  it("200 でも何もログに出さない", async () => {
    const done = captureAll();
    await get();
    assert.deepEqual(done(), [[], [], [], []]);
  });

  it("500：console.error に固定の文言と例外の名前だけ（引数はちょうど 2 つ）", async () => {
    failWith = piiError();
    const done = captureAll();
    await get();
    const [errors, warns, logs, infos] = done();
    assert.deepEqual(errors, [["GET /api/comments error:", "Error"]]);
    assert.deepEqual([warns, logs, infos], [[], [], []]);
  });

  it("500：独自の名前の例外は名前だけ。code（P2025）も出さない", async () => {
    class PrismaClientKnownRequestError extends Error {
      code = "P2025";
    }
    const err = new PrismaClientKnownRequestError(`not found ${DUMMY_EMAIL}`);
    err.name = "PrismaClientKnownRequestError";
    failWith = err;
    const done = captureAll();
    await get();
    assert.deepEqual(done()[0], [["GET /api/comments error:", "PrismaClientKnownRequestError"]]);
  });

  it("500：Error 以外（文字列）を投げても中身を出さない", async () => {
    failWith = `failed for ${DUMMY_EMAIL}`;
    const done = captureAll();
    const res = await get();
    assert.equal(res.status, 500);
    assert.deepEqual(done()[0], [["GET /api/comments error:", "string"]]);
  });

  it("受講生のコース・進捗の読み込みで失敗しても 500（ログは名前だけ）", async () => {
    const orig = fakePrisma.progress.findMany;
    fakePrisma.progress.findMany = async () => {
      throw piiError();
    };
    const done = captureAll();
    try {
      const res = await get();
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
    } finally {
      fakePrisma.progress.findMany = orig;
    }
    assert.deepEqual(done()[0], [["GET /api/comments error:", "Error"]]);
  });
});
