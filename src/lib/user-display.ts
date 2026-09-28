/**
 * How the signed-in user's name is shown in the common UI (#32):
 * the sidebar (name and avatar initial) and the dashboard heading.
 *
 * Pure functions, no React / DOM, so they can be unit tested.
 * The name comes from the session (`SessionView.name` in client-session.ts),
 * which may be missing, so every function accepts `unknown`.
 */

// Control and format characters (zero-width space, bidi overrides such as U+202E, tag
// characters, ...) are removed, except the ones emoji need: ZWJ (U+200D) joins sequences, and
// tag characters are kept only inside a subdivision flag (U+1F3F4, tags, cancel tag U+E007F).
// Characters that look blank but are classified as letters / symbols (Hangul fillers
// U+115F, U+1160, U+3164, U+FFA0 and the braille blank U+2800) are removed too.
// Group 1 captures such a flag so it is put back unchanged. Built with RegExp so the `u` flag
// and \p{...} do not depend on the TypeScript target.
const INVISIBLE_OUTSIDE_EMOJI = new RegExp(
  "(\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F})|(?!\\u200D)[\\p{Cc}\\p{Cf}]|[\\u115F\\u1160\\u3164\\uFFA0\\u2800]",
  "gu",
);
const EDGE_ZWJ = new RegExp("^\\u200D+|\\u200D+$", "g");
// A ZWJ next to a space joins nothing
const ZWJ_BY_SPACE = new RegExp(" \\u200D+|\\u200D+ ", "g");
// Letters, numbers, symbols (emoji) or punctuation: something that is actually visible
const VISIBLE = new RegExp("[\\p{L}\\p{N}\\p{S}\\p{P}]", "u");

/**
 * Name as shown: whitespace runs collapsed to one space, invisible control / format
 * characters removed (they could garble the layout or disguise the name), trimmed.
 * Null when nothing visible is left.
 */
export function displayName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const normalized = name
    .replace(/\s+/g, " ")
    .replace(INVISIBLE_OUTSIDE_EMOJI, (_match, flag) => flag ?? "")
    .replace(ZWJ_BY_SPACE, " ")
    .trim()
    .replace(EDGE_ZWJ, "")
    .trim()
    .replace(/ {2,}/g, " ");
  // Only invisible marks left (variation selectors, combining marks, filler characters, ...)
  return VISIBLE.test(normalized) ? normalized : null;
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
  if (initial === "") return null;
  const upper = initial.toLocaleUpperCase("en");
  // Keep one character in the avatar: e.g. "ß" would become "SS".
  return Array.from(upper).length === Array.from(initial).length ? upper : initial;
}

/** Dashboard heading. */
export function greetingTitle(name: unknown): string {
  const shown = displayName(name);
  return shown === null ? "おかえりなさい" : `おかえりなさい、${shown} さん`;
}
