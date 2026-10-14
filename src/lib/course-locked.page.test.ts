import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #47 P4 page.tsx（// @ts-nocheck）で、API の 403 course_locked の扱いをソースで検査する。
// @ts-nocheck のため typecheck では取り違えを検出できない。レンダリングはしない。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const lessonView = component("LessonView");
const courseList = component("CourseList");

describe("import", () => {
  it("course-locked から使う名前を import している", () => {
    const m = src.match(/import \{([^}]*)\} from "@\/lib\/course-locked";/);
    assert.ok(m, "course-locked の import がない");
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const n of [
      "COMPLETE_FORBIDDEN_MESSAGE",
      "COMPLETE_LOCKED_MESSAGE",
      "COURSE_LOCKED_DESCRIPTION",
      "COURSE_LOCKED_TITLE",
      "completeRejection",
      "isCourseLockedError",
      "toRequestError",
    ]) {
      assert.ok(names.includes(n), `${n} を import していない`);
    }
  });

  it("サーバーのモジュール（lesson-access・prisma）を import しない", () => {
    assert.doesNotMatch(src, /from "@\/lib\/lesson-access"/);
    assert.doesNotMatch(src, /from "@\/lib\/prisma"/);
  });
});

describe("swrFetcher", () => {
  const m = /const swrFetcher = async \(url\) => \{([\s\S]*?)\n\};/.exec(src);

  it("ok でない応答は、本文を読んで toRequestError で投げる（読めなければ null）", () => {
    assert.ok(m, "swrFetcher が見つからない");
    assert.match(m[1], /if \(!res\.ok\) \{\s*const body = await res\.json\(\)\.catch\(\(\) => null\);\s*throw toRequestError\(res\.status, body\);\s*\}/);
  });

  it("セッション切れの判定は、本文を読む前（これまでどおり）", () => {
    assert.ok(m, "swrFetcher が見つからない");
    const expired = m[1].indexOf('=== "expired"');
    const notOk = m[1].indexOf("if (!res.ok)");
    assert.ok(expired >= 0 && notOk > expired, "セッション切れの判定が ok でない応答の処理より前にない");
  });
});

describe("LessonView：ロック中のコース", () => {
  const lockedStart = lessonView.indexOf("if (isCourseLockedError(courseError)) return (");
  const errorStart = lessonView.indexOf("if (courseError || cannotResolve) return (");

  it("コースの取得が 403 course_locked なら、通信エラーより先にロックの表示を返す", () => {
    assert.ok(lockedStart >= 0, "ロックの表示がない");
    assert.ok(errorStart > lockedStart, "ロックの判定が通信エラーの表示より後にある");
  });

  it("ロックの表示は文言とコース一覧へのボタンだけ（再試行・通信エラーの文言を出さない）", () => {
    assert.ok(lockedStart >= 0 && errorStart > lockedStart, "ロックの表示を切り出せない");
    const locked = lessonView.slice(lockedStart, errorStart);
    assert.match(locked, /\{COURSE_LOCKED_TITLE\}/);
    assert.match(locked, /\{COURSE_LOCKED_DESCRIPTION\}/);
    assert.match(locked, /onClick=\{\(\) => setCurrentPage\("courses"\)\}[^>]*>コース一覧へ<\/Button>/);
    assert.match(locked, /role="alert"/);
    assert.doesNotMatch(locked, /再試行|通信エラー|revalidateCourse/);
  });
});

describe("LessonView：handleComplete の 403", () => {
  const start = lessonView.indexOf("const handleComplete = async (lessonId) => {");
  const end = lessonView.indexOf("const isCompleted = (id) =>");
  const body = start >= 0 && end > start ? lessonView.slice(start, end) : "";

  it("handleComplete を切り出せる", () => {
    assert.ok(body.length > 0, "handleComplete が見つからない");
  });

  it("応答を completeRejection で判定し、403 のときだけ本文を読む", () => {
    assert.match(body, /const res = await authFetch\("\/api\/progress", \{/);
    assert.match(body, /const rejection = completeRejection\(res\.status, res\.status === 403 \? await res\.json\(\)\.catch\(\(\) => null\) : null\);/);
  });

  it("断られたら楽観更新を戻し、文言を出し、次のレッスンへ進まずに戻る", () => {
    const i = body.indexOf("if (rejection) {");
    assert.ok(i >= 0, "if (rejection) がない");
    const block = body.slice(i, body.indexOf("\n      }\n", i));
    assert.match(block, /setCompletedIds\(prev => \{ const next = new Set\(prev\); next\.delete\(lessonId\); return next; \}\);/);
    assert.match(block, /showToast\(rejection === "course_locked" \? COMPLETE_LOCKED_MESSAGE : COMPLETE_FORBIDDEN_MESSAGE\);/);
    assert.match(block, /return;/);
    const nav = body.indexOf("allLessons.findIndex(l => l.id === lessonId)");
    assert.ok(nav > i, "次のレッスンへの移動が、断られたときの判定より前にある");
  });

  it("楽観更新は送る前のまま（完了の表示を先に出す）", () => {
    const optimistic = body.indexOf("setCompletedIds(prev => new Set([...prev, lessonId]));");
    const send = body.indexOf('authFetch("/api/progress"');
    assert.ok(optimistic >= 0 && send > optimistic, "楽観更新が送信の前にない");
  });
});

describe("CourseList：ロック中のコースを先読みしない", () => {
  it("page.tsx の preload は CourseList の 1 か所だけ", () => {
    const all = Array.from(src.matchAll(/\bpreload\(/g)).length;
    const inList = Array.from(courseList.matchAll(/\bpreload\(/g)).length;
    assert.equal(inList, 1, `CourseList の preload が ${inList} か所`);
    assert.equal(all, 1, `page.tsx の preload が ${all} か所（CourseList 以外にもある）`);
  });

  it("preload は if (!c.locked) の中だけで呼ぶ（ロック中のコースの詳細は 403 になる）", () => {
    const line = courseList.split("\n").find((l) => /\bpreload\(/.test(l));
    assert.ok(line, "preload の行がない");
    assert.match(line, /onMouseEnter=\{e => \{ if \(!c\.locked\) \{[^}]*preload\(`\/api\/courses\/\$\{c\.id\}`, swrFetcher\); \}\}\}/);
  });

  it("クリックで開くのもロック中でないときだけ", () => {
    assert.match(courseList, /onClick=\{\(\) => !c\.locked && setCurrentPage\("lesson", \{ courseId: c\.id \}\)\}/);
  });

  it("c.locked は API の一覧から画面と同じ規則（isCourseLocked）で計算した値", () => {
    assert.match(courseList, /const locked = isCourseLocked\(i > 0 \? countCourseLessons\(apiCourses\[i - 1\]\) : null, countCourseLessons\(c\)\);/);
    assert.match(courseList, /students: 0, locked,/);
  });
});
