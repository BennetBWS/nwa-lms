/**
 * Client-side handling of revoked sessions (#30).
 *
 * The main page (src/app/page.tsx) asks /api/auth/session who is signed in and
 * wraps its API calls with `makeAuthFetch`. When the session turns out to be
 * revoked (#11: deactivation, password change), the page signs out once and goes
 * to /login instead of rendering empty data.
 *
 * No React, DOM or next-auth here: the browser pieces (fetch, signOut, location)
 * are passed in, so everything can be unit tested.
 */

export type SessionRole = "STUDENT" | "INSTRUCTOR";

export type SessionView =
  | { kind: "loading" }
  | { kind: "authenticated"; role: SessionRole; name?: string }
  /** The body is null / has no user / the role is not a known one. */
  | { kind: "expired" }
  /** Network failure, non-OK status (5xx etc.), or a body that is not JSON. */
  | { kind: "error" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionRole(value: unknown): value is SessionRole {
  return value === "STUDENT" || value === "INSTRUCTOR";
}

/**
 * Interprets the response of GET /api/auth/session.
 *
 * `input` is null when the request itself failed. `body` is the parsed JSON, or
 * `undefined` when the body could not be parsed (JSON never yields `undefined`).
 *
 * A session whose role cannot be read is "expired", never a STUDENT: an
 * instructor must not be shown the student screens with empty data.
 */
export function interpretSessionResponse(
  input: { ok: boolean; status: number; body: unknown } | null
): SessionView {
  if (input === null) return { kind: "error" };
  if (!input.ok) return { kind: "error" };
  const { body } = input;
  if (body === null) return { kind: "expired" };
  if (!isRecord(body)) return { kind: "error" };
  const user = body.user;
  if (!isRecord(user)) return { kind: "expired" };
  if (!isSessionRole(user.role)) return { kind: "expired" };
  if (typeof user.name === "string") return { kind: "authenticated", role: user.role, name: user.name };
  return { kind: "authenticated", role: user.role };
}

/**
 * GET /api/auth/session and interpret it. Never throws.
 *
 * This request also clears the cookie when the session is revoked (the Node-side
 * jwt callback returns null, #11). Pass a fetch that is bound to the window
 * (e.g. `(i, init) => fetch(i, init)`).
 */
export async function fetchSessionView(fetchFn: typeof fetch): Promise<SessionView> {
  let res: Response;
  try {
    res = await fetchFn("/api/auth/session", { cache: "no-store" });
  } catch {
    return interpretSessionResponse(null);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return interpretSessionResponse({ ok: res.ok, status: res.status, body });
}

export type AuthFailure = "expired" | "forbidden" | "none";

function isLoginUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return pathname === "/login" || pathname.startsWith("/login/");
  } catch {
    return false;
  }
}

/**
 * Classifies an API response.
 * - 401, or redirected to /login: "expired"
 * - 403: "forbidden" (the admin APIs answer 403 both to a revoked session and to
 *   a student; tell them apart with /api/auth/session, see makeAuthFetch)
 * - anything else: "none"
 */
export function classifyAuthFailure(input: { status: number; redirected: boolean; url: string }): AuthFailure {
  if (input.redirected && isLoginUrl(input.url)) return "expired";
  if (input.status === 401) return "expired";
  if (input.status === 403) return "forbidden";
  return "none";
}

/**
 * Returns a function that signs out and goes to /login. However many times it is
 * called (e.g. several API calls failing at once), `signOut` runs only once and
 * every call gets the same promise, which never rejects.
 *
 * `signOut` should include the dynamic import of next-auth/react. If it fails,
 * `fallback` runs once (it should clear the cookie through /api/auth/session and
 * then `location.assign("/login")`).
 */
export function createSessionExpiryHandler(deps: {
  signOut: () => Promise<void>;
  fallback: () => void;
}): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => {
    if (pending === null) {
      pending = (async () => {
        try {
          await deps.signOut();
        } catch {
          try {
            deps.fallback();
          } catch {
            // Nothing more can be done here; the page keeps showing the loading state.
          }
        }
      })();
    }
    return pending;
  };
}

/**
 * Wraps fetch for the page's API calls.
 * - "expired" (401 / redirected to /login): calls `onExpired`.
 * - 403: asks `checkSession`; calls `onExpired` only if the session is expired.
 *   Otherwise (a real "forbidden", or the check failed) nothing happens.
 * The Response is always returned as is, so callers keep their own handling.
 * Network errors of `fetch` are thrown as before.
 */
export function makeAuthFetch(deps: {
  fetch: typeof fetch;
  onExpired: () => Promise<void>;
  checkSession: () => Promise<SessionView>;
}): (input: string, init?: RequestInit) => Promise<Response> {
  const expire = async () => {
    try {
      await deps.onExpired();
    } catch {
      // The Response is still returned to the caller.
    }
  };
  return async (input, init) => {
    const res = await deps.fetch(input, init);
    const failure = classifyAuthFailure({ status: res.status, redirected: res.redirected, url: res.url });
    if (failure === "expired") {
      await expire();
    } else if (failure === "forbidden") {
      let view: SessionView;
      try {
        view = await deps.checkSession();
      } catch {
        view = { kind: "error" };
      }
      if (view.kind === "expired") await expire();
    }
    return res;
  };
}
