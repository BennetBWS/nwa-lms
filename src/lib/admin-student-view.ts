/**
 * Display logic for the students table of the admin dashboard (#7).
 *
 * Pure functions only (no React, no fetch) so they can be unit tested.
 * The list is fetched once with `?status=all` and filtered on the client.
 */

export type StudentStatusValue = "active" | "deactivated";

export type StudentTab = "active" | "deactivated" | "all";

/** The fields of GET /api/admin/students used by this module. */
export type AdminStudentRow = {
  id: string;
  name: string;
  status: StudentStatusValue;
  /** ISO 8601 string, or null when active. */
  deactivatedAt: string | null;
};

export const STUDENT_TABS: ReadonlyArray<{ key: StudentTab; label: string }> = [
  { key: "active", label: "有効" },
  { key: "deactivated", label: "無効" },
  { key: "all", label: "すべて" },
];

export const DEFAULT_STUDENT_TAB: StudentTab = "active";

/**
 * The tab a student belongs to besides "all". Only "deactivated" is
 * deactivated; any other value (including an unknown one) counts as active.
 * Shared by countStudentsByTab and studentsForTab so counts and rows agree.
 */
function tabOf(status: string): Exclude<StudentTab, "all"> {
  return status === "deactivated" ? "deactivated" : "active";
}

export function countStudentsByTab(
  students: ReadonlyArray<Pick<AdminStudentRow, "status">>
): Record<StudentTab, number> {
  let active = 0;
  let deactivated = 0;
  for (const s of students) {
    if (tabOf(s.status) === "deactivated") deactivated += 1;
    else active += 1;
  }
  return { active, deactivated, all: active + deactivated };
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, "ja");
}

/**
 * Rows shown for a tab. Active students come first (only matters for "all"),
 * then by name. Does not mutate the input.
 */
export function studentsForTab<T extends Pick<AdminStudentRow, "name" | "status">>(
  students: ReadonlyArray<T>,
  tab: StudentTab
): T[] {
  const filtered = tab === "all" ? [...students] : students.filter((s) => tabOf(s.status) === tab);
  return filtered.sort((a, b) => {
    const rank = (s: T) => (tabOf(s.status) === "deactivated" ? 1 : 0);
    const byStatus = rank(a) - rank(b);
    return byStatus !== 0 ? byStatus : compareNames(a.name, b.name);
  });
}

/**
 * "YYYY/MM/DD" in Japan time (the admins operate in Japan). Returns "" for
 * null or an unparsable value.
 */
export function formatDeactivatedDate(iso: string | null, timeZone = "Asia/Tokyo"): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")}`;
}

export type StatusAction = "deactivate" | "reactivate";

/**
 * Fixed Japanese message for a failed deactivate / reactivate request.
 * `httpStatus` is null for a network error (fetch threw). The server's
 * (English) error text is never shown.
 */
export function statusActionErrorMessage(httpStatus: number | null): string {
  if (httpStatus === null) {
    return "通信エラーが発生しました。接続を確認して、もう一度お試しください。";
  }
  if (httpStatus === 403) {
    return "この操作を行う権限がありません。講師アカウントで再ログインしてください。";
  }
  if (httpStatus === 404) {
    return "この受講生が見つかりません。画面を更新して一覧を確認してください。";
  }
  return "サーバーでエラーが発生しました。時間をおいて、もう一度お試しください。";
}

/**
 * Shown when the session has expired: the middleware redirected the request
 * to /login (fetch follows it and gets the login page), or the API returned 401.
 */
export const SESSION_EXPIRED_MESSAGE = "ログインの有効期限が切れました。再度ログインしてください。";

/** The student state returned by PUT /api/admin/students/[id]/(deactivate|reactivate). */
export type StudentStatusUpdate = Pick<AdminStudentRow, "id" | "status" | "deactivatedAt">;

export type StatusActionOutcome =
  | { kind: "success"; updated: StudentStatusUpdate }
  | { kind: "error"; message: string };

/**
 * Decides whether a deactivate / reactivate response is a success.
 * Success only when the response is ok, was not redirected, and the body
 * (parsed JSON, null when it could not be parsed) is the state of `targetId`.
 * - redirected or 401: SESSION_EXPIRED_MESSAGE
 * - anything else: statusActionErrorMessage(status)
 */
export function interpretStatusActionResponse(input: {
  ok: boolean;
  redirected: boolean;
  status: number;
  body: unknown;
  targetId: string;
}): StatusActionOutcome {
  const { ok, redirected, status, body, targetId } = input;
  if (redirected || status === 401) return { kind: "error", message: SESSION_EXPIRED_MESSAGE };
  if (ok && typeof body === "object" && body !== null) {
    const { id, status: accountStatus, deactivatedAt } = body as {
      id?: unknown;
      status?: unknown;
      deactivatedAt?: unknown;
    };
    const at = deactivatedAt === null ? null : typeof deactivatedAt === "string" ? deactivatedAt : undefined;
    if (id === targetId && (accountStatus === "active" || accountStatus === "deactivated") && at !== undefined) {
      return { kind: "success", updated: { id: targetId, status: accountStatus, deactivatedAt: at } };
    }
  }
  return { kind: "error", message: statusActionErrorMessage(status) };
}

