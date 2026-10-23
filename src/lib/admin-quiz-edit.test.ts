import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { Prisma } from "@prisma/client";

import { editQuizQuestion, type EditOutcome } from "./admin-quiz-edit";
import type { PatchQuestionInput, QuestionContent } from "./admin-quizzes";

// #81 Q1：route から移した editQuizQuestion の単体テスト（偽の tx。DB に接続しない）。
// 移す前（a74f4f7）の route のトランザクションの中身と、処理の順・分岐・引数が同じであることを固定する。

type Row = Record<string, unknown>;
type Call = { method: string; args: unknown };

const QUESTION_SELECT = { id: true, quizId: true, order: true, question: true, options: true, correctIndex: true };

let calls: Call[];
let current: (Row & QuestionContent) | null;
let updateCount: number;
let attemptCount: number;
let revisionArgs: QuestionContent[];

beforeEach(() => {
  calls = [];
  current = { id: "q1", quizId: "z1", order: 3, question: "元の問題", options: ["A", "B", "C"], correctIndex: 0 };
  updateCount = 1;
  attemptCount = 7;
  revisionArgs = [];
});

function fakeTx(): Prisma.TransactionClient {
  const tx = {
    quizQuestion: {
      async findUnique(args: unknown) {
        calls.push({ method: "quizQuestion.findUnique", args });
        return current ? { ...current } : null;
      },
      async updateMany(args: unknown) {
        calls.push({ method: "quizQuestion.updateMany", args });
        return { count: updateCount };
      },
    },
    quizQuestionRevision: {
      async create(args: unknown) {
        calls.push({ method: "quizQuestionRevision.create", args });
        return { id: "rev1" };
      },
    },
    quizAttempt: {
      async count(args: unknown) {
        calls.push({ method: "quizAttempt.count", args });
        return attemptCount;
      },
    },
  };
  // 上に無いメソッド（tx.$queryRaw や別のテーブル）を呼べば TypeError になり、テストが落ちる
  return tx as unknown as Prisma.TransactionClient;
}

/** 呼び出しの記録に残る revision の計算（内容の JSON をそのまま revision とみなす） */
function revisionOf(content: QuestionContent): string {
  revisionArgs.push(content);
  return `rev:${JSON.stringify([content.question, content.options, content.correctIndex])}`;
}

function currentRevision(): string {
  assert.ok(current, "前提：current がある");
  return `rev:${JSON.stringify([current.question, current.options, current.correctIndex])}`;
}

function run(input: Omit<PatchQuestionInput, "revision"> & { revision?: string }): Promise<EditOutcome> {
  const full: PatchQuestionInput = { revision: input.revision ?? currentRevision(), ...input } as PatchQuestionInput;
  if (input.revision === undefined) full.revision = currentRevision();
  return editQuizQuestion(fakeTx(), { id: "q1", input: full, editorId: "inst1", revisionOf });
}

const methods = () => calls.map((c) => c.method);

