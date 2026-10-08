import type { Prisma } from "@prisma/client";
import { currentCourseOf, type CurrentCourse } from "./student-current-course";
import { studentStatusOf, type StudentStatusValue } from "./student-status";

/**
 * GET /api/admin/students/[id] の応答（#32）。
 *
 * 返す項目をここで 1 つずつ指定する（ホワイトリスト）。Prisma の行をそのまま広げない。
 * 次は返さない：password / sessionVersion / avatar（User）、answers / userId / quizId（QuizAttempt）、
 * feedback / userId / courseId（Assignment）。
 *
 * select はこのファイルの定数を route から使い、型は Prisma の生成型（GetPayload）から取る。
 */

export const DETAIL_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
  deactivatedAt: true,
} satisfies Prisma.UserSelect;

/** コースの構成と、この受講生の完了した進捗（completedAt だけ） */
export function detailCourseSelect(userId: string) {
  return {
    id: true,
    name: true,
    sections: {
      select: {
        lessons: {
          select: {
            id: true,
            progress: {
              where: { userId, completed: true },
              select: { completedAt: true },
            },
          },
        },
      },
    },
  } satisfies Prisma.CourseSelect;
}

export const DETAIL_QUIZ_ATTEMPT_SELECT = {
  id: true,
  score: true,
  passed: true,
  createdAt: true,
  quiz: { select: { title: true, type: true } },
} satisfies Prisma.QuizAttemptSelect;

export const DETAIL_ASSIGNMENT_SELECT = {
  id: true,
  title: true,
  status: true,
  deadline: true,
  createdAt: true,
  course: { select: { name: true } },
} satisfies Prisma.AssignmentSelect;

export type DetailUserRow = Prisma.UserGetPayload<{ select: typeof DETAIL_USER_SELECT }>;
export type DetailCourseRow = Prisma.CourseGetPayload<{ select: ReturnType<typeof detailCourseSelect> }>;
export type DetailQuizAttemptRow = Prisma.QuizAttemptGetPayload<{ select: typeof DETAIL_QUIZ_ATTEMPT_SELECT }>;
export type DetailAssignmentRow = Prisma.AssignmentGetPayload<{ select: typeof DETAIL_ASSIGNMENT_SELECT }>;

export type AdminStudentCourseProgress = {
  courseId: string;
  courseName: string;
  totalLessons: number;
  completedLessons: number;
  /** このコースで最後にレッスンを完了した日時（ISO）。完了がない・日時が記録されていなければ null */
  lastCompletedAt: string | null;
};

export type AdminStudentQuizAttempt = {
  id: string;
  quizTitle: string;
  quizType: "MINI" | "FINAL";
  score: number;
  passed: boolean;
  createdAt: string;
};

export type AdminStudentAssignment = {
  id: string;
  title: string;
  courseName: string;
  status: "LOCKED" | "WORKING" | "REVIEW" | "APPROVED";
  deadline: string | null;
  createdAt: string;
};

export type AdminStudentDetail = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  status: StudentStatusValue;
  deactivatedAt: string | null;
  /** 並び順で全レッスンを終えていない最初のコース。全コース修了（またはレッスンがない）なら null */
  currentCourse: CurrentCourse | null;
  courseProgress: AdminStudentCourseProgress[];
  /** 新しい順（route の orderBy のまま） */
  quizAttempts: AdminStudentQuizAttempt[];
  /** 新しい順（route の orderBy のまま） */
  assignments: AdminStudentAssignment[];
};

/** キーの一覧（テストで応答のキーと照合する） */
export const ADMIN_STUDENT_DETAIL_KEYS = [
  "assignments",
  "courseProgress",
  "createdAt",
  "currentCourse",
  "deactivatedAt",
  "email",
  "id",
  "name",
  "quizAttempts",
  "status",
] as const;

function toCourseProgress(course: DetailCourseRow): AdminStudentCourseProgress {
  const lessons = course.sections.flatMap((s) => s.lessons);
  let completedLessons = 0;
  let last: Date | null = null;
  for (const lesson of lessons) {
    if (lesson.progress.length === 0) continue;
    completedLessons++;
    for (const p of lesson.progress) {
      if (p.completedAt && (last === null || p.completedAt.getTime() > last.getTime())) last = p.completedAt;
    }
  }
  return {
    courseId: course.id,
    courseName: course.name,
    totalLessons: lessons.length,
    completedLessons,
    lastCompletedAt: last ? last.toISOString() : null,
  };
}

/**
 * courses は並び順（order の昇順）で渡す。各レッスンの progress はこの受講生の完了した行だけ
 * （detailCourseSelect の where）。currentCourse は表の Course 列と同じ currentCourseOf で求める。
 */
export function toAdminStudentDetail(input: {
  user: DetailUserRow;
  courses: ReadonlyArray<DetailCourseRow>;
  quizAttempts: ReadonlyArray<DetailQuizAttemptRow>;
  assignments: ReadonlyArray<DetailAssignmentRow>;
}): AdminStudentDetail {
  const { user, courses, quizAttempts, assignments } = input;
  const { status, deactivatedAt } = studentStatusOf(user);

  const completed = new Set<string>();
  for (const course of courses) {
    for (const section of course.sections) {
      for (const lesson of section.lessons) {
        if (lesson.progress.length > 0) completed.add(lesson.id);
      }
    }
  }
  const currentCourse = currentCourseOf(courses, completed);

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
    status,
    deactivatedAt,
    currentCourse,
    courseProgress: courses.map(toCourseProgress),
    quizAttempts: quizAttempts.map((a) => ({
      id: a.id,
      quizTitle: a.quiz.title,
      quizType: a.quiz.type,
      score: a.score,
      passed: a.passed,
      createdAt: a.createdAt.toISOString(),
    })),
    assignments: assignments.map((a) => ({
      id: a.id,
      title: a.title,
      courseName: a.course.name,
      status: a.status,
      deadline: a.deadline ? a.deadline.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}
