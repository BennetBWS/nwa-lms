import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// マイグレーション SQL の静的な照合（DB なし。ファイルを読むだけ）。#2 / #5 / #81 Q0
// - テーブルを足すマイグレーションは、同じファイルで RLS を有効にする（FORCE は付けない・ポリシーは作らない）
// - RLS を DISABLE しない。public に関数・ビューを作らない
// - schema.prisma のモデルはすべて、いずれかのマイグレーションで作られ、RLS が有効にされている
// 実際に当てた結果（RLS の状態・anon / authenticated の権限・FK）は、PR の検証で PGlite を使って確かめる。
//
// 検出器は大文字・小文字、改行・連続した空白、引用符のない名前（Postgres と同じく小文字に畳む）、
// スキーマ修飾（public. は外す）、IF NOT EXISTS / IF EXISTS / ONLY、UNLOGGED・TEMP を扱う。
// コメント（-- と /* */）は除いてから照合する。既知の限界：文字列リテラルの中の -- や /* もコメントとして
// 扱う（その行の残りを見落とす）。CREATE TABLE ... AS・SELECT INTO・動的 SQL で作るテーブルは検出しない。
// 検出器の単体テストは、このファイルの「検出器」の describe にある。

const ROOT = join(__dirname, "..", "..");
const MIGRATIONS = join(ROOT, "prisma", "migrations");
/** これより前のマイグレーション（init など）は、この中でまとめて RLS を有効にした */
const ENABLE_RLS_MIGRATION = "20260924050214_enable_rls";

function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** コメント（ブロックコメントと行コメント）を除いた SQL */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, "");
}

function rawSql(dir: string): string {
  return readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8");
}

/** コメントを除いた SQL */
function readSql(dir: string): string {
  return stripComments(rawSql(dir));
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`;

/** 識別子を Postgres と同じ規則で正規化する（引用符付きはそのまま、引用符なしは小文字）。public. は外す */
function tableKey(qualified: string): string {
  const parts = (qualified.match(new RegExp(IDENT, "g")) ?? []).map((p) =>
    p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p.toLowerCase()
  );
  if (parts.length === 2 && parts[0] === "public") return parts[1];
  return parts.join(".");
}

function createdTables(sql: string): string[] {
  const re = new RegExp(
    String.raw`\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMPORARY|TEMP|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})`,
    "gi"
  );
  return Array.from(stripComments(sql).matchAll(re)).map((m) => tableKey(m[1]));
}

function rlsEnabledTables(sql: string): string[] {
  const re = new RegExp(
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\b`,
    "gi"
  );
  return Array.from(stripComments(sql).matchAll(re)).map((m) => tableKey(m[1]));
}

type ForeignKey = { table: string; name: string; columns: string; ref: string; onDelete: string };

/** ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES ...（改行・小文字を許す）。ON DELETE がなければ NO ACTION */
function foreignKeys(sql: string): ForeignKey[] {
  const re = new RegExp(
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s+ADD\s+CONSTRAINT\s+(${IDENT})\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(${QUALIFIED})\s*\([^)]*\)([^;]*);`,
    "gi"
  );
  return Array.from(stripComments(sql).matchAll(re)).map((m) => {
    const onDelete = /\bON\s+DELETE\s+(RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)\b/i.exec(m[5]);
    return {
      table: tableKey(m[1]),
      name: tableKey(m[2]),
      columns: m[3].split(",").map((c) => tableKey(c.trim())).join(","),
      ref: tableKey(m[4]),
      onDelete: onDelete ? onDelete[1].toUpperCase().replace(/\s+/g, " ") : "NO ACTION",
    };
  });
}

/** 外部キーになりうる記述の数（列に直接書いた REFERENCES も数える） */
function referencesCount(sql: string): number {
  return (stripComments(sql).match(/\bREFERENCES\b/gi) ?? []).length;
}

const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i, "RLS の DISABLE"],
  [/\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i, "FORCE ROW LEVEL SECURITY"],
  [/\bCREATE\s+POLICY\b/i, "ポリシー"],
  [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i, "関数"],
  [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY)\s+)?(?:RECURSIVE\s+)?(?:MATERIALIZED\s+)?VIEW\b/i, "ビュー"],
  // GRANT は一律に禁止（#2）。将来 GRANT が必要になったら、Tec の承認を取ってからこのテストを更新する
  [/\bGRANT\b/i, "GRANT"],
];

function forbiddenFound(sql: string): string[] {
  const body = stripComments(sql);
  return FORBIDDEN.filter(([re]) => re.test(body)).map(([, label]) => label);
}

const REVISION_MIGRATION_SUFFIX = "_add_quiz_question_revision";
const CHANGED_FIELDS_CHECK = "QuizQuestionRevision_changedFields_check";

/**
 * changedFields の CHECK（#81 Q0）を消しうる記述。文（; で区切る）ごとに見る。
 * - CHECK の DROP CONSTRAINT（どのテーブルに対しても）
 * - "QuizQuestionRevision" の "changedFields" の DROP COLUMN
 * - "QuizQuestionRevision" の "changedFields" の ALTER COLUMN ... TYPE（SET DATA TYPE を含む）
 */
function changedFieldsCheckThreats(sql: string): string[] {
  const found: string[] = [];
  const col = String.raw`(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${IDENT})`;
  for (const stmt of stripComments(sql).split(";")) {
    const drop = new RegExp(String.raw`\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${IDENT})`, "gi");
    for (const m of Array.from(stmt.matchAll(drop))) {
      if (tableKey(m[1]) === CHANGED_FIELDS_CHECK) found.push("DROP CONSTRAINT");
    }
    const alter = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})`, "i").exec(stmt);
    if (!alter || tableKey(alter[1]) !== "QuizQuestionRevision") continue;
    for (const m of Array.from(stmt.matchAll(new RegExp(String.raw`\bDROP\s+${col}`, "gi")))) {
      if (tableKey(m[1]) === "changedFields") found.push("DROP COLUMN");
    }
    for (const m of Array.from(stmt.matchAll(new RegExp(String.raw`\bALTER\s+${col}\s+(?:SET\s+DATA\s+)?TYPE\b`, "gi")))) {
      if (tableKey(m[1]) === "changedFields") found.push("ALTER COLUMN TYPE");
    }
  }
  return found;
}

