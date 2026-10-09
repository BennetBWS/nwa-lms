import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_STUDENT_DETAIL_KEYS,
  DETAIL_ASSIGNMENT_SELECT,
  DETAIL_QUIZ_ATTEMPT_SELECT,
  DETAIL_USER_SELECT,
  detailCourseSelect,
  toAdminStudentDetail,
  type DetailAssignmentRow,
  type DetailCourseRow,
  type DetailQuizAttemptRow,
  type DetailUserRow,
} from "./admin-student-detail";

// #32 生徒管理の詳細表示：GET /api/admin/students/[id] の応答をホワイトリストで組み立てる。
// データはすべてダミー（example.com）。

const done = (iso: string | null) => ({ completedAt: iso === null ? null : new Date(iso) });

const USER: DetailUserRow = {
  id: "stu_1",
  email: "detail-32@example.com",
  name: "ダミー 太郎",
  createdAt: new Date("2026-04-01T00:00:00.000Z"),
  deactivatedAt: null,
};

const COURSES: DetailCourseRow[] = [
  {
    id: "c1",
    name: "STEP1 ダミー",
    sections: [
      { lessons: [{ id: "l1", progress: [done("2026-09-01T00:00:00.000Z")] }, { id: "l2", progress: [done("2026-09-03T00:00:00.000Z")] }] },
      { lessons: [{ id: "l3", progress: [done(null)] }] },
    ],
  },
  { id: "c_empty", name: "空のコース", sections: [] },
  {
    id: "c2",
    name: "STEP2 ダミー",
    sections: [{ lessons: [{ id: "l4", progress: [done("2026-09-05T00:00:00.000Z")] }, { id: "l5", progress: [] }] }],
  },
];

const QUIZ: DetailQuizAttemptRow[] = [
  { id: "qa2", score: 67, passed: false, createdAt: new Date("2026-09-10T00:00:00.000Z"), quiz: { title: "修了テスト", type: "FINAL" } },
  { id: "qa1", score: 100, passed: true, createdAt: new Date("2026-09-02T00:00:00.000Z"), quiz: { title: "ミニ", type: "MINI" } },
];

const ASSIGN: DetailAssignmentRow[] = [
  { id: "as1", title: "課題1", status: "REVIEW", deadline: new Date("2026-10-01T00:00:00.000Z"), createdAt: new Date("2026-09-01T00:00:00.000Z"), course: { name: "STEP1 ダミー" } },
  { id: "as2", title: "課題2", status: "LOCKED", deadline: null, createdAt: new Date("2026-08-01T00:00:00.000Z"), course: { name: "STEP2 ダミー" } },
];

/** オブジェクトの木に現れるキーをすべて集める */
function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

