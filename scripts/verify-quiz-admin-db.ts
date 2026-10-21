/**
 * 問題の修正（#81 Q1）の DB の処理（src/lib/admin-quiz-edit.ts の editQuizQuestion）を、ローカル DB で実際に実行して確かめる。
 *
 *   npm run db:local:verify-quiz-admin   -> tsx scripts/verify-quiz-admin-db.ts
 *
 * - 最初に <repo>/.env を読み、ローカル DB のガード（assertLocalDatabase）を通す。通らなければ DB に接続せずに終了コード 1
 * - 確かめる 1 件ごとに $transaction の中で実行し、最後に必ずロールバックする（データを残さない）。
 *   終わるたびに、対象の問題と履歴の件数が実行前と同じかも確かめる
 * - 対象は seed の問題（選択肢が 2 件以上の文字列の配列で、正解が範囲内のもののうち [order, id] で最初の 1 件）と、seed の講師
 * - 表示は PASS / FAIL と項目の名前・件数・kind だけ（問題文・選択肢・id・接続先は出さない）。1 つでも FAIL なら終了コード 1
 * - npm test には含めない（npm test は DB に接続しない）
 */

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { Prisma, PrismaClient } from "@prisma/client";

import { assertLocalDatabase } from "./lib/assert-local-db";
import { loadRootEnv } from "./lib/load-env";
import { editQuizQuestion, type EditOutcome } from "../src/lib/admin-quiz-edit";
import { questionRevision } from "../src/lib/admin-quiz-revision";
import { parsePatchQuestionBody, type PatchQuestionInput, type QuestionContent } from "../src/lib/admin-quizzes";
import { normalizeOptions } from "../src/lib/student-quizzes";
import { safeErrorSummary } from "../src/lib/safe-error";

// Read <repo>/.env by path before anything else (not through the generated Prisma Client,
// which may point at another checkout's schema). Variables already set are not overridden;
// .env.local is not read. Nothing from the file is printed.
loadRootEnv(path.resolve(__dirname, ".."));

// Writes (rolled back) to the database: refuse to run against anything but a local database.
// No PrismaClient is created and no query runs before this check. Only the error message is printed.
try {
  assertLocalDatabase([process.env.DATABASE_URL, process.env.DIRECT_URL]);
} catch (err) {
  console.error(err instanceof Error ? err.message : "Refusing to run: local database check failed.");
  process.exit(1);
}

const prisma = new PrismaClient();

type Tx = Prisma.TransactionClient;

const QUESTION_SELECT = { id: true, quizId: true, order: true, question: true, options: true, correctIndex: true } as const;
type QuestionRow = { id: string; quizId: string; order: number; question: string; options: Prisma.JsonValue; correctIndex: number };

type Fixture = { questionId: string; editorId: string };

/** 確かめた結果が違う（理由には項目の名前・件数・kind だけを書く） */
class CheckFailed extends Error {}

/** $transaction を必ずロールバックさせるための印 */
class Rollback extends Error {}

function check(condition: boolean, reason: string): void {
  if (!condition) throw new CheckFailed(reason);
}

async function readQuestion(tx: Tx, id: string): Promise<QuestionRow> {
  const row = await tx.quizQuestion.findUnique({ where: { id }, select: QUESTION_SELECT });
  if (!row) throw new CheckFailed("対象の問題を読めない");
  return row;
}

function contentOf(row: QuestionContent): QuestionContent {
  return { question: row.question, options: row.options, correctIndex: row.correctIndex };
}

function validOptions(row: QuestionRow): string[] {
  const options = normalizeOptions(row.options);
  if (!options) throw new CheckFailed("対象の問題の選択肢が配列でない");
  return options;
}

/** route と同じく parsePatchQuestionBody を通した入力 */
function inputOf(body: Record<string, unknown>): PatchQuestionInput {
  const parsed = parsePatchQuestionBody(body);
  if ("reason" in parsed) throw new CheckFailed(`body が検証を通らない（${parsed.reason}）`);
  return parsed.value;
}

async function revisionIds(tx: Tx, questionId: string): Promise<string[]> {
  const rows = await tx.quizQuestionRevision.findMany({ where: { questionId }, select: { id: true } });
  return rows.map((r) => r.id);
}

function edit(tx: Tx, fx: Fixture, input: PatchQuestionInput): Promise<EditOutcome> {
  return editQuizQuestion(tx, { id: fx.questionId, input, editorId: fx.editorId, revisionOf: questionRevision });
}

function expectKind<K extends EditOutcome["kind"]>(outcome: EditOutcome, kind: K): Extract<EditOutcome, { kind: K }> {
  check(outcome.kind === kind, `kind が ${kind} でなく ${outcome.kind}`);
  return outcome as Extract<EditOutcome, { kind: K }>;
}