describe("editQuizQuestion：分岐ごとの DB の呼び出し（a74f4f7 の route と同じ順）", () => {
  it("行がなければ not_found。findUnique だけを呼び、revision も計算しない", async () => {
    current = null;
    const out = await editQuizQuestion(fakeTx(), { id: "q1", input: { revision: "x", correctIndex: 1 }, editorId: "inst1", revisionOf });
    assert.deepEqual(out, { kind: "not_found" });
    assert.deepEqual(methods(), ["quizQuestion.findUnique"]);
    assert.equal(revisionArgs.length, 0, "行がないのに revision を計算した");
  });

  it("findUnique は渡した id で、route と同じ 6 列だけを読む", async () => {
    await run({ correctIndex: 1 });
    assert.deepEqual(calls[0], { method: "quizQuestion.findUnique", args: { where: { id: "q1" }, select: QUESTION_SELECT } });
  });

  it("revision が違えば conflict。updateMany・履歴・受験件数を呼ばない", async () => {
    const out = await run({ revision: "rev:old", correctIndex: 1 });
    assert.deepEqual(out, { kind: "conflict" });
    assert.deepEqual(methods(), ["quizQuestion.findUnique"]);
    assert.equal(revisionArgs.length, 1, "revision を 1 回だけ計算していない");
    assert.equal(revisionArgs[0].question, "元の問題", "revisionOf に読んだ行を渡していない");
  });

  it("変更がなければ invalid（no_changes）。書き込みも件数も呼ばない", async () => {
    const out = await run({ question: "元の問題", options: ["A", "B", "C"], correctIndex: 0 });
    assert.deepEqual(out, { kind: "invalid", reason: "no_changes" });
    assert.deepEqual(methods(), ["quizQuestion.findUnique"]);
  });

  it("正解が変更後の選択肢の範囲外なら invalid（invalid_correct_index）。書き込みも件数も呼ばない", async () => {
    const out = await run({ options: ["A", "B"], correctIndex: 2 });
    assert.deepEqual(out, { kind: "invalid", reason: "invalid_correct_index" });
    assert.deepEqual(methods(), ["quizQuestion.findUnique"]);
  });

  it("updateMany が 0 件なら conflict。履歴も受験件数も呼ばない", async () => {
    updateCount = 0;
    const out = await run({ correctIndex: 2 });
    assert.deepEqual(out, { kind: "conflict" });
    assert.deepEqual(methods(), ["quizQuestion.findUnique", "quizQuestion.updateMany"]);
  });

  it("updateMany が 2 件（ありえないが）でも conflict。履歴を書かない", async () => {
    updateCount = 2;
    const out = await run({ correctIndex: 2 });
    assert.deepEqual(out, { kind: "conflict" });
    assert.ok(!methods().includes("quizQuestionRevision.create"), "1 件でないのに履歴を書いた");
  });

  it("ok：findUnique → updateMany → 履歴の create → 受験件数の順で、各 1 回", async () => {
    const out = await run({ correctIndex: 2 });
    assert.deepEqual(methods(), ["quizQuestion.findUnique", "quizQuestion.updateMany", "quizQuestionRevision.create", "quizAttempt.count"]);
    assert.equal(out.kind, "ok", `kind が ok でない（${out.kind}）`);
  });

  it("ok：updateMany は読んだ 4 つの値を条件にし、変わった項目だけを書く", async () => {
    await run({ correctIndex: 2 });
    assert.deepEqual(calls[1].args, {
      where: { id: "q1", question: "元の問題", correctIndex: 0, options: { equals: ["A", "B", "C"] } },
      data: { correctIndex: 2 },
    });
  });

  it("ok：options が JSON の null の行は、updateMany の条件を Prisma.JsonNull にする", async () => {
    assert.ok(current, "前提：current がある");
    current.options = null;
    const out = await run({ options: ["新A", "新B"], correctIndex: 1 });
    assert.equal(out.kind, "ok", `kind が ok でない（${out.kind}）`);
    const where = (calls[1].args as { where: { options: { equals: unknown } } }).where;
    assert.equal(where.options.equals, Prisma.JsonNull, "JSON の null の条件が Prisma.JsonNull でない");
    const data = (calls[2].args as { data: { before: Row } }).data;
    assert.equal(data.before.options, null, "履歴の before.options が null でない");
  });

  it("ok：履歴は questionId・quizId・editorId・changedFields・before・after を書き、id だけを select する", async () => {
    await run({ question: "新しい問題", correctIndex: 1 });
    assert.deepEqual(calls[2].args, {
      data: {
        questionId: "q1",
        quizId: "z1",
        editorId: "inst1",
        changedFields: ["question", "correctIndex"],
        before: { question: "元の問題", options: ["A", "B", "C"], correctIndex: 0 },
        after: { question: "新しい問題", options: ["A", "B", "C"], correctIndex: 1 },
      },
      select: { id: true },
    });
  });

  it("ok：受験件数はその問題のクイズで数え、row は after の値（id・order は読んだ行）を返す", async () => {
    const out = await run({ options: ["A", "B", "C2"] });
    assert.deepEqual(calls[3].args, { where: { quizId: "z1" } });
    assert.deepEqual(out, {
      kind: "ok",
      row: { id: "q1", order: 3, question: "元の問題", options: ["A", "B", "C2"], correctIndex: 0 },
      changed: ["options"],
      attemptCount: 7,
    });
  });

  it("DB のエラーは握りつぶさずにそのまま投げる（route の catch で 500 にするため）", async () => {
    const tx = fakeTx() as unknown as { quizQuestion: { updateMany: () => Promise<never> } };
    const err = Object.assign(new Error("x"), { code: "P2025" });
    tx.quizQuestion.updateMany = async () => {
      throw err;
    };
    await assert.rejects(
      editQuizQuestion(tx as unknown as Prisma.TransactionClient, { id: "q1", input: { revision: currentRevision(), correctIndex: 1 }, editorId: "inst1", revisionOf }),
      (e: unknown) => e === err
    );
  });
});