function schemaModels(): string[] {
  const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
  return Array.from(schema.matchAll(/^model (\w+) \{/gm)).map((m) => m[1]);
}

describe("マイグレーション SQL の静的な照合（#2 / #5 / #81 Q0）", () => {
  it("RLS を一括で有効にしたマイグレーションがある（以降の照合の前提）", () => {
    assert.ok(migrationDirs().includes(ENABLE_RLS_MIGRATION), `${ENABLE_RLS_MIGRATION} がない`);
  });

  it("どのマイグレーションの SQL も検出器で読める（CREATE TABLE と RLS の有効化の取りこぼしがない）", () => {
    // 正規化前の素朴な数え方と、検出器の件数が一致すること（検出器が読めない書き方が紛れ込んだら落ちる）
    for (const dir of migrationDirs()) {
      const sql = readSql(dir);
      const naiveCreate = (sql.match(/\bCREATE\b[^;]*?\bTABLE\b/gi) ?? []).length;
      const naiveEnable = (sql.match(/\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/gi) ?? []).length;
      assert.equal(createdTables(sql).length, naiveCreate, `${dir}: CREATE TABLE の数と検出器の結果が違う`);
      assert.equal(rlsEnabledTables(sql).length, naiveEnable, `${dir}: ENABLE ROW LEVEL SECURITY の数と検出器の結果が違う`);
    }
  });

  it("RLS を一括で有効にした後にテーブルを作るマイグレーションは、同じファイルで RLS を有効にしている", () => {
    for (const dir of migrationDirs().filter((d) => d > ENABLE_RLS_MIGRATION)) {
      const sql = readSql(dir);
      const enabled = rlsEnabledTables(sql);
      for (const table of createdTables(sql)) {
        assert.ok(enabled.includes(table), `${dir}: "${table}" を作っているが、同じファイルで RLS を有効にしていない`);
      }
    }
  });

  it("どのマイグレーションも RLS の DISABLE・FORCE・ポリシー・public の関数とビュー・GRANT を含まない", () => {
    for (const dir of migrationDirs()) {
      assert.deepEqual(forbiddenFound(rawSql(dir)), [], `${dir} に禁止された記述がある`);
    }
  });

  it("どのマイグレーションの SQL にも見えない文字・全角空白がない（識別子に紛れると別名のテーブルになる）", () => {
    for (const dir of migrationDirs()) {
      assert.doesNotMatch(rawSql(dir), new RegExp("[\\u00A0\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u3000\\uFEFF]", "u"), `${dir} に見えない文字がある`);
    }
  });

  it("schema.prisma は @@map・@@schema を使っていない（モデル名 = テーブル名を前提に照合している）", () => {
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
    assert.doesNotMatch(schema, /@@map\s*\(|@@schema\s*\(/, "@@map / @@schema を使うなら、この照合をテーブル名で行うように直す");
  });

  it("schema.prisma のモデルはすべて、マイグレーションで作られ、RLS が有効にされている", () => {
    const created = new Set<string>();
    const enabled = new Set<string>();
    for (const dir of migrationDirs()) {
      const sql = readSql(dir);
      createdTables(sql).forEach((t) => created.add(t));
      rlsEnabledTables(sql).forEach((t) => enabled.add(t));
    }
    const models = schemaModels();
    assert.ok(models.includes("QuizQuestionRevision"), "schema.prisma に QuizQuestionRevision がある");
    for (const model of models) {
      assert.ok(created.has(model), `${model} を作るマイグレーションがない`);
      assert.ok(enabled.has(model), `${model} の RLS を有効にするマイグレーションがない`);
    }
  });

  it("QuizQuestionRevision は questionId・quizId を FK にしない（問題を消しても履歴を残す）。editorId だけが User への FK（RESTRICT）", () => {
    const dir = migrationDirs().find((d) => d.endsWith("_add_quiz_question_revision"));
    assert.ok(dir, "add_quiz_question_revision のマイグレーションがない");
    const sql = readSql(dir);
    assert.deepEqual(foreignKeys(sql), [
      { table: "QuizQuestionRevision", name: "QuizQuestionRevision_editorId_fkey", columns: "editorId", ref: "User", onDelete: "RESTRICT" },
    ]);
    // 列に直接書いた REFERENCES（CREATE TABLE の中の FK）も含めて 1 つだけ
    assert.equal(referencesCount(sql), 1, "REFERENCES は editorId の 1 つだけ");
    assert.equal((sql.match(/\bFOREIGN\s+KEY\b/gi) ?? []).length, 1, "FOREIGN KEY は 1 つだけ");
  });

  it("QuizQuestionRevision のマイグレーションは追加だけ（既存のテーブル・データを変えない）", () => {
    const dir = migrationDirs().find((d) => d.endsWith("_add_quiz_question_revision"));
    assert.ok(dir, "add_quiz_question_revision のマイグレーションがない");
    const sql = readSql(dir);
    assert.deepEqual(createdTables(sql), ["QuizQuestionRevision"], "作るテーブルは QuizQuestionRevision だけ");
    const withoutFkRules = sql.replace(/\bON\s+(?:UPDATE|DELETE)\b/gi, " ");
    assert.doesNotMatch(withoutFkRules, /\b(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT|RENAME)\b/i, "DROP・TRUNCATE・DELETE・UPDATE・INSERT・RENAME を含まない（FK の ON UPDATE / ON DELETE は除く）");
    const altered = Array.from(sql.matchAll(new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})`, "gi"))).map((m) => tableKey(m[1]));
    assert.ok(altered.length > 0 && altered.every((t) => t === "QuizQuestionRevision"), `ALTER TABLE は新しいテーブルだけ: ${altered.join(", ")}`);
    // User.id の変更には追従する（ON UPDATE CASCADE）
    assert.match(sql, /\bON\s+UPDATE\s+CASCADE\b/i, "editorId は ON UPDATE CASCADE");
  });

  it("QuizQuestionRevision の changedFields は CHECK 制約で NULL と空配列を拒否する（承認済みの設計は TEXT[] NOT NULL）", () => {
    // 列は Prisma の生成どおり NULL 可（String[] → TEXT[]）。意図は CHECK で守る。
    // Prisma 6 は CHECK 制約を schema.prisma で表せず、マイグレーションでも管理しないため、schema との照合では検出できない。
    // ここで固定し、手で消されたら落とす。ALTER TABLE の対象は新しいテーブルだけ（上の「追加だけ」の検査）と矛盾しない。
    const dir = migrationDirs().find((d) => d.endsWith("_add_quiz_question_revision"));
    assert.ok(dir, "add_quiz_question_revision のマイグレーションがない");
    const sql = readSql(dir).replace(/\s+/g, " ");
    assert.ok(
      sql.includes(
        'ALTER TABLE "QuizQuestionRevision" ADD CONSTRAINT "QuizQuestionRevision_changedFields_check" CHECK ("changedFields" IS NOT NULL AND cardinality("changedFields") > 0);'
      ),
      "QuizQuestionRevision_changedFields_check（IS NOT NULL かつ cardinality > 0）がない"
    );
    assert.equal((sql.match(/\bCHECK\b/gi) ?? []).length, 1, "CHECK は changedFields の 1 つだけ");
    assert.ok(/"changedFields" TEXT\[\],/.test(sql), "changedFields の列定義は Prisma の生成どおり TEXT[]（NOT NULL なし）");
  });

  it("Q0 より後のマイグレーションは、changedFields の CHECK を消しうる変更をしない（DROP CONSTRAINT・DROP COLUMN・ALTER COLUMN TYPE）", () => {
    // 列を作り直したり型を変えたりすると、CHECK も一緒に消える（または消す必要がある）。
    // これらを含むマイグレーションでは、同じファイルで CHECK を追加し直し、このテストを更新する。
    const dir = migrationDirs().find((d) => d.endsWith(REVISION_MIGRATION_SUFFIX));
    assert.ok(dir, "add_quiz_question_revision のマイグレーションがない");
    for (const later of migrationDirs().filter((d) => d > dir)) {
      assert.deepEqual(changedFieldsCheckThreats(rawSql(later)), [], `${later} が ${CHANGED_FIELDS_CHECK} を消しうる`);
    }
    // Q0 自身は CHECK を足すだけ
    assert.deepEqual(changedFieldsCheckThreats(rawSql(dir)), [], `${dir} は CHECK を消しうる記述を含まない`);
  });

  it("QuizQuestionRevision の migration.sql と schema.prisma のモデルの列が一致する", () => {
    const dir = migrationDirs().find((d) => d.endsWith("_add_quiz_question_revision"));
    assert.ok(dir, "add_quiz_question_revision のマイグレーションがない");
    const sql = readSql(dir);
    const body = /CREATE\s+TABLE\s+"QuizQuestionRevision"\s*\(([\s\S]*?)\n\);/i.exec(sql);
    assert.ok(body, "CREATE TABLE の本体が読める");
    const sqlCols = Array.from(body[1].matchAll(/^\s*"(\w+)"\s/gm)).map((m) => m[1]).sort();
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
    const model = /^model QuizQuestionRevision \{([\s\S]*?)^\}/m.exec(schema);
    assert.ok(model, "schema.prisma に model QuizQuestionRevision がある");
    // 型は String・Json・DateTime・Int・Boolean に絞っている。enum や Float などの列を足すと、
    // ここで拾えずに列の集合が一致しなくなり落ちる（そのときは型の一覧を足す）
    const scalar = Array.from(model[1].matchAll(/^\s+(\w+)\s+(\w+)(\[\])?(\?)?/gm))
      .filter((m) => ["String", "Json", "DateTime", "Int", "Boolean"].includes(m[2]))
      .map((m) => m[1])
      .sort();
    assert.deepEqual(sqlCols, scalar, "列の集合が一致する");
  });
});

describe("マイグレーションの検出器（取りこぼし・誤検出）", () => {
  it("createdTables：IF NOT EXISTS・引用符なし（小文字に畳む）・スキーマ修飾・改行・UNLOGGED・TEMP・小文字の SQL を読む", () => {
    const sql = [
      'CREATE TABLE IF NOT EXISTS "A" (id text);',
      "create table b (id text);",
      'CREATE TABLE public."C" (id text);',
      'CREATE TABLE "public"."D" (id text);',
      'CREATE UNLOGGED TABLE "E" (id text);',
      "CREATE TABLE\n  \"F\"\n(id text);",
      "Create Temp Table G (id text);",
      "CREATE TABLE MixedCase (id text);",
      'CREATE TABLE other."H" (id text);',
      'create table if not exists "with""quote" (id text);',
    ].join("\n");
    assert.deepEqual(createdTables(sql), ["A", "b", "C", "D", "E", "F", "g", "mixedcase", "other.H", 'with"quote']);
  });

  it("createdTables：コメントの中・CREATE INDEX・CREATE TABLESPACE・ALTER TABLE は数えない", () => {
    const sql = [
      '-- CREATE TABLE "X" (id text);',
      '/* CREATE TABLE "Y" (id text);',
      '   CREATE TABLE "Y2" (id text); */',
      'CREATE INDEX "i" ON "Z"("id");',
      "CREATE TABLESPACE ts LOCATION '/x';",
      'ALTER TABLE "W" ADD COLUMN "c" TEXT;',
    ].join("\n");
    assert.deepEqual(createdTables(sql), []);
  });

  it("rlsEnabledTables：ONLY・IF EXISTS・引用符なし・小文字・改行と連続した空白を読む", () => {
    const sql = [
      'ALTER TABLE ONLY "A" ENABLE ROW LEVEL SECURITY;',
      "alter table b enable row level security;",
      'ALTER TABLE IF EXISTS public."C"\n  ENABLE   ROW\tLEVEL SECURITY;',
      'ALTER TABLE IF EXISTS ONLY "D" ENABLE ROW LEVEL SECURITY;',
    ].join("\n");
    assert.deepEqual(rlsEnabledTables(sql), ["A", "b", "C", "D"]);
  });

  it("rlsEnabledTables：DISABLE・FORCE・NO FORCE・コメントの中は有効化として数えない", () => {
    const sql = [
      'ALTER TABLE "A" DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE "B" FORCE ROW LEVEL SECURITY;',
      'ALTER TABLE "C" NO FORCE ROW LEVEL SECURITY;',
      '-- ALTER TABLE "D" ENABLE ROW LEVEL SECURITY;',
      '/* ALTER TABLE "E" ENABLE ROW LEVEL SECURITY; */',
    ].join("\n");
    assert.deepEqual(rlsEnabledTables(sql), []);
  });

  it("引用符付きの名前と引用符なしの名前は区別する（\"Foo\" を作って Foo を有効にしても、有効にしたことにならない）", () => {
    const sql = 'CREATE TABLE "Foo" (id text);\nALTER TABLE Foo ENABLE ROW LEVEL SECURITY;';
    const enabled = rlsEnabledTables(sql);
    assert.deepEqual(createdTables(sql).filter((t) => !enabled.includes(t)), ["Foo"]);
  });

  it("forbiddenFound：小文字・改行・EXECUTE の文字列の中の DISABLE も見つける", () => {
    assert.deepEqual(forbiddenFound("alter table x disable row level security;"), ["RLS の DISABLE"]);
    assert.deepEqual(forbiddenFound('ALTER TABLE ONLY "X"\n  DISABLE\n  ROW LEVEL SECURITY;'), ["RLS の DISABLE"]);
    assert.deepEqual(forbiddenFound("DO $$ BEGIN EXECUTE 'ALTER TABLE x DISABLE ROW LEVEL SECURITY'; END $$;"), ["RLS の DISABLE"]);
    assert.deepEqual(forbiddenFound('alter table "X" force row level security;'), ["FORCE ROW LEVEL SECURITY"]);
    assert.deepEqual(forbiddenFound('create policy p on "X" for select using (true);'), ["ポリシー"]);
    assert.deepEqual(forbiddenFound("create or replace function public.f() returns int as $$ select 1 $$ language sql;"), ["関数"]);
    assert.deepEqual(forbiddenFound("CREATE PROCEDURE p() LANGUAGE sql AS $$ $$;"), ["関数"]);
    assert.deepEqual(forbiddenFound("create view v as select 1;"), ["ビュー"]);
    assert.deepEqual(forbiddenFound("CREATE OR REPLACE TEMP VIEW v AS SELECT 1;"), ["ビュー"]);
    assert.deepEqual(forbiddenFound("CREATE MATERIALIZED VIEW mv AS SELECT 1;"), ["ビュー"]);
    assert.deepEqual(forbiddenFound("grant select on all tables in schema public to anon;"), ["GRANT"]);
  });

  it("forbiddenFound：行コメント・ブロックコメントの中は誤検出しない。REVOKE・ENABLE は禁止しない", () => {
    assert.deepEqual(forbiddenFound("-- RLS を DISABLE ROW LEVEL SECURITY しない\nSELECT 1;"), []);
    assert.deepEqual(forbiddenFound("/* never DISABLE ROW LEVEL SECURITY\n or CREATE VIEW */ SELECT 1;"), []);
    assert.deepEqual(forbiddenFound("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;"), []);
    assert.deepEqual(forbiddenFound('ALTER TABLE "X" ENABLE ROW LEVEL SECURITY;'), []);
    assert.deepEqual(forbiddenFound('CREATE TABLE "Viewer" ("disabled" BOOLEAN, "granted" BOOLEAN);'), []);
  });

  it("foreignKeys：改行の入った FK・小文字・ONLY・ON DELETE の省略（NO ACTION）・SET NULL を読む", () => {
    const sql = [
      'ALTER TABLE "R" ADD CONSTRAINT "R_a_fkey"',
      '    FOREIGN KEY ("a") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
      'alter table only "R" add constraint "R_b_fkey" foreign key ("b") references "Quiz"("id");',
      'ALTER TABLE "R" ADD CONSTRAINT "R_c_fkey" FOREIGN KEY ("c") REFERENCES public."QuizQuestion" ("id") ON UPDATE CASCADE ON DELETE SET  NULL;',
    ].join("\n");
    assert.deepEqual(foreignKeys(sql), [
      { table: "R", name: "R_a_fkey", columns: "a", ref: "User", onDelete: "RESTRICT" },
      { table: "R", name: "R_b_fkey", columns: "b", ref: "Quiz", onDelete: "NO ACTION" },
      { table: "R", name: "R_c_fkey", columns: "c", ref: "QuizQuestion", onDelete: "SET NULL" },
    ]);
  });

  it("referencesCount：CREATE TABLE の列に直接書いた REFERENCES も数え、コメントの中は数えない", () => {
    const sql = [
      'CREATE TABLE "R" ("quizId" TEXT NOT NULL references "Quiz"("id"), "x" TEXT);',
      '-- "questionId" REFERENCES "QuizQuestion"',
      'ALTER TABLE "R" ADD CONSTRAINT "f" FOREIGN KEY ("e") REFERENCES "User"("id");',
    ].join("\n");
    assert.equal(referencesCount(sql), 2);
  });
  it("changedFieldsCheckThreats：CHECK の DROP CONSTRAINT・changedFields の DROP COLUMN・ALTER COLUMN TYPE を見つける", () => {
    assert.deepEqual(changedFieldsCheckThreats('ALTER TABLE "QuizQuestionRevision" DROP CONSTRAINT "QuizQuestionRevision_changedFields_check";'), ["DROP CONSTRAINT"]);
    assert.deepEqual(changedFieldsCheckThreats('alter table public."QuizQuestionRevision"\n  drop constraint if exists "QuizQuestionRevision_changedFields_check";'), ["DROP CONSTRAINT"]);
    assert.deepEqual(changedFieldsCheckThreats('ALTER TABLE "QuizQuestionRevision" DROP COLUMN "changedFields";'), ["DROP COLUMN"]);
    assert.deepEqual(changedFieldsCheckThreats('ALTER TABLE "QuizQuestionRevision" ADD COLUMN "x" TEXT, DROP "changedFields";'), ["DROP COLUMN"]);
    assert.deepEqual(changedFieldsCheckThreats('ALTER TABLE "QuizQuestionRevision" ALTER COLUMN "changedFields" TYPE JSONB USING to_jsonb("changedFields");'), ["ALTER COLUMN TYPE"]);
    assert.deepEqual(changedFieldsCheckThreats('ALTER TABLE ONLY "QuizQuestionRevision" ALTER "changedFields" SET DATA TYPE TEXT;'), ["ALTER COLUMN TYPE"]);
  });

  it("changedFieldsCheckThreats：別のテーブル・別の列・別の制約・コメントの中・NOT NULL の追加は数えない", () => {
    assert.deepEqual(changedFieldsCheckThreats('ALTER TABLE "Quiz" DROP COLUMN "changedFields";'), []);
    assert.deepEqual(changedFieldsCheckThreats('ALTER TABLE "QuizQuestionRevision" DROP COLUMN "before";'), []);
    assert.deepEqual(changedFieldsCheckThreats('ALTER TABLE "QuizQuestionRevision" DROP CONSTRAINT "QuizQuestionRevision_editorId_fkey";'), []);
    assert.deepEqual(changedFieldsCheckThreats('-- ALTER TABLE "QuizQuestionRevision" DROP COLUMN "changedFields";'), []);
    assert.deepEqual(changedFieldsCheckThreats('ALTER TABLE "QuizQuestionRevision" ALTER COLUMN "changedFields" SET NOT NULL;'), []);
    assert.deepEqual(changedFieldsCheckThreats('ALTER TABLE "QuizQuestionRevision" ALTER COLUMN "after" TYPE JSONB;'), []);
  });
});

describe("見えない文字", () => {
  it("このファイルのソースに見えない文字・全角空白を直接書いていない", () => {
    const text = readFileSync(__filename, "utf8");
    assert.doesNotMatch(text, new RegExp("[\\u00A0\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u3000\\uFEFF]", "u"));
  });
});
