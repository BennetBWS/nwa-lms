import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installFakeAuth, INSTRUCTOR_SESSION, type FakeSession } from "./student-routes.test-helpers";
import { jstMonthKey } from "../../src/lib/admin-stats";

// #32 PR B GET /api/admin/stats の補足（権限の境界・無効化済み受講生・講師の進捗・各クエリの失敗・ログ）。
// admin-stats-route.test.ts と同じく、globalThis.prisma にこのテスト専用の小さな偽物を置く（select は無視して
// 決めた形の行を返す。select の中身の検査は admin-stats-route.test.ts）。DB・ネットワークなし。データはすべてダミー。

type Method = "user" | "course" | "progress" | "comment";

let session: FakeSession;
let calls: string[];
let failOn: Partial<Record<Method, unknown>>;
let logs: string[];
let GET: () => Promise<Response>;
let routeModule: Record<string, unknown>;

// 実行時の現在時刻に対して相対の日時を使う（ルートは new Date() を使うため）
const recent = new Date(Date.now() - 60 * 60 * 1000);

const data = () => ({
  user: [
    { id: "stu_a", deactivatedAt: null as Date | null },
    { id: "stu_off", deactivatedAt: new Date("2026-01-01T00:00:00.000Z") as Date | null },
  ],
  course: [{ id: "c1", name: "STEP1 ダミー", color: "#6366F1", sections: [{ lessons: [{ id: "l1" }, { id: "l2" }] }] }],
  progress: [
    { userId: "stu_off", lessonId: "l1", completedAt: recent },
    { userId: "stu_off", lessonId: "l2", completedAt: recent },
    // 講師の完了行（受講生ではないので集計に入らない）
    { userId: "ins_1", lessonId: "l1", completedAt: recent },
    { userId: "ins_1", lessonId: "l2", completedAt: recent },
  ],
  comment: [
    // 無効化済み受講生の質問で、講師の返信がない → 未回答に数える
    { lesson: { id: "l1" }, replies: [{ lessonId: "l1", user: { role: "STUDENT" } }] },
    // 別レッスンの講師の返信だけ → 未回答
    { lesson: { id: "l2" }, replies: [{ lessonId: "l1", user: { role: "INSTRUCTOR" } }] },
    // 回答済み
    { lesson: { id: "l2" }, replies: [{ lessonId: "l2", user: { role: "INSTRUCTOR" } }] },
  ],
});

function model(name: Method) {
  return {
    async findMany() {
      calls.push(`${name}.findMany`);
      if (name in failOn) throw failOn[name];
      return data()[name];
    },
  };
}

const fake = { user: model("user"), course: model("course"), progress: model("progress"), comment: model("comment") };

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = fake;
  installFakeAuth(() => session);
  routeModule = await import("../../src/app/api/admin/stats/route");
  GET = routeModule.GET as () => Promise<Response>;
});

beforeEach(() => {
  session = INSTRUCTOR_SESSION;
  calls = [];
  failOn = {};
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    mock.method(console, level, (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });
  }
  mock.method(globalThis, "fetch", async () => {
    throw new Error("network access is not allowed in tests");
  });
});

afterEach(() => {
  mock.restoreAll();
});

describe("GET /api/admin/stats：権限の境界", () => {
  for (const [label, s] of [
    ["role が ADMIN", { user: { id: "x", role: "ADMIN" } }],
    ["role が小文字の instructor", { user: { id: "x", role: "instructor" } }],
    ["role が空文字", { user: { id: "x", role: "" } }],
    ["role が前後に空白つき", { user: { id: "x", role: " INSTRUCTOR " } }],
  ] as Array<[string, FakeSession]>) {
    it(`${label}は 403 で、DB を読まない`, async () => {
      session = s;
      const res = await GET();
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: "Forbidden" });
      assert.deepEqual(calls, [], "403 なのに DB を読んでいる");
    });
  }

  it("キャッシュしない（dynamic = force-dynamic）。GET 以外のメソッドを公開しない", () => {
    assert.equal(routeModule.dynamic, "force-dynamic");
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(routeModule[m], undefined, `${m} が公開されている`);
  });
});