/**
 * ok のときの共通の確認：行が after の値になり、履歴がちょうど 1 行増え、changedFields・before・after・editor が合い、
 * 返した row の revision が DB の行の revision と一致し、受験記録の件数が合う
 */
async function expectOkWrite(
  tx: Tx,
  fx: Fixture,
  outcome: EditOutcome,
  before: QuestionRow,
  beforeRevisionIds: string[],
  expected: { changed: string[]; question: string; options: Prisma.JsonValue; correctIndex: number }
): Promise<void> {
  const ok = expectKind(outcome, "ok");
  check(isDeepStrictEqual(ok.changed, expected.changed), `changed が ${JSON.stringify(expected.changed)} でなく ${JSON.stringify(ok.changed)}`);

  const after = await readQuestion(tx, fx.questionId);
  check(after.question === expected.question, "問題文が期待の値でない");
  check(isDeepStrictEqual(after.options, expected.options), "選択肢が期待の値でない");
  check(after.correctIndex === expected.correctIndex, "正解が期待の値でない");
  check(after.order === before.order && after.quizId === before.quizId, "order・quizId が変わった");
  check(questionRevision(contentOf(after)) === questionRevision(contentOf(ok.row)), "返した row の revision が DB の行と違う");

  const ids = await revisionIds(tx, fx.questionId);
  const added = ids.filter((id) => !beforeRevisionIds.includes(id));
  check(ids.length === beforeRevisionIds.length + 1 && added.length === 1, `履歴の増えた件数が 1 でなく ${ids.length - beforeRevisionIds.length}`);
  const rev = await tx.quizQuestionRevision.findUnique({ where: { id: added[0] } });
  if (!rev) throw new CheckFailed("増えた履歴を読めない");
  check(isDeepStrictEqual(rev.changedFields, expected.changed), `changedFields が ${JSON.stringify(expected.changed)} でなく ${JSON.stringify(rev.changedFields)}`);
  check(rev.quizId === before.quizId && rev.editorId === fx.editorId, "履歴の quizId・editorId が違う");
  check(isDeepStrictEqual(rev.before, contentOf(before)), "履歴の before が修正前の値でない");
  check(isDeepStrictEqual(rev.after, { question: expected.question, options: expected.options, correctIndex: expected.correctIndex }), "履歴の after が修正後の値でない");

  const attempts = await tx.quizAttempt.count({ where: { quizId: before.quizId } });
  check(ok.attemptCount === attempts, `attemptCount が ${attempts} でなく ${ok.attemptCount}`);
}

/** conflict・invalid のときの共通の確認：行も履歴も変わっていない */
async function expectNoWrite(tx: Tx, fx: Fixture, snapshot: QuestionRow, snapshotRevisionIds: string[]): Promise<void> {
  const now = await readQuestion(tx, fx.questionId);
  check(isDeepStrictEqual(now, snapshot), "行が変わった");
  const ids = await revisionIds(tx, fx.questionId);
  check(isDeepStrictEqual([...ids].sort(), [...snapshotRevisionIds].sort()), `履歴の件数が ${snapshotRevisionIds.length} から ${ids.length} に変わった`);
}

/**
 * quizQuestion.findUnique だけを差し替えた tx。読んだ時点の値（stale）を返し、そのあとの updateMany の件数を記録する。
 * 「読んでから書くまでに別の講師が直した」を、同じトランザクションの中で再現するため
 */
function staleReadTx(tx: Tx, stale: QuestionRow, updateCounts: number[]): Tx {
  const delegate = tx.quizQuestion;
  const wrapped = new Proxy(delegate, {
    get(target, prop) {
      if (prop === "findUnique") return async () => ({ ...stale });
      if (prop === "updateMany") {
        return async (args: Prisma.QuizQuestionUpdateManyArgs) => {
          const result = await target.updateMany(args);
          updateCounts.push(result.count);
          return result;
        };
      }
      return Reflect.get(target, prop);
    },
  });
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "quizQuestion") return wrapped;
      return Reflect.get(target, prop);
    },
  });
}

type Case = { name: string; run: (tx: Tx, fx: Fixture) => Promise<void> };

const SUFFIX = "（確認）"; // 「（確認）」
const OTHER_SUFFIX = "（別の講師）"; // 「（別の講師）」

