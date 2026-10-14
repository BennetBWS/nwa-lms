import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCKED_LESSON_VISIBLE_FIELDS } from "./lesson-access";

// #47 P4 ロック中のコースのレッスンに出す項目を、prisma/schema.prisma の Lesson の列と照合する（DB なし。ソースを読むだけ）。
// GET /api/courses は Lesson を include で全列読み、ロック中のコースでは hideLockedLessonContent で許可リストの項目だけにする。
// Lesson に列を足したら、このテストが落ちる。ロック中に出してよいか（本文・動画・資料に当たらないか）を決め、
// 出すなら lesson-access.ts の LOCKED_LESSON_VISIBLE_FIELDS に、出さないなら下の HIDDEN_WHEN_LOCKED に足す。

/** ロック中には出さない Lesson の項目（本文・動画・資料と、include していないリレーション） */
const HIDDEN_WHEN_LOCKED = ["videoUrl", "content", "pdfUrl", "section", "progress", "comments", "quizzes"];

/** 応答で足す項目（Lesson の列ではない） */
const ADDED_BY_ROUTE = ["completed"];

/** schema.prisma の Lesson の列（今の状態を固定する） */
const LESSON_FIELDS = ["id", "sectionId", "section", "title", "type", "videoUrl", "content", "pdfUrl", "duration", "order", "progress", "comments", "quizzes"];

function lessonFieldsInSchema(): string[] {
  const schema = readFileSync(join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
  const m = schema.match(/^model Lesson \{\n([\s\S]*?)^\}/m);
  assert.ok(m, "schema.prisma に model Lesson が見つからない");
  return m[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line !== "" && !line.startsWith("@@"))
    .map((line) => line.split(/\s+/)[0]);
}

describe("ロック中のコースのレッスンに出す項目と、schema.prisma の Lesson の列（#47 P4）", () => {
  it("Lesson の列が固定した一覧と同じ（列を足したら、ロック中に出すかを決めて一覧を直す）", () => {
    assert.deepEqual(
      lessonFieldsInSchema(),
      LESSON_FIELDS,
      "Lesson の列が変わった。ロック中に出すかを決め、LOCKED_LESSON_VISIBLE_FIELDS か HIDDEN_WHEN_LOCKED に入れてから LESSON_FIELDS を直す"
    );
  });

  it("Lesson のどの列も、出す・出さないのどちらか一方に入っている", () => {
    const visible: ReadonlyArray<string> = LOCKED_LESSON_VISIBLE_FIELDS;
    for (const f of lessonFieldsInSchema()) {
      const inVisible = visible.includes(f);
      const inHidden = HIDDEN_WHEN_LOCKED.includes(f);
      assert.ok(inVisible !== inHidden, `Lesson.${f} をロック中に出すかが決まっていない（または両方に入っている）`);
    }
  });

  it("出す項目は、Lesson の列か応答で足す項目だけ（綴りの誤りで漏れを見落とさない）", () => {
    const fields = lessonFieldsInSchema();
    for (const f of LOCKED_LESSON_VISIBLE_FIELDS) {
      assert.ok(fields.includes(f) || ADDED_BY_ROUTE.includes(f), `${f} は Lesson の列でも応答で足す項目でもない`);
    }
  });

  it("本文・動画・資料の列は出さない", () => {
    const visible: ReadonlyArray<string> = LOCKED_LESSON_VISIBLE_FIELDS;
    for (const f of ["videoUrl", "content", "pdfUrl"]) assert.ok(!visible.includes(f), `${f} をロック中に出している`);
  });
});

describe("見えない文字", () => {
  it("このファイルのソースに見えない文字・全角空白を直接書いていない", () => {
    const text = readFileSync(__filename, "utf8");
    assert.doesNotMatch(text, new RegExp("[\\u00A0\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u3000\\uFEFF]", "u"));
  });
});
