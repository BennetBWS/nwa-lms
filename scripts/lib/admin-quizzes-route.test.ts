import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #81 Q3 GET /api/admin/quizzes（Q1 で作り直すまで main と同じ挙動のまま残す）。
// 同じファイルの POST を閉じたので、GET が変わっていないこと・ほかのメソッドを export していないことを固定する。
// DB・ネットワークなし。prisma は globalThis.prisma に置く、このテスト専用の小さな偽物（quiz.findMany だけ。
// 受け取った引数を記録し、知らないモデル・メソッドは例外）。NextAuth は installFakeAuth で差し替える。データはすべてダミー。

type Call = { method: string; args: unknown };

const quizzes = [
  {
    id: "qz_a",
    type: "MINI",
    title: "A ダミーミニテスト",
    courseId: null as string | null,
    lessonId: "l1",
    _count: { questions: 3, attempts: 5 },
    lesson: { title: "ダミーレッスン1" },
  },
  {
    id: "qz_b",
    type: "FINAL",
    title: "B ダミー修了テスト",
    courseId: "c1",
    lessonId: null as string | null,
    _count: { questions: 10, attempts: 0 },
    lesson: null as { title: string } | null,
  },
];

let session: FakeSession;
let calls: Call[];
let failWith: unknown;
let routeModule: Record<string, unknown>;
let GET: () => Promise<Response>;

const fake = new Proxy(
  {
    quiz: {
      async findMany(args: unknown) {
        calls.push({ method: "quiz.findMany", args });
        if (failWith) throw failWith;
        return quizzes.map((q) => ({ ...q }));
      },
    },
  } as Record<string, unknown>,
  {
    get(target, prop) {
      if (typeof prop === "string" && !(prop in target)) {
        return new Proxy(
          {},
          {
            get(_t, method) {
              return () => {
                throw new Error(`fake prisma: unexpected ${String(prop)}.${String(method)}`);
              };
            },
          }
        );
      }
      return target[prop as string];
    },
  }
);

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fake;
  installFakeAuth(() => session);
  routeModule = (await import("../../src/app/api/admin/quizzes/route")) as Record<string, unknown>;
  GET = routeModule.GET as () => Promise<Response>;
});

beforeEach(() => {
  session = INSTRUCTOR_SESSION;
  calls = [];
  failWith = undefined;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) mock.method(console, level, () => {});
  mock.method(globalThis, "fetch", async () => {
    throw new Error("network access is not allowed in tests");
  });
});

afterEach(() => {
  mock.restoreAll();
});

describe("GET /api/admin/quizzes：export（#81 Q3）", () => {
  it("route は GET だけを export する（POST は閉じた）", () => {
    const methods = Object.keys(routeModule).filter((k) => /^[A-Z]+$/.test(k));
    assert.deepEqual(methods, ["GET"], `GET 以外のメソッドが export されている：${JSON.stringify(methods)}`);
    assert.equal(typeof GET, "function", "GET が関数ではない");
  });
});

describe("GET /api/admin/quizzes：権限", () => {
  for (const [label, s] of [
    ["未ログイン", null],
    ["受講生", STUDENT_SESSION],
    ["role なし", { user: { id: "x" } }],
    ["小文字の instructor", { user: { id: "x", role: "instructor" } }],
  ] as Array<[string, FakeSession]>) {
    it(`${label}は 403 で、DB を読まない（main と同じ。401 / 403 の分離は Q1 で行う）`, async () => {
      session = s;
      const res = await GET();
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: "Forbidden" });
      assert.deepEqual(calls, [], "権限のない呼び出しで DB を読んでいる");
    });
  }
});

describe("GET /api/admin/quizzes：200", () => {
  it("講師には全クイズの一覧を返す（件数・レッスン名付き、title の昇順で 1 回だけ読む）", async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1, `DB の呼び出しが 1 回ではない：${JSON.stringify(calls)}`);
    assert.deepEqual(calls[0].args, {
      include: {
        _count: { select: { questions: true, attempts: true } },
        lesson: { select: { title: true } },
      },
      orderBy: { title: "asc" },
    });
    const body = await res.json();
    assert.ok(Array.isArray(body), "配列を返していない");
    assert.deepEqual(
      body.map((q: Record<string, unknown>) => [q.id, q.questionCount, q.attemptCount, (q.lesson as { title: string } | null)?.title ?? null]),
      [
        ["qz_a", 3, 5, "ダミーレッスン1"],
        ["qz_b", 10, 0, null],
      ]
    );
    // main と同じく、元の列と _count もそのまま含める
    assert.deepEqual(Object.keys(body[0]).sort(), ["_count", "attemptCount", "courseId", "id", "lesson", "lessonId", "questionCount", "title", "type"]);
  });

  it("クイズがなければ空配列", async () => {
    const saved = quizzes.splice(0, quizzes.length);
    try {
      const res = await GET();
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), []);
    } finally {
      quizzes.push(...saved);
    }
  });
});

describe("GET /api/admin/quizzes：500", () => {
  it("DB のエラーは汎用の本文で返す", async () => {
    failWith = Object.assign(new Error("connection failed for a@example.com"), { name: "PrismaClientInitializationError" });
    const res = await GET();
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(body, { error: "Internal server error" });
    assert.ok(!JSON.stringify(body).includes("example.com"), "応答にエラーの詳細が含まれている");
  });
});