const CASES: Case[] = [
  {
    name: "選択肢の文だけを変えると ok・履歴が 1 行・changedFields は [\"options\"]",
    async run(tx, fx) {
      const cur = await readQuestion(tx, fx.questionId);
      const opts = validOptions(cur);
      const next = [...opts.slice(0, -1), opts[opts.length - 1] + SUFFIX];
      const revs = await revisionIds(tx, fx.questionId);
      const out = await edit(tx, fx, inputOf({ revision: questionRevision(contentOf(cur)), options: next }));
      await expectOkWrite(tx, fx, out, cur, revs, { changed: ["options"], question: cur.question, options: next, correctIndex: cur.correctIndex });
    },
  },
  {
    name: "正解だけを変えると ok・changedFields は [\"correctIndex\"]",
    async run(tx, fx) {
      const cur = await readQuestion(tx, fx.questionId);
      const opts = validOptions(cur);
      const nextIndex = (cur.correctIndex + 1) % opts.length;
      const revs = await revisionIds(tx, fx.questionId);
      const out = await edit(tx, fx, inputOf({ revision: questionRevision(contentOf(cur)), correctIndex: nextIndex }));
      await expectOkWrite(tx, fx, out, cur, revs, { changed: ["correctIndex"], question: cur.question, options: cur.options, correctIndex: nextIndex });
    },
  },
  {
    name: "問題文だけを変えると ok・changedFields は [\"question\"]",
    async run(tx, fx) {
      const cur = await readQuestion(tx, fx.questionId);
      const nextQuestion = cur.question + SUFFIX;
      const revs = await revisionIds(tx, fx.questionId);
      const out = await edit(tx, fx, inputOf({ revision: questionRevision(contentOf(cur)), question: nextQuestion }));
      await expectOkWrite(tx, fx, out, cur, revs, { changed: ["question"], question: nextQuestion, options: cur.options, correctIndex: cur.correctIndex });
    },
  },
  {
    name: "古い revision を送ると conflict・行も履歴も変わらない",
    async run(tx, fx) {
      const first = await readQuestion(tx, fx.questionId);
      const oldRevision = questionRevision(contentOf(first));
      // 1 回目の修正（ok）で revision を進める
      expectKind(await edit(tx, fx, inputOf({ revision: oldRevision, question: first.question + SUFFIX })), "ok");
      const snapshot = await readQuestion(tx, fx.questionId);
      const revs = await revisionIds(tx, fx.questionId);
      // 1 回目より前の revision で、別の項目を直そうとする
      const opts = validOptions(snapshot);
      const out = await edit(tx, fx, inputOf({ revision: oldRevision, correctIndex: (snapshot.correctIndex + 1) % opts.length }));
      expectKind(out, "conflict");
      await expectNoWrite(tx, fx, snapshot, revs);
    },
  },
  {
    name: "読んだあとに選択肢が書き換わっている（先に書き換えてから関数を呼ぶ）と conflict・行も履歴も変わらない",
    async run(tx, fx) {
      const read = await readQuestion(tx, fx.questionId);
      const opts = validOptions(read);
      // 別の講師の書き込み（履歴は書かない、生の更新）
      await tx.quizQuestion.update({ where: { id: fx.questionId }, data: { options: [...opts.slice(0, -1), opts[opts.length - 1] + OTHER_SUFFIX] } });
      const snapshot = await readQuestion(tx, fx.questionId);
      const revs = await revisionIds(tx, fx.questionId);
      const out = await edit(tx, fx, inputOf({ revision: questionRevision(contentOf(read)), correctIndex: (read.correctIndex + 1) % opts.length }));
      expectKind(out, "conflict");
      await expectNoWrite(tx, fx, snapshot, revs);
    },
  },
  {
    name: "読んでから updateMany までの割り込みは conflict（updateMany の条件が 0 件）・行も履歴も変わらない",
    async run(tx, fx) {
      const stale = await readQuestion(tx, fx.questionId);
      const opts = validOptions(stale);
      // 関数が読んだ値は stale のまま、DB の選択肢だけを先に書き換える（並びも文も同じ件数で、文だけが違う）
      await tx.quizQuestion.update({ where: { id: fx.questionId }, data: { options: [...opts.slice(0, -1), opts[opts.length - 1] + OTHER_SUFFIX] } });
      const snapshot = await readQuestion(tx, fx.questionId);
      const revs = await revisionIds(tx, fx.questionId);
      const counts: number[] = [];
      const out = await editQuizQuestion(staleReadTx(tx, stale, counts), {
        id: fx.questionId,
        input: inputOf({ revision: questionRevision(contentOf(stale)), correctIndex: (stale.correctIndex + 1) % opts.length }),
        editorId: fx.editorId,
        revisionOf: questionRevision,
      });
      expectKind(out, "conflict");
      check(isDeepStrictEqual(counts, [0]), `updateMany の件数が [0] でなく ${JSON.stringify(counts)}`);
      await expectNoWrite(tx, fx, snapshot, revs);
    },
  },
  {
    name: "options が JSON の null の行でも updateMany の条件が一致する（ok・履歴の before.options は null）",
    async run(tx, fx) {
      await tx.quizQuestion.update({ where: { id: fx.questionId }, data: { options: Prisma.JsonNull } });
      const cur = await readQuestion(tx, fx.questionId);
      check(cur.options === null, "options を JSON の null にできていない");
      const next = ["確認 A", "確認 B"]; // 「確認 A」「確認 B」
      const nextIndex = cur.correctIndex === 0 ? 1 : 0;
      const revs = await revisionIds(tx, fx.questionId);
      const out = await edit(tx, fx, inputOf({ revision: questionRevision(contentOf(cur)), options: next, correctIndex: nextIndex }));
      await expectOkWrite(tx, fx, out, cur, revs, { changed: ["options", "correctIndex"], question: cur.question, options: next, correctIndex: nextIndex });
    },
  },
  {
    name: "変更がないときは invalid（no_changes）・履歴を書かない",
    async run(tx, fx) {
      const cur = await readQuestion(tx, fx.questionId);
      const revs = await revisionIds(tx, fx.questionId);
      const out = await edit(
        tx,
        fx,
        inputOf({ revision: questionRevision(contentOf(cur)), question: cur.question, options: validOptions(cur), correctIndex: cur.correctIndex })
      );
      const invalid = expectKind(out, "invalid");
      check(invalid.reason === "no_changes", `reason が no_changes でなく ${invalid.reason}`);
      await expectNoWrite(tx, fx, cur, revs);
    },
  },
];

