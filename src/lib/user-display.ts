/**
 * How the signed-in user's name is shown in the common UI (#32):
 * the sidebar (name and avatar initial) and the dashboard heading.
 *
 * Pure functions, no React / DOM, so they can be unit tested.
 * The name comes from the session (`SessionView.name` in client-session.ts),
 * which may be missing, so every function accepts `unknown`.
 */

/** Trimmed name with runs of whitespace collapsed to one space, or null when there is none. */
export function displayName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const normalized = name.trim().replace(/\s+/g, " ");
  return normalized === "" ? null : normalized;
}

function firstGrapheme(text: string): string {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
    return segmenter.segment(text).containing(0)?.segment ?? "";
  }
  return Array.from(text)[0] ?? "";
}

/**
 * First user-perceived character of the name (emoji sequences and combining
 * characters stay whole), with Latin letters upper-cased.
 * Null when there is no name: the UI shows a generic user icon instead.
 */
export function avatarInitial(name: unknown): string | null {
  const shown = displayName(name);
  if (shown === null) return null;
  const initial = firstGrapheme(shown);
  return initial === "" ? null : initial.toLocaleUpperCase("en");
}

/** Dashboard heading. */
export function greetingTitle(name: unknown): string {
  const shown = displayName(name);
  return shown === null ? "おかえりなさい" : `おかえりなさい、${shown} さん`;
}
