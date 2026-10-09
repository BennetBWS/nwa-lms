import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #32 生徒管理：受講生の表を AdminDashboard から AdminStudents に移したことを page.tsx のソースで確かめる。
// 挙動は admin-students.render.page.test.ts（偽の React で描画）で確かめる。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const dashboard = component("AdminDashboard");
const students = component("AdminStudents");

describe("page.tsx：ルーティング", () => {
  it('"admin-students" は AdminStudents を描画する（Placeholder ではない）', () => {
    assert.match(src, /"admin-students": <AdminStudents setCurrentPage=\{handlePageChange\} \/>,/);
    assert.ok(!/"admin-students": <Placeholder/.test(src), "admin-students が Placeholder のまま");
  });

  it('"admin-dashboard" は setCurrentPage を渡して AdminDashboard を描画する', () => {
    assert.match(src, /"admin-dashboard": <AdminDashboard setCurrentPage=\{handlePageChange\} \/>,/);
  });

  it("AdminStudents は AdminDashboard の後ろ、QuizPage の前にある（ほかのテストの区切りを壊さない）", () => {
    const d = src.indexOf("\nconst AdminDashboard = (");
    const s = src.indexOf("\nconst AdminStudents = (");
    const q = src.indexOf("\nconst QuizPage = (");
    assert.ok(d >= 0 && s > d && q > s, "並びが違う");
  });
});

describe("page.tsx：AdminDashboard", () => {
  it("受講生の表・招待・ダイアログ・受講生一覧の取得が残っていない", () => {
    for (const s of ["/api/admin/students", "inviteModal", "statusDialog", "<ModalPortal>", "STUDENT_TABS", "nwa-admin-table-grid", "handleInvite"]) {
      assert.ok(!dashboard.includes(s), `${s} が AdminDashboard に残っている`);
    }
  });

  it("「生徒管理を開く」は setCurrentPage(\"admin-students\") を呼ぶ", () => {
    assert.match(dashboard, /onClick=\{\(\) => setCurrentPage\("admin-students"\)\}/);
    assert.ok(dashboard.includes("生徒管理を開く"), "案内のボタンがない");
  });

  it("受講生の人数を出さない（QA-3）", () => {
    assert.ok(!/有効 \{|無効 \{|名 \/ /.test(dashboard), "人数の表示がある");
  });
});

describe("page.tsx：AdminStudents", () => {
  it("一覧は ?status=all だけを取得し、courses は取らない", () => {
    assert.ok(students.includes('authFetch("/api/admin/students?status=all")'), "一覧の取得がない");
    assert.ok(!students.includes("/api/admin/courses"), "courses を取得している");
  });

  it("検索の input は value・onChange・placeholder・aria-label を持つ", () => {
    assert.match(
      students,
      /<input type="search" value=\{query\} onChange=\{e => setQuery\(e\.target\.value\)\} placeholder="名前・メールで検索" aria-label="[^"]+"/
    );
    assert.ok(!students.includes('placeholder="Search..."'), "見本の検索欄が残っている");
  });

  it("絞り込みは タブ → 検索 の順、件数は検索前", () => {
    assert.match(students, /filterStudentsByQuery\(studentsForTab\(students, studentTab\), query\)/);
    assert.match(students, /const studentCounts = countStudentsByTab\(students\);/);
  });

  it("詳細の URL は studentDetailUrl（encodeURIComponent）で作り、応答は readStudentDetail で確かめる", () => {
    assert.match(students, /authFetch\(studentDetailUrl\(id\)\)/);
    assert.match(students, /readStudentDetail\(body, id\)/);
  });

  it("古い詳細の応答を detailSeq で捨てる", () => {
    assert.match(students, /const seq = \+\+detailSeq\.current;/);
    assert.ok((students.match(/if \(seq !== detailSeq\.current\) return;/g) ?? []).length >= 2, "応答の後の確認が足りない");
    const close = students.slice(students.indexOf("const closeDetail = () =>"));
    assert.match(close.slice(0, 200), /detailSeq\.current\+\+;/);
  });

  it("Course 列は表示用の関数（toAdminStudentListItem）の値で、空文字の見本ではない", () => {
    assert.match(students, /\(studentRows \|\| \[\]\)\.map\(toAdminStudentListItem\)/);
    assert.ok(!students.includes('course: ""'), "Course 列が空のまま");
  });

  it("列名は「最終学習日」（Last Seen ではない）", () => {
    assert.ok(students.includes('<div className="nwa-admin-col-last">最終学習日</div>'), "列名が最終学習日でない");
    assert.ok(!src.includes("Last Seen"), "Last Seen が残っている");
  });

  it("失敗の表示は role=alert", () => {
    assert.ok((students.match(/role="alert"/g) ?? []).length >= 3, "role=alert が足りない（一覧・詳細・404・確認ダイアログ）");
  });
});