// ───────────── route との関係・import の境界 ─────────────

describe("問題の PATCH の route は editQuizQuestion に任せる", () => {
  const root = join(__dirname, "..", "..");
  const routeSrc = readFileSync(join(root, "src/app/api/admin/questions/[id]/route.ts"), "utf8");
  const editSrc = readFileSync(join(root, "src/lib/admin-quiz-edit.ts"), "utf8");
  const importsOf = (src: string) =>
    Array.from(src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g), (m) => m[1]);

  it("route は 1 つの $transaction の中で editQuizQuestion を呼び、revisionOf に questionRevision を渡す", () => {
    const m = routeSrc.match(/prisma\.\$transaction\(/g) ?? [];
    assert.equal(m.length, 1, `route の $transaction が 1 か所でない（${m.length}）`);
    assert.match(
      routeSrc,
      /prisma\.\$transaction\(\(tx\)\s*=>\s*editQuizQuestion\(tx,\s*\{\s*id,\s*input,\s*editorId,\s*revisionOf:\s*questionRevision\s*\}\)\)/,
      "route が editQuizQuestion に tx・id・input・editorId・questionRevision を渡していない"
    );
  });

  it("route に問題・履歴・受験記録を直接読み書きする処理が残っていない（二重に持たない）", () => {
    assert.doesNotMatch(routeSrc, /\btx\.(quizQuestion|quizQuestionRevision|quizAttempt)\b/, "route に tx の直接の呼び出しが残っている");
    assert.doesNotMatch(routeSrc, /prisma\.(quizQuestion|quizQuestionRevision|quizAttempt)\./, "route が prisma で直接読み書きしている");
    assert.doesNotMatch(routeSrc, /planQuestionEdit|jsonEquals|JsonNull/, "route に移したはずの処理が残っている");
  });

  it("admin-quiz-edit は渡された tx だけを使う（@/lib/prisma・admin-quiz-revision・node:crypto を import しない）", () => {
    const specs = importsOf(editSrc);
    assert.ok(specs.length > 0, "admin-quiz-edit の import を読めていない");
    for (const s of specs) {
      assert.doesNotMatch(s, /(^|\/)prisma$|@\/lib\/prisma/, `admin-quiz-edit が ${s} を import している`);
      assert.doesNotMatch(s, /admin-quiz-revision/, `admin-quiz-edit が ${s} を import している`);
      assert.doesNotMatch(s, /^(node:)?crypto$/, `admin-quiz-edit が ${s} を import している`);
    }
    assert.doesNotMatch(editSrc, /\$transaction|new PrismaClient/, "admin-quiz-edit が自分でトランザクション・クライアントを作っている");
  });

  it("src の中で admin-quiz-edit を import するのは問題の PATCH の route だけ（画面から import しない）", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(join(root, "src"));
    assert.ok(files.length >= 50, `走査したファイルが ${files.length} 件しかない（走査の前提）`);
    const users = files
      .map((f) => f.slice(root.length + 1).split("\\").join("/"))
      .filter((rel) => importsOf(readFileSync(join(root, rel), "utf8")).some((s) => /admin-quiz-edit/.test(s)))
      .sort();
    assert.deepEqual(users, ["src/app/api/admin/questions/[id]/route.ts"]);
  });
});
