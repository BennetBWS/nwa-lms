import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  ALL_COURSES_COMPLETED_LABEL,
  DETAIL_NOT_FOUND_MESSAGE,
  EMPTY_VALUE_LABEL,
  STUDENTS_EMPTY_MESSAGE,
  STUDENTS_NO_MATCH_MESSAGE,
  assignmentStatusLabel,
  currentCourseLabel,
  detailCurrentCourseLabel,
  filterStudentsByQuery,
  normalizeSearchText,
  progressPercent,
  quizTypeLabel,
  readStudentDetail,
  studentDetailUrl,
  studentsEmptyMessage,
  toAdminStudentListItem,
  type AdminStudentApiRow,
} from "./admin-student-view";

// #32 生徒管理：検索・Course 列・表の行・詳細表示の補助。データはすべてダミー（example.com）。

const rows = [
  { id: "s1", name: "やまだ 花子", email: "hanako-32@example.com" },
  { id: "s2", name: "Suzuki Ichiro", email: "ICHIRO-32@Example.com" },
  { id: "s3", name: "さとう", email: "sato-32@example.com" },
];

describe("normalizeSearchText", () => {
  it("NFKC（全角英数→半角）、小文字化、前後の空白（全角空白を含む）を除く", () => {
    assert.equal(normalizeSearchText("　ＡＢＣ１２３ "), "abc123");
    assert.equal(normalizeSearchText("Ｓｕｚｕｋｉ"), "suzuki");
  });

  it("半角カナは全角カナになる（NFKC）", () => {
    assert.equal(normalizeSearchText("ﾔﾏﾀﾞ"), "ヤマダ");
  });
});

describe("filterStudentsByQuery", () => {
  it("空・空白だけなら全件（新しい配列）", () => {
    for (const q of ["", "   ", "　"]) {
      const got = filterStudentsByQuery(rows, q);
      assert.deepEqual(got.map((s) => s.id), ["s1", "s2", "s3"], JSON.stringify(q));
      assert.notEqual(got, rows, "入力の配列をそのまま返している");
    }
  });

  it("名前の部分一致", () => {
    assert.deepEqual(filterStudentsByQuery(rows, "花子").map((s) => s.id), ["s1"]);
    assert.deepEqual(filterStudentsByQuery(rows, "さと").map((s) => s.id), ["s3"]);
  });

  it("メールの部分一致（大文字小文字を区別しない）", () => {
    assert.deepEqual(filterStudentsByQuery(rows, "ichiro-32@example").map((s) => s.id), ["s2"]);
    assert.deepEqual(filterStudentsByQuery(rows, "-32@").map((s) => s.id), ["s1", "s2", "s3"]);
  });

  it("全角英字・前後の空白を正規化して比べる", () => {
    assert.deepEqual(filterStudentsByQuery(rows, " ＳＵＺＵＫＩ ").map((s) => s.id), ["s2"]);
  });

  it("一致しなければ空", () => {
    assert.deepEqual(filterStudentsByQuery(rows, "zzz"), []);
  });

  it("email がない行でも落ちない（名前だけで比べる）", () => {
    const noEmail = [{ id: "x", name: "ダミー" }, { id: "y", name: "ほか", email: null }];
    assert.deepEqual(filterStudentsByQuery(noEmail, "ダミ").map((s) => s.id), ["x"]);
    assert.deepEqual(filterStudentsByQuery(noEmail, "null"), []);
  });

  it("入力を書き換えない・余分な項目を残す", () => {
    const input = rows.map((r) => ({ ...r, progress: 10 }));
    const before = JSON.stringify(input);
    const [first] = filterStudentsByQuery(input, "花子");
    assert.equal(first.progress, 10);
    assert.equal(JSON.stringify(input), before);
  });
});

