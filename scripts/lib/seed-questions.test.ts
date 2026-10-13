import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { parseCommentContent } from "../../src/lib/lesson-comments";
import { REPLY_NOTIFICATION_TITLE, replyNotificationMessage, shouldNotifyQuestionAuthor } from "../../src/lib/question-reply";

// #32 A-1 prisma/seed.ts のダミー質問。
//
// SAFETY: DB・ネットワークなし。"@prisma/client" を CommonJS の読み込みで偽の PrismaClient に差し替えてから
// seed を読み込むので、本物の PrismaClient は作られず .env も読まれない。DATABASE_URL / DIRECT_URL は
// ダミーのローカル URL（127.0.0.1:1）を明示し、NODE_ENV / VERCEL_ENV は外す（seed のガードを通すため）。
// 偽の PrismaClient は create / createMany / deleteMany の引数を記録し、create には id を付けて返すだけ。

const ROOT = path.resolve(__dirname, "..", "..");
const SEED = path.join(ROOT, "prisma", "seed.ts");
const DUMMY_URL = "postgresql://dummy:dummy@127.0.0.1:1/dummy";

type Row = Record<string, unknown> & { id: string };
type Call = { model: string; method: string; args: Record<string, unknown> };

const calls: Call[] = [];
const tables: Record<string, Row[]> = {};
let disconnected: () => void;
const finished = new Promise<void>((resolve) => {
  disconnected = resolve;
});

function model(name: string) {
  tables[name] = tables[name] ?? [];
  return {
    async create(args: Record<string, unknown>) {
      calls.push({ model: name, method: "create", args });
      const row = { id: `${name}_${tables[name].length + 1}`, ...(args.data as Record<string, unknown>) } as Row;
      tables[name].push(row);
      return row;
    },
    async createMany(args: Record<string, unknown>) {
      calls.push({ model: name, method: "createMany", args });
      const data = args.data as Record<string, unknown>[];
      for (const d of data) tables[name].push({ id: `${name}_${tables[name].length + 1}`, ...d } as Row);
      return { count: data.length };
    },
    async deleteMany(args: Record<string, unknown> = {}) {
      calls.push({ model: name, method: "deleteMany", args });
      return { count: 0 };
    },
  };
}

class FakePrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        if (prop === "$disconnect") {
          return async () => {
            calls.push({ model: "$", method: "$disconnect", args: {} });
            disconnected();
          };
        }
        if (typeof prop !== "string" || prop === "then") return undefined;
        const store = target as unknown as Record<string, unknown>;
        if (!(prop in store)) store[prop] = model(prop);
        return store[prop];
      },
    });
  }
}

let errors: string[] = [];

const rows = (name: string) => tables[name] ?? [];
const byId = (name: string, id: unknown) => {
  const r = rows(name).find((x) => x.id === id);
  assert.ok(r, `${name} ${String(id)} がない`);
  return r;
};

before(async () => {
  process.env.DATABASE_URL = DUMMY_URL;
  process.env.DIRECT_URL = DUMMY_URL;
  delete (process.env as Record<string, string | undefined>).NODE_ENV;
  delete process.env.VERCEL_ENV;

  const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = mod._load;
  mod._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "@prisma/client") return { PrismaClient: FakePrismaClient };
    return originalLoad.call(this, request, parent, isMain);
  };

  const origError = console.error;
  const origLog = console.log;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  console.log = () => {};
  try {
    await import(SEED);
    await Promise.race([
      finished,
      new Promise((_, reject) => setTimeout(() => reject(new Error("seed が終わらない")), 30_000)),
    ]);
  } finally {
    console.error = origError;
    console.log = origLog;
    mod._load = originalLoad;
  }
});

const questions = () => rows("comment").filter((c) => c.parentId === undefined || c.parentId === null);
const repliesOf = (q: Row) => rows("comment").filter((c) => c.parentId === q.id);
const courseOfLesson = (lessonId: unknown) => {
  const lesson = byId("lesson", lessonId);
  const section = byId("section", lesson.sectionId);
  return byId("course", section.courseId);
};

