import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// マイグレーション SQL の静的な照合（DB なし。ファイルを読むだけ）。#2 / #5 / #81 Q0
// - テーブルを足すマイグレーションは、同じファイルで RLS を有効にする（FORCE は付けない・ポリシーは作らない）
// - RLS を DISABLE しない。public に関数・ビューを作らない
// - schema.prisma のモデルはすべて、いずれかのマイグレーションで作られ、RLS が有効にされている
// 実際に当てた結果（RLS の状態・anon / authenticated の権限・FK）は、PR の検証で PGlite を使って確かめる。

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

/** コメントを除いた SQL */
function readSql(dir: string): string {
  return readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8").replace(/--.*$/gm, "");
}

function createdTables(sql: string): string[] {
  return Array.from(sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"([^"]+)"/g)).map((m) => m[1]);
}

function rlsEnabledTables(sql: string): string[] {
  return Array.from(sql.matchAll(/ALTER TABLE (?:IF EXISTS )?"([^"]+)" ENABLE ROW LEVEL SECURITY;/g)).map((m) => m[1]);
}

function schemaModels(): string[] {
  const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
  return Array.from(schema.matchAll(/^model (\w+) \{/gm)).map((m) => m[1]);
}

describe("マイグレーション SQL の静的な照合（#2 / #5 / #81 Q0）", () => {
  it("RLS を一括で有効にしたマイグレーションがある（以降の照合の前提）", () => {
    assert.ok(migrationDirs().includes(ENABLE_RLS_MIGRATION));
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
    const forbidden: ReadonlyArray<[RegExp, string]> = [
      [/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i, "RLS の DISABLE"],
      [/FORCE\s+ROW\s+LEVEL\s+SECURITY/i, "FORCE ROW LEVEL SECURITY"],
      [/CREATE\s+POLICY/i, "ポリシー"],
      [/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)/i, "関数"],
      [/CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW/i, "ビュー"],
      [/\bGRANT\b/i, "GRANT"],
    ];
    for (const dir of migrationDirs()) {
      const sql = readSql(dir);
      for (const [re, label] of forbidden) assert.doesNotMatch(sql, re, `${dir} に ${label} がある`);
    }
  });

  it("schema.prisma のモデルはすべて、マイグレーションで作られ、RLS が有効にされている", () => {
    const created = new Set<string>();
    const enabled = new Set<string>();
    for (const dir of migrationDirs()) {
      const sql = readSql(dir);
      createdTables(sql).forEach((t) => created.add(t));
      rlsEnabledTables(sql).forEach((t) => enabled.add(t));
    }
    for (const model of schemaModels()) {
      assert.ok(created.has(model), `${model} を作るマイグレーションがない`);
      assert.ok(enabled.has(model), `${model} の RLS を有効にするマイグレーションがない`);
    }
  });

  it("QuizQuestionRevision は questionId・quizId を FK にしない（問題を消しても履歴を残す）。editorId だけが User への FK（RESTRICT）", () => {
    const dir = migrationDirs().find((d) => d.endsWith("_add_quiz_question_revision"));
    assert.ok(dir, "add_quiz_question_revision のマイグレーションがない");
    const sql = readSql(dir);
    const fks = Array.from(sql.matchAll(/ALTER TABLE "QuizQuestionRevision" ADD CONSTRAINT "([^"]+)" FOREIGN KEY \("([^"]+)"\) REFERENCES "([^"]+)"\("id"\) ON DELETE (\w+)/g)).map(
      (m) => ({ name: m[1], column: m[2], ref: m[3], onDelete: m[4] })
    );
    assert.deepEqual(fks, [{ name: "QuizQuestionRevision_editorId_fkey", column: "editorId", ref: "User", onDelete: "RESTRICT" }]);
    assert.equal((sql.match(/FOREIGN KEY/g) ?? []).length, 1);
  });
});

describe("見えない文字", () => {
  it("このファイルのソースに見えない文字・全角空白を直接書いていない", () => {
    const text = readFileSync(__filename, "utf8");
    assert.doesNotMatch(text, new RegExp("[\\u00A0\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u3000\\uFEFF]", "u"));
  });
});