describe("currentCourseLabel", () => {
  it("コースがあればその名前", () => {
    assert.equal(currentCourseLabel({ name: "STEP2 ダミー" }, 10), "STEP2 ダミー");
  });

  it("null でレッスンがあれば「全コース修了」、レッスンがなければ「—」", () => {
    assert.equal(currentCourseLabel(null, 10), ALL_COURSES_COMPLETED_LABEL);
    assert.equal(currentCourseLabel(undefined, 1), "全コース修了");
    assert.equal(currentCourseLabel(null, 0), EMPTY_VALUE_LABEL);
  });
});

describe("progressPercent", () => {
  it("四捨五入、総数 0 なら 0、100 を超えない", () => {
    assert.equal(progressPercent(1, 3), 33);
    assert.equal(progressPercent(2, 3), 67);
    assert.equal(progressPercent(0, 0), 0);
    assert.equal(progressPercent(5, 0), 0);
    assert.equal(progressPercent(12, 10), 100);
  });
});

describe("toAdminStudentListItem", () => {
  const base: AdminStudentApiRow = {
    id: "s1",
    name: "ダミー",
    email: "dummy-32@example.com",
    completedLessons: 5,
    totalLessons: 10,
    lastActive: "2026-09-30T16:00:00.000Z",
    status: "active",
    deactivatedAt: null,
    currentCourse: { id: "c2", name: "STEP2 ダミー" },
  };

  it("Course 列・進捗・最終学習日（日本時間）・評価", () => {
    assert.deepEqual(toAdminStudentListItem(base), {
      id: "s1",
      name: "ダミー",
      email: "dummy-32@example.com",
      course: "STEP2 ダミー",
      progress: 50,
      last: "2026/10/01",
      progressStatus: "good",
      status: "active",
      deactivatedAt: null,
    });
  });

  it("全コース修了・学習なし・無効", () => {
    const item = toAdminStudentListItem({ ...base, currentCourse: null, completedLessons: 1, lastActive: null, status: "deactivated", deactivatedAt: "2026-09-01T00:00:00.000Z" });
    assert.equal(item.course, "全コース修了");
    assert.equal(item.last, "—");
    assert.equal(item.progressStatus, "alert");
    assert.equal(item.status, "deactivated");
    assert.equal(item.deactivatedAt, "2026-09-01T00:00:00.000Z");
  });

  it("currentCourse がない古い応答でも落ちない", () => {
    const { currentCourse: _omit, ...old } = base;
    assert.equal(toAdminStudentListItem(old).course, "全コース修了");
  });

  it("20% は注意、19% は要対応", () => {
    assert.equal(toAdminStudentListItem({ ...base, completedLessons: 20, totalLessons: 100 }).progressStatus, "warn");
    assert.equal(toAdminStudentListItem({ ...base, completedLessons: 19, totalLessons: 100 }).progressStatus, "alert");
  });
});

describe("studentsEmptyMessage", () => {
  it("検索語があれば「該当する受講生はいません」", () => {
    assert.equal(studentsEmptyMessage(0, "x"), STUDENTS_NO_MATCH_MESSAGE);
    assert.equal(studentsEmptyMessage(3, "x"), STUDENTS_NO_MATCH_MESSAGE);
  });

  it("検索語がなく 0 人なら「受講生はまだいません」、タブで 0 件なら「該当する受講生はいません」", () => {
    assert.equal(studentsEmptyMessage(0, " "), STUDENTS_EMPTY_MESSAGE);
    assert.equal(studentsEmptyMessage(2, ""), STUDENTS_NO_MATCH_MESSAGE);
  });
});

describe("studentDetailUrl", () => {
  it("id を encodeURIComponent する", () => {
    assert.equal(studentDetailUrl("abc"), "/api/admin/students/abc");
    assert.equal(studentDetailUrl("a/b?c#d"), "/api/admin/students/a%2Fb%3Fc%23d");
    assert.equal(studentDetailUrl(".."), "/api/admin/students/..");
  });
});

