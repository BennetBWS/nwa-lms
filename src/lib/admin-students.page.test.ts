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

// ───────────── #32（テスト担当の追加）：import の取りこぼし・AdminDashboard の残り ─────────────
// page.tsx は // @ts-nocheck のため、import し忘れは typecheck で見つからない（描画テストは view の全 export を渡す）。

/** `import { a, b as c } from "<mod>";` の名前（ローカル名） */
function importedNames(mod: string): Set<string> {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${mod.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}";`, "g");
  const out = new Set<string>();
  for (const m of Array.from(src.matchAll(re))) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) out.add(name);
    }
  }
  return out;
}

describe("page.tsx：AdminStudents・AdminDashboard が使う名前は import されている", () => {
  it("admin-student-view の export のうち AdminStudents が使うものは、すべて import 済み", async () => {
    const view = await import("./admin-student-view");
    const imported = importedNames("@/lib/admin-student-view");
    const used = Object.keys(view).filter((name) => new RegExp(`\\b${name}\\b`).test(students));
    assert.ok(used.length >= 15, `使っている名前が少なすぎる（${used.join(", ")}）`);
    const missing = used.filter((name) => !imported.has(name));
    assert.deepEqual(missing, [], `import されていない：${missing.join(", ")}`);
  });

  it("JSX のアイコン・部品（大文字で始まるタグ）は import されているか page.tsx で定義されている", () => {
    for (const [name, body] of [["AdminStudents", students], ["AdminDashboard", dashboard]] as const) {
      const tags = new Set(Array.from(body.matchAll(/<([A-Z]\w*)[\s/>]/g)).map((m) => m[1]));
      for (const tag of Array.from(tags)) {
        const defined =
          new RegExp(`import\\s*\\{[^}]*\\b${tag}\\b[^}]*\\}\\s*from`).test(src) ||
          new RegExp(`\\n(const|function) ${tag}\\b`).test(src) ||
          // コンポーネント内のローカル変数（例：const Icon = s.icon）
          new RegExp(`\\bconst ${tag} = `).test(body);
        assert.ok(defined, `${name} の <${tag}> が import・定義されていない`);
      }
    }
  });

  it("classifyAuthFailure・authFetch・ModalPortal は page.tsx にある", () => {
    assert.ok(importedNames("@/lib/client-session").has("classifyAuthFailure"), "classifyAuthFailure が import されていない");
    assert.match(src, /\nconst authFetch = /);
    assert.match(src, /\nconst ModalPortal = \(/);
  });
});

describe("page.tsx：AdminDashboard に受講生の管理が残っていない（追加）", () => {
  it("受講生の state・処理・表示用関数を参照しない", () => {
    for (const s of [
      "studentRows",
      "setStudentRows",
      "reloadStudents",
      "openStatusDialog",
      "handleStatusAction",
      "openDetail",
      "detailSeq",
      "filterStudentsByQuery",
      "toAdminStudentListItem",
      "countStudentsByTab",
      "studentsForTab",
      "confirmMessage",
      "role=\"dialog\"",
      "position: \"fixed\"",
      "students?status",
    ]) {
      assert.ok(!dashboard.includes(s), `${s} が AdminDashboard に残っている`);
    }
  });

  it("AdminDashboard の取得は /api/admin/courses だけ（受講生の一覧は取らない）", () => {
    const urls = Array.from(dashboard.matchAll(/authFetch\(\s*["'`]([^"'`]+)["'`]/g)).map((m) => m[1]);
    assert.deepEqual(urls, ["/api/admin/courses"]);
    assert.ok(!/\bfetch\(/.test(dashboard.replace(/authFetch\(/g, "")), "authFetch 以外の fetch がある");
  });

  it("サイドバーに「生徒管理」（admin-students）があり、ルートは 1 つだけ", () => {
    assert.match(src, /\{ id: "admin-students", icon: Users, label: "生徒管理" \}/);
    assert.equal(src.split('"admin-students": <').length - 1, 1);
  });

  it("AdminStudents の中で setCurrentPage を使っても、ダッシュボードへの導線（生徒管理を開く）は AdminDashboard だけ", () => {
    assert.ok(!students.includes("生徒管理を開く"), "AdminStudents に「生徒管理を開く」がある");
    assert.equal(src.split("生徒管理を開く").length - 1, 1);
  });
});