export const INVITE_DEACTIVATED_UI_MESSAGE =
  "このメールアドレスは無効化済みの受講生です。再有効化してください。";

export const INVITE_BAD_REQUEST_MESSAGE = "入力内容を確認してください。名前とメールアドレスを正しく入力して、もう一度お試しください。";

export type InviteErrorView = { message: string; deactivatedUserId: string | null };

/**
 * Shown when an invite returned 2xx but the body has no initial password (the
 * account may or may not have been created).
 */
export const INVITE_NO_RESULT_MESSAGE =
  "招待の結果を確認できませんでした。受講生の一覧を確認し、作成されていない場合はもう一度お試しください。";

/**
 * Error shown in the invite modal, or null when the request succeeded.
 * `httpStatus` is null for a network error (fetch threw). `body` is the parsed
 * JSON (null when it could not be parsed). `redirected` is `Response.redirected`.
 * - redirected (the middleware sent the request to /login): SESSION_EXPIRED_MESSAGE.
 * - 2xx: null only when the body has a non-empty `password`; otherwise
 *   INVITE_NO_RESULT_MESSAGE.
 * - 409 DEACTIVATED: fixed message, plus the student id for the reactivate button.
 * - 409 EXISTS: the API text as is (Japanese, see student-invite.ts).
 * - anything else: a fixed Japanese message chosen by the status. The server's
 *   (English) error text is never shown.
 */
export function inviteErrorView(httpStatus: number | null, body: unknown, redirected = false): InviteErrorView | null {
  const fixed = (message: string): InviteErrorView => ({ message, deactivatedUserId: null });
  if (httpStatus !== null && redirected) return fixed(SESSION_EXPIRED_MESSAGE);
  if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
    const password = typeof body === "object" && body !== null ? (body as { password?: unknown }).password : undefined;
    return typeof password === "string" && password !== "" ? null : fixed(INVITE_NO_RESULT_MESSAGE);
  }
  if (httpStatus === 409 && typeof body === "object" && body !== null) {
    const { error, code, userId } = body as { error?: unknown; code?: unknown; userId?: unknown };
    if (code === "DEACTIVATED") {
      return {
        message: INVITE_DEACTIVATED_UI_MESSAGE,
        deactivatedUserId: typeof userId === "string" && userId !== "" ? userId : null,
      };
    }
    if (code === "EXISTS" && typeof error === "string" && error !== "") {
      return fixed(error);
    }
  }
  if (httpStatus === 400) return fixed(INVITE_BAD_REQUEST_MESSAGE);
  // Network error and 403 share the wording of the deactivate / reactivate actions.
  if (httpStatus === null || httpStatus === 403) return fixed(statusActionErrorMessage(httpStatus));
  // 404 ("student not found" does not fit an invite), 409 without a known code, 5xx, unknown
  return fixed(statusActionErrorMessage(500));
}

export function confirmMessage(action: StatusAction, name: string): string {
  if (action === "deactivate") {
    return `${name} さんを無効化しますか？ この受講生はログインできなくなり、ログイン中の端末からも直ちにログアウトされます。学習の進捗・提出物・質問は削除されず、あとから再有効化できます。`;
  }
  return `${name} さんを再有効化しますか？ 再びログインできるようになります。パスワードは変わりません。以前のログイン状態は戻らないため、本人に再ログインを依頼してください。`;
}

// ───────────── 生徒管理（#32）：表の行・検索・Course 列・詳細表示 ─────────────

/** 検索用の正規化：NFKC（全角英数→半角など）、小文字化、前後の空白を除く */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

/**
 * 名前・メールの部分一致で絞り込む（#32）。空（空白だけを含む）の検索語なら全件を返す。
 * 並び順は変えず、入力の配列も書き換えない。
 */
export function filterStudentsByQuery<T extends { name: string; email?: string | null }>(
  students: ReadonlyArray<T>,
  query: string
): T[] {
  const q = normalizeSearchText(query);
  if (q === "") return [...students];
  return students.filter(
    (s) => normalizeSearchText(s.name).includes(q) || normalizeSearchText(s.email ?? "").includes(q)
  );
}

export const ALL_COURSES_COMPLETED_LABEL = "全コース修了";
export const EMPTY_VALUE_LABEL = "—";

/**
 * Course 列・詳細の「現在のコース」の表示。
 * currentCourse が null のとき、レッスンが 1 件以上あれば「全コース修了」、レッスンがなければ「—」
 * （終える対象がないので修了とは言えない）。
 */
export function currentCourseLabel(
  currentCourse: { name: string } | null | undefined,
  totalLessons: number
): string {
  if (currentCourse && typeof currentCourse.name === "string") return currentCourse.name;
  return totalLessons > 0 ? ALL_COURSES_COMPLETED_LABEL : EMPTY_VALUE_LABEL;
}