describe("prisma/seed.ts（偽の PrismaClient で実行）", () => {
  it("エラーなく最後まで実行され、$disconnect が呼ばれる", () => {
    assert.deepEqual(errors, [], `console.error: ${errors.join(" / ")}`);
    assert.equal(process.exitCode ?? 0, 0, "exitCode は 0");
    assert.equal(calls.at(-1)?.method, "$disconnect", "最後は $disconnect");
  });

  it("ユーザーのメールアドレスはすべて example.com", () => {
    const users = rows("user");
    assert.ok(users.length >= 4, `ユーザーは 4 人以上: ${users.length}`);
    for (const u of users) assert.match(String(u.email), /^[a-z0-9._-]+@example\.com$/, `email: ${String(u.email)}`);
  });

  it("作るデータ全体に example.com 以外のメールアドレス・URL を含めない", () => {
    const text = JSON.stringify(calls.map((c) => c.args));
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    for (const e of emails) assert.match(e, /@example\.com$/, `example.com 以外のメール: ${e}`);
    // クイズの問題文「https:// の s は？」はホストのない文字列なので対象外
    assert.doesNotMatch(text, /https?:\/\/[A-Za-z0-9]/, "ホスト付きの URL を含めない");
  });

  it("追加の受講生 2 人は STUDENT で、1 人（student3）だけ無効化済み", () => {
    const s2 = rows("user").find((u) => u.email === "student2@example.com");
    const s3 = rows("user").find((u) => u.email === "student3@example.com");
    assert.ok(s2 && s3, "student2 / student3 を作る");
    assert.equal(s2.role, "STUDENT");
    assert.equal(s3.role, "STUDENT");
    assert.equal(s2.deactivatedAt ?? null, null, "student2 は有効");
    assert.ok(s3.deactivatedAt instanceof Date, "student3 は無効化済み");
    assert.ok((s3.deactivatedAt as Date).getTime() < Date.now(), "無効化日時は過去");
  });

  it("ダミー質問は 5 件：回答済み 2・未回答 3（うち無効化済み受講生 1、受講生の追記だけ 1）", () => {
    const qs = questions();
    assert.equal(qs.length, 5, `質問は 5 件: ${qs.length}`);
    const roleOf = (userId: unknown) => byId("user", userId).role;
    const answered = qs.filter((q) => repliesOf(q).some((r) => roleOf(r.userId) === "INSTRUCTOR"));
    const unanswered = qs.filter((q) => !answered.includes(q));
    assert.equal(answered.length, 2, "回答済み 2");
    assert.equal(unanswered.length, 3, "未回答 3");
    const deactivated = unanswered.filter((q) => byId("user", q.userId).deactivatedAt instanceof Date);
    assert.equal(deactivated.length, 1, "未回答のうち無効化済み受講生の質問は 1");
    assert.equal(repliesOf(deactivated[0]).length, 0, "無効化済み受講生の質問には返信なし");
    const studentOnly = unanswered.filter((q) => repliesOf(q).length > 0);
    assert.equal(studentOnly.length, 1, "受講生の追記だけの未回答は 1");
    assert.ok(
      repliesOf(studentOnly[0]).every((r) => r.userId === studentOnly[0].userId),
      "追記は質問者本人"
    );
    for (const q of answered) assert.equal(byId("user", q.userId).deactivatedAt ?? null, null, "回答済みの質問者は有効");
  });

  it("質問の投稿者は受講生だけ、質問は複数のコースにまたがる", () => {
    const qs = questions();
    for (const q of qs) assert.equal(byId("user", q.userId).role, "STUDENT", `質問 ${q.id} の投稿者`);
    const courseIds = new Set(qs.map((q) => courseOfLesson(q.lessonId).id));
    assert.ok(courseIds.size >= 3, `コースは 3 つ以上: ${courseIds.size}`);
  });

  it("lessonId は seed が作ったレッスンを指し、返信の lessonId は親と同じ", () => {
    for (const c of rows("comment")) {
      byId("lesson", c.lessonId);
      if (c.parentId) {
        const parent = byId("comment", c.parentId);
        assert.equal(c.lessonId, parent.lessonId, `返信 ${c.id} の lessonId`);
        assert.equal(parent.parentId ?? null, null, "返信への返信はない");
      }
    }
  });

  it("返信は親より後の時刻で、時刻はすべて過去", () => {
    const now = Date.now();
    for (const c of rows("comment")) {
      assert.ok(c.createdAt instanceof Date, `comment ${c.id} の createdAt`);
      assert.ok((c.createdAt as Date).getTime() < now, `comment ${c.id} は過去`);
      if (c.parentId) {
        const parent = byId("comment", c.parentId);
        assert.ok((c.createdAt as Date).getTime() > (parent.createdAt as Date).getTime(), `返信 ${c.id} は親より後`);
      }
    }
  });

  it("本文はすべて API の検証を通る（前後に空白なし・2000 文字以内）", () => {
    for (const c of rows("comment")) {
      assert.deepEqual(parseCommentContent(c.content), { ok: true, value: c.content }, `comment ${c.id}`);
    }
  });

  it("回答の通知は API と同じ文面で、回答済みの質問の（有効な）質問者宛て・コース名とレッスン名が一致する", () => {
    const replyNotes = rows("notification").filter((n) => n.title === REPLY_NOTIFICATION_TITLE);
    assert.equal(replyNotes.length, 2, `回答の通知は 2 件: ${replyNotes.length}`);
    const roleOf = (userId: unknown) => byId("user", userId).role;
    const expected = questions()
      .filter((q) => repliesOf(q).some((r) => roleOf(r.userId) === "INSTRUCTOR"))
      .map((q) => {
        const author = byId("user", q.userId);
        const lesson = byId("lesson", q.lessonId);
        const instructorReply = repliesOf(q).find((r) => roleOf(r.userId) === "INSTRUCTOR");
        assert.ok(instructorReply, `質問 ${q.id} に講師の回答がある`);
        assert.equal(
          shouldNotifyQuestionAuthor(
            { id: String(author.id), role: String(author.role), deactivatedAt: (author.deactivatedAt as Date) ?? null },
            String(instructorReply.userId)
          ),
          true,
          "回答済みの質問者は通知の対象"
        );
        return { userId: q.userId, message: replyNotificationMessage(String(courseOfLesson(q.lessonId).name), String(lesson.title)) };
      });
    assert.deepEqual(
      replyNotes.map((n) => ({ userId: n.userId, message: n.message })).sort((a, b) => String(a.message).localeCompare(String(b.message))),
      expected.sort((a, b) => String(a.message).localeCompare(String(b.message)))
    );
  });

  it("無効化済みの受講生には通知を作らない、通知に講師名・質問本文を含めない", () => {
    const deactivatedIds = rows("user").filter((u) => u.deactivatedAt instanceof Date).map((u) => u.id);
    for (const n of rows("notification")) assert.ok(!deactivatedIds.includes(String(n.userId)), `通知 ${n.id} は無効化済み宛て`);
    const instructorNames = rows("user").filter((u) => u.role === "INSTRUCTOR").map((u) => String(u.name));
    const bodies = rows("comment").map((c) => String(c.content));
    for (const n of rows("notification").filter((x) => x.title === REPLY_NOTIFICATION_TITLE)) {
      const text = `${n.title} ${n.message}`;
      for (const s of [...instructorNames, ...instructorNames.map((x) => x.replace(/\s/g, "")), ...bodies]) {
        assert.ok(!text.includes(s), `通知に「${s}」を含めない`);
      }
    }
    assert.ok(!rows("notification").some((n) => /先生/.test(String(n.title))), "講師名入りの旧タイトルは残っていない");
  });

  it("既存データを消してから作る（comment・notification・user の deleteMany が create より先）", () => {
    const firstCreate = calls.findIndex((c) => c.method === "create" || c.method === "createMany");
    for (const m of ["comment", "notification", "user"]) {
      const i = calls.findIndex((c) => c.model === m && c.method === "deleteMany");
      assert.ok(i >= 0 && i < firstCreate, `${m}.deleteMany は最初の create より前`);
    }
  });
});

describe("prisma/seed.ts のガード（ソース）", () => {
  const src = readFileSync(SEED, "utf8");

  it("assertLocalDatabase で DATABASE_URL と DIRECT_URL を検査し、失敗時は exit(1)", () => {
    assert.match(src, /import \{ assertLocalDatabase \} from "\.\.\/scripts\/lib\/assert-local-db";/);
    assert.match(src, /assertLocalDatabase\(\[process\.env\.DATABASE_URL, process\.env\.DIRECT_URL\]\);/);
    assert.match(src, /process\.exit\(1\);/);
  });

  it("ガードは new PrismaClient() の直後・main() の定義より前", () => {
    const client = src.indexOf("new PrismaClient()");
    const guard = src.indexOf("assertLocalDatabase([");
    const main = src.indexOf("async function main()");
    assert.ok(client >= 0 && guard > client && main > guard, "PrismaClient → ガード → main の順");
    const between = src.slice(client, guard);
    assert.doesNotMatch(between, /prisma\.\w+\.\w+\(/, "ガードの前にクエリを書かない");
  });
});