describe("readStudentDetail", () => {
  const ok = { id: "s1", name: "ダミー", email: "x@example.com", courseProgress: [], quizAttempts: [], assignments: [] };

  it("求めた受講生で配列がそろっていれば本文を返す", () => {
    assert.equal(readStudentDetail(ok, "s1"), ok);
  });

  it("別の受講生・形の違う本文・null は null", () => {
    assert.equal(readStudentDetail(ok, "s2"), null);
    assert.equal(readStudentDetail(null, "s1"), null);
    assert.equal(readStudentDetail("<html>", "s1"), null);
    assert.equal(readStudentDetail({ ...ok, quizAttempts: undefined }, "s1"), null);
    assert.equal(readStudentDetail({ ...ok, name: 1 }, "s1"), null);
    assert.equal(readStudentDetail({ error: "Student not found" }, "s1"), null);
  });
});

describe("detailCurrentCourseLabel", () => {
  it("全コースのレッスン総数で「全コース修了」と「—」を分ける", () => {
    const cp = (total: number) => ({ courseId: "c", courseName: "c", totalLessons: total, completedLessons: total, lastCompletedAt: null });
    assert.equal(detailCurrentCourseLabel({ currentCourse: null, courseProgress: [cp(3)] }), "全コース修了");
    assert.equal(detailCurrentCourseLabel({ currentCourse: null, courseProgress: [cp(0)] }), "—");
    assert.equal(detailCurrentCourseLabel({ currentCourse: null, courseProgress: [] }), "—");
    assert.equal(detailCurrentCourseLabel({ currentCourse: { id: "c", name: "STEP1" }, courseProgress: [cp(3)] }), "STEP1");
  });
});

describe("ラベル", () => {
  it("小テストの種類", () => {
    assert.equal(quizTypeLabel("MINI"), "ミニテスト");
    assert.equal(quizTypeLabel("FINAL"), "修了テスト");
    assert.equal(quizTypeLabel("OTHER"), "テスト");
  });

  it("課題の状態（Object の組み込みを拾わない）", () => {
    assert.equal(assignmentStatusLabel("LOCKED"), "未開放");
    assert.equal(assignmentStatusLabel("WORKING"), "取り組み中");
    assert.equal(assignmentStatusLabel("REVIEW"), "確認待ち");
    assert.equal(assignmentStatusLabel("APPROVED"), "承認済み");
    assert.equal(assignmentStatusLabel("constructor"), "不明");
    assert.equal(assignmentStatusLabel("toString"), "不明");
  });

  it("404 の文言は日本語で、英語を含まない", () => {
    assert.ok(!/[A-Za-z]{2,}/.test(DETAIL_NOT_FOUND_MESSAGE), "英語が混ざっている");
  });
});

describe("admin-student-view の依存（画面側に Prisma の実行コードを入れない）", () => {
  const source = readFileSync(join(__dirname, "admin-student-view.ts"), "utf8");

  it("admin-student-detail は import type でだけ読む", () => {
    const imports = source.match(/^import\b[^;]*from\s+"\.\/admin-student-detail";/gm) ?? [];
    assert.ok(imports.length > 0, "admin-student-detail を読んでいない（StudentDetailView の型の出どころ）");
    for (const line of imports) assert.ok(/^import type\s/.test(line), `import type でない：${line}`);
    assert.ok(!/@prisma\/client|from\s+"\.\/prisma"|from\s+"@\/lib\/prisma"/.test(source), "Prisma を直接 import している");
  });

  it("変換後のコードに admin-student-detail・Prisma の import が残らない", () => {
    const out = ts.transpileModule(source, {
      fileName: "admin-student-view.ts",
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true },
    }).outputText;
    assert.ok(!out.includes("admin-student-detail"), "変換後に admin-student-detail の import が残っている");
    assert.ok(!/prisma/i.test(out), "変換後に prisma の import が残っている");
  });

  it("StudentDetailView を自前で定義しない（AdminStudentDetail の別名）", () => {
    assert.ok(/export type StudentDetailView = AdminStudentDetail;/.test(source), "StudentDetailView が AdminStudentDetail の別名でない");
  });
});
