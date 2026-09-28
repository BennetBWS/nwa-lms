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

export const INVITE_DEACTIVATED_UI_MESSAGE =
  "このメールアドレスは無効化済みの受講生です。再有効化してください。";

export const INVITE_BAD_REQUEST_MESSAGE = "入力内容を確認してください。名前とメールアドレスを正しく入力して、もう一度お試しください。";

export type InviteErrorView = { message: string; deactivatedUserId: string | null };

/**
 * Error shown in the invite modal, or null when the request succeeded (2xx).
 * `httpStatus` is null for a network error (fetch threw). `body` is the parsed
 * JSON (null when it could not be parsed).
 * - 409 DEACTIVATED: fixed message, plus the student id for the reactivate button.
 * - 409 EXISTS: the API text as is (Japanese, see student-invite.ts).
 * - anything else: a fixed Japanese message chosen by the status. The server's
 *   (English) error text is never shown.
 */
export function inviteErrorView(httpStatus: number | null, body: unknown): InviteErrorView | null {
  if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) return null;
  const fixed = (message: string): InviteErrorView => ({ message, deactivatedUserId: null });
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