/** 完了数 ÷ 総数 の % を四捨五入する。総数が 0 なら 0 */
export function progressPercent(completed: number, total: number): number {
  if (!(total > 0) || !(completed > 0)) return 0;
  return Math.min(100, Math.round((completed / total) * 100));
}

/** "YYYY/MM/DD"（日本時間）。null や解釈できない値は "" */
export function formatJstDate(iso: string | null): string {
  return formatDeactivatedDate(iso);
}

export type ProgressStatus = "good" | "warn" | "alert";

/** GET /api/admin/students の 1 行（画面で使う項目） */
export type AdminStudentApiRow = {
  id: string;
  name: string;
  email: string;
  completedLessons: number;
  totalLessons: number;
  lastActive: string | null;
  status: string;
  deactivatedAt: string | null;
  currentCourse?: { id: string; name: string } | null;
};

/** 表の 1 行 */
export type AdminStudentListItem = {
  id: string;
  name: string;
  email: string;
  course: string;
  progress: number;
  /** 最終学習日（最後にレッスンを完了した日、日本時間）。なければ "—" */
  last: string;
  progressStatus: ProgressStatus;
  status: StudentStatusValue;
  deactivatedAt: string | null;
};

export function toAdminStudentListItem(row: AdminStudentApiRow): AdminStudentListItem {
  const progress = progressPercent(row.completedLessons, row.totalLessons);
  const progressStatus: ProgressStatus = progress >= 50 ? "good" : progress >= 20 ? "warn" : "alert";
  return {
    id: row.id,
    name: row.name,
    email: typeof row.email === "string" ? row.email : "",
    course: currentCourseLabel(row.currentCourse, row.totalLessons),
    progress,
    last: formatJstDate(row.lastActive) || EMPTY_VALUE_LABEL,
    progressStatus,
    status: row.status === "deactivated" ? "deactivated" : "active",
    deactivatedAt: row.deactivatedAt ?? null,
  };
}

export const STUDENTS_EMPTY_MESSAGE = "受講生はまだいません";
export const STUDENTS_NO_MATCH_MESSAGE = "該当する受講生はいません";

/** 表が空のときの文言。検索語があれば「該当する受講生はいません」 */
export function studentsEmptyMessage(totalCount: number, query: string): string {
  if (normalizeSearchText(query) !== "") return STUDENTS_NO_MATCH_MESSAGE;
  return totalCount === 0 ? STUDENTS_EMPTY_MESSAGE : STUDENTS_NO_MATCH_MESSAGE;
}

/** 詳細 API の URL（id は encodeURIComponent する） */
export function studentDetailUrl(id: string): string {
  return `/api/admin/students/${encodeURIComponent(id)}`;
}

export const DETAIL_NOT_FOUND_MESSAGE = "この受講生が見つかりません。一覧に戻って確認してください。";
export const DETAIL_LOAD_FAILED_MESSAGE = "受講生の情報を読み込めませんでした";

/**
 * 詳細 API の本文を確かめる。requested の受講生で、必要な配列がそろっていれば本文を返し、
 * そうでなければ null（読み込みの失敗として扱う）。
 */
export function readStudentDetail(body: unknown, requestedId: string): StudentDetailView | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.id !== requestedId || typeof b.name !== "string") return null;
  if (!Array.isArray(b.courseProgress) || !Array.isArray(b.quizAttempts) || !Array.isArray(b.assignments)) return null;
  return body as StudentDetailView;
}

/** 画面で使う詳細の形（API の AdminStudentDetail と同じ。lib 同士の依存を増やさないためここで定義） */
export type StudentDetailView = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  status: StudentStatusValue;
  deactivatedAt: string | null;
  currentCourse: { id: string; name: string } | null;
  courseProgress: Array<{ courseId: string; courseName: string; totalLessons: number; completedLessons: number; lastCompletedAt: string | null }>;
  quizAttempts: Array<{ id: string; quizTitle: string; quizType: string; score: number; passed: boolean; createdAt: string }>;
  assignments: Array<{ id: string; title: string; courseName: string; status: string; deadline: string | null; createdAt: string }>;
};

/** 詳細表示の「現在のコース」。全コースのレッスン総数で「全コース修了」と「—」を分ける */
export function detailCurrentCourseLabel(detail: Pick<StudentDetailView, "currentCourse" | "courseProgress">): string {
  const total = detail.courseProgress.reduce((n, c) => n + (c.totalLessons > 0 ? c.totalLessons : 0), 0);
  return currentCourseLabel(detail.currentCourse, total);
}

export function quizTypeLabel(type: string): string {
  return type === "FINAL" ? "修了テスト" : type === "MINI" ? "ミニテスト" : "テスト";
}

const ASSIGNMENT_STATUS_LABELS: Record<string, string> = {
  LOCKED: "未開放",
  WORKING: "取り組み中",
  REVIEW: "確認待ち",
  APPROVED: "承認済み",
};

export function assignmentStatusLabel(status: string): string {
  return Object.prototype.hasOwnProperty.call(ASSIGNMENT_STATUS_LABELS, status) ? ASSIGNMENT_STATUS_LABELS[status] : "不明";
}