describe("GET /api/admin/stats：無効化済み受講生・講師の進捗", () => {
  it("無効化済み受講生はカード・Distribution から外れ、当月の推移には入る。講師の完了行は混ざらない。無効化済み受講生の質問も未回答に数える", async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.cards, { activeStudents: 1, avgProgressPercent: 0, openQuestions: 2, completions: 0 });
    assert.deepEqual(body.distribution, [
      { courseId: "c1", name: "STEP1 ダミー", color: "#6366F1", students: 1 },
      { courseId: null, name: "全コース修了", color: "#94A3B8", students: 0 },
    ]);
    const current = body.monthly.find((m: { month: string }) => m.month === jstMonthKey(recent));
    assert.ok(current, "当月（または直前の月）の行がない");
    // stu_off だけ（講師 ins_1 は数えない）
    assert.equal(current.activeStudents, 1, "講師の学習が混ざっているか、無効化済み受講生が抜けている");
    assert.equal(current.completions, 1, "講師のコース修了が混ざっているか、無効化済み受講生が抜けている");
  });

  it("応答のどの階層にも、受講生個人の項目（id・userId・email・name の受講生・deactivatedAt）がない", async () => {
    const body = await (await GET()).json();
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x));
    };
    walk(body);
    for (const k of ["id", "userId", "email", "password", "deactivatedAt", "sessionVersion", "lessonId"]) {
      assert.ok(!keys.includes(k), `応答に ${k} がある`);
    }
    const json = JSON.stringify(body);
    for (const id of ["stu_a", "stu_off", "ins_1"]) assert.ok(!json.includes(id), `応答に ${id} が含まれている`);
  });
});

describe("GET /api/admin/stats：500", () => {
  for (const m of ["user", "course", "progress", "comment"] as const) {
    it(`${m}.findMany の失敗は 500 の汎用本文で、ログはエラー名（と Prisma のコード）だけ`, async () => {
      failOn[m] = Object.assign(new Error("timeout for a@example.com at db.example.com:5432"), { name: "PrismaClientKnownRequestError", code: "P1001", meta: { target: "a@example.com" } });
      const res = await GET();
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error" });
      assert.ok(logs.some((l) => l.includes("PrismaClientKnownRequestError")), "エラー名がログにない");
      for (const l of logs) {
        assert.ok(!l.includes("example.com") && !l.includes("timeout") && !l.includes("5432"), `ログに詳細が出ている: ${l}`);
      }
    });
  }

  it("Error 以外（文字列）が投げられても、本文もログも中身を出さない", async () => {
    failOn.progress = "postgres://user:secret@db.example.com/x";
    const res = await GET();
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.ok(!text.includes("secret"), "本文に中身が出ている");
    assert.ok(logs.length > 0, "ログが出ていない");
    for (const l of logs) assert.ok(!l.includes("secret") && !l.includes("example.com"), `ログに中身が出ている: ${l}`);
  });
});

describe("route.ts のソース", () => {
  const src = readFileSync(join(__dirname, "..", "..", "src", "app", "api", "admin", "stats", "route.ts"), "utf8");
  it("include を使わず、受講生の名前・メール・パスワードを select しない。書き込みのメソッドを呼ばない", () => {
    assert.ok(!/\binclude\s*:/.test(src), "include を使っている");
    assert.ok(!/\b(email|password|sessionVersion)\s*:\s*true/.test(src), "受講生の個人情報を select している");
    const userSelect = /prisma\.user\.findMany\(\{[\s\S]*?\}\)/.exec(src);
    assert.ok(userSelect, "user.findMany が見つからない");
    assert.ok(!/\bname\s*:/.test(userSelect[0]), "user.findMany で name を読んでいる");
    for (const w of ["create(", "update(", "delete(", "upsert(", "updateMany(", "deleteMany(", "$executeRaw", "$queryRaw"]) {
      assert.ok(!src.includes(w), `${w} を呼んでいる`);
    }
  });

  it("ロールの判定は auth() の直後で、as any を使わない", () => {
    const authAt = src.indexOf("await auth()");
    const roleAt = src.indexOf('session?.user?.role !== "INSTRUCTOR"');
    const dbAt = src.indexOf("prisma.");
    assert.ok(authAt >= 0 && roleAt > authAt && dbAt > roleAt, "auth → ロール判定 → DB の順になっていない");
    assert.ok(!src.includes("as any"), "as any を使っている");
  });
});