function describeError(err: unknown): string {
  if (err instanceof CheckFailed) return err.message;
  const s = safeErrorSummary(err);
  return `エラー（${s.name}${s.code ? ` ${s.code}` : ""}）`;
}

/** 1 件を $transaction の中で実行し、必ずロールバックする。終わったら対象の行と履歴の件数が元に戻ったかを確かめる */
async function runCase(c: Case, fx: Fixture, baseline: { row: QuestionRow; revisionCount: number }): Promise<string | null> {
  let failure: string | null = null;
  try {
    await prisma.$transaction(
      async (tx) => {
        try {
          await c.run(tx, fx);
        } catch (err) {
          failure = describeError(err);
        }
        throw new Rollback();
      },
      { timeout: 30_000 }
    );
    failure = failure ?? "ロールバックされなかった";
  } catch (err) {
    if (!(err instanceof Rollback)) failure = failure ?? describeError(err);
  }

  const row = await prisma.quizQuestion.findUnique({ where: { id: fx.questionId }, select: QUESTION_SELECT });
  const revisionCount = await prisma.quizQuestionRevision.count();
  if (!isDeepStrictEqual(row, baseline.row) || revisionCount !== baseline.revisionCount) {
    failure = `${failure ? `${failure}。` : ""}ロールバック後に行または履歴が元に戻っていない`;
  }
  return failure;
}

async function loadFixture(): Promise<Fixture | null> {
  const editor = await prisma.user.findFirst({ where: { role: "INSTRUCTOR" }, orderBy: { id: "asc" }, select: { id: true } });
  const questions = await prisma.quizQuestion.findMany({ orderBy: [{ order: "asc" }, { id: "asc" }], select: QUESTION_SELECT });
  const target = questions.find((q) => {
    const opts = normalizeOptions(q.options);
    return opts !== null && Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < opts.length;
  });
  if (!editor || !target) return null;
  return { questionId: target.id, editorId: editor.id };
}

async function main(): Promise<number> {
  const fx = await loadFixture();
  if (!fx) {
    console.log("FAIL 準備: seed の講師または問題が見つからない（db:local:reset で seed を入れ直すかを Tec に確認する）");
    return 1;
  }
  const row = await prisma.quizQuestion.findUnique({ where: { id: fx.questionId }, select: QUESTION_SELECT });
  if (!row) {
    console.log("FAIL 準備: 対象の問題を読めない");
    return 1;
  }
  const baseline = { row, revisionCount: await prisma.quizQuestionRevision.count() };

  let failed = 0;
  for (const c of CASES) {
    const failure = await runCase(c, fx, baseline);
    if (failure === null) {
      console.log(`PASS ${c.name}`);
    } else {
      failed += 1;
      console.log(`FAIL ${c.name}: ${failure}`);
    }
  }
  console.log(`${CASES.length} 件中 ${CASES.length - failed} 件 PASS`);
  return failed === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.log(`FAIL 実行: ${describeError(err)}`);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