describe("toAdminStudentDetail", () => {
  const detail = toAdminStudentDetail({ user: USER, courses: COURSES, quizAttempts: QUIZ, assignments: ASSIGN });

  it("トップレベルのキーはホワイトリストと完全に一致する", () => {
    assert.deepEqual(Object.keys(detail).sort(), [...ADMIN_STUDENT_DETAIL_KEYS]);
  });

  it("基本情報と状態（有効）", () => {
    assert.equal(detail.id, "stu_1");
    assert.equal(detail.name, "ダミー 太郎");
    assert.equal(detail.email, "detail-32@example.com");
    assert.equal(detail.createdAt, "2026-04-01T00:00:00.000Z");
    assert.equal(detail.status, "active");
    assert.equal(detail.deactivatedAt, null);
  });

  it("無効化済みなら status=deactivated と ISO の deactivatedAt", () => {
    const off = toAdminStudentDetail({
      user: { ...USER, deactivatedAt: new Date("2026-09-20T00:00:00.000Z") },
      courses: [],
      quizAttempts: [],
      assignments: [],
    });
    assert.equal(off.status, "deactivated");
    assert.equal(off.deactivatedAt, "2026-09-20T00:00:00.000Z");
    assert.deepEqual(off.courseProgress, []);
    assert.equal(off.currentCourse, null);
  });

  it("コースごとの進捗：総数・完了数・最後に完了した日時（日時のない完了は数えるが日時にしない）", () => {
    assert.deepEqual(detail.courseProgress, [
      { courseId: "c1", courseName: "STEP1 ダミー", totalLessons: 3, completedLessons: 3, lastCompletedAt: "2026-09-03T00:00:00.000Z" },
      { courseId: "c_empty", courseName: "空のコース", totalLessons: 0, completedLessons: 0, lastCompletedAt: null },
      { courseId: "c2", courseName: "STEP2 ダミー", totalLessons: 2, completedLessons: 1, lastCompletedAt: "2026-09-05T00:00:00.000Z" },
    ]);
  });

  it("現在のコース：STEP1 を終え、空のコースを飛ばして STEP2", () => {
    assert.deepEqual(detail.currentCourse, { id: "c2", name: "STEP2 ダミー" });
  });

  it("小テストの履歴：許可した項目だけ、渡された順（新しい順）", () => {
    assert.deepEqual(detail.quizAttempts, [
      { id: "qa2", quizTitle: "修了テスト", quizType: "FINAL", score: 67, passed: false, createdAt: "2026-09-10T00:00:00.000Z" },
      { id: "qa1", quizTitle: "ミニ", quizType: "MINI", score: 100, passed: true, createdAt: "2026-09-02T00:00:00.000Z" },
    ]);
  });

  it("課題：許可した項目だけ、期限なしは null", () => {
    assert.deepEqual(detail.assignments, [
      { id: "as1", title: "課題1", courseName: "STEP1 ダミー", status: "REVIEW", deadline: "2026-10-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "as2", title: "課題2", courseName: "STEP2 ダミー", status: "LOCKED", deadline: null, createdAt: "2026-08-01T00:00:00.000Z" },
    ]);
  });

  it("行に余計な項目（answers・feedback・password など）があっても応答に入らない", () => {
    const dirtyUser = { ...USER, password: "$2a$dummy", sessionVersion: 3, avatar: "a.png", role: "STUDENT" };
    const dirtyQuiz = QUIZ.map((q) => ({ ...q, answers: [1, 2], userId: "stu_1", quizId: "quiz_1" }));
    const dirtyAssign = ASSIGN.map((a) => ({ ...a, feedback: "講師のコメント", userId: "stu_1", courseId: "c1" }));
    const out = toAdminStudentDetail({ user: dirtyUser, courses: COURSES, quizAttempts: dirtyQuiz, assignments: dirtyAssign });
    const keys = allKeys(out);
    for (const k of ["password", "sessionVersion", "avatar", "role", "answers", "userId", "quizId", "feedback", "progress", "sections"]) {
      assert.ok(!keys.has(k), `${k} が応答に含まれている`);
    }
    // courseProgress の courseId だけは許可した項目
    assert.ok(keys.has("courseId"), "courseProgress の courseId がない");
    const json = JSON.stringify(out);
    for (const s of ["$2a$dummy", "講師のコメント", "a.png", "quiz_1"]) assert.ok(!json.includes(s), `${s} が応答に含まれている`);
  });

  it("入力の Date を書き換えない", () => {
    const created = USER.createdAt.getTime();
    toAdminStudentDetail({ user: USER, courses: COURSES, quizAttempts: QUIZ, assignments: ASSIGN });
    assert.equal(USER.createdAt.getTime(), created);
  });
});

describe("select の定数（DB から読む項目）", () => {
  it("User は password・sessionVersion・avatar を読まない", () => {
    assert.deepEqual(Object.keys(DETAIL_USER_SELECT).sort(), ["createdAt", "deactivatedAt", "email", "id", "name"]);
  });

  it("QuizAttempt は answers・userId・quizId を読まない", () => {
    assert.deepEqual(Object.keys(DETAIL_QUIZ_ATTEMPT_SELECT).sort(), ["createdAt", "id", "passed", "quiz", "score"]);
    assert.deepEqual(DETAIL_QUIZ_ATTEMPT_SELECT.quiz, { select: { title: true, type: true } });
  });

  it("Assignment は feedback・userId・courseId を読まない", () => {
    assert.deepEqual(Object.keys(DETAIL_ASSIGNMENT_SELECT).sort(), ["course", "createdAt", "deadline", "id", "status", "title"]);
    assert.deepEqual(DETAIL_ASSIGNMENT_SELECT.course, { select: { name: true } });
  });

  it("コースの進捗はこの受講生の完了した行だけ、completedAt だけを読む", () => {
    const sel = detailCourseSelect("stu_1");
    assert.deepEqual(sel.sections.select.lessons.select.progress, {
      where: { userId: "stu_1", completed: true },
      select: { completedAt: true },
    });
    assert.deepEqual(Object.keys(sel).sort(), ["id", "name", "sections"]);
  });
});
