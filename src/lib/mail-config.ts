/**
 * Mail (Resend) configuration read from environment variables (#9).
 *
 * Values are validated here and never included in logs or error messages.
 * Callers only get the names of the variables that are missing or invalid.
 */

export type MailEnvName = "RESEND_API_KEY" | "MAIL_FROM" | "APP_BASE_URL" | "MAIL_REPLY_TO";

export type MailConfig = {
  apiKey: string;
  from: string;
  replyTo?: string;
  appBaseUrl: string;
};

export type MailConfigResult =
  | { ok: true; config: MailConfig }
  | { ok: false; missing: MailEnvName[]; invalid: MailEnvName[] };

// C0 control characters (including CR / LF / TAB) and DEL.
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/** Returns the trimmed value, or undefined when unset or blank. */
function readValue(env: NodeJS.ProcessEnv, name: MailEnvName): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * True when a (trimmed) value contains a control character. Leading/trailing
 * line breaks are removed by trim before this check, so only ones that would
 * remain in the value actually used are rejected.
 */
function hasControlChar(value: string): boolean {
  return CONTROL_CHAR.test(value);
}

/**
 * Minimal address check (not a full RFC 5322 validation): exactly one `@`,
 * non-empty local part and domain, no whitespace and no angle brackets.
 */
function isSimpleAddress(addr: string): boolean {
  if (/[\s<>]/.test(addr)) return false;
  const parts = addr.split("@");
  return parts.length === 2 && parts[0] !== "" && parts[1] !== "";
}

/**
 * Accepts `addr` or `Display Name <addr>`. The display name may contain
 * spaces and non-ASCII characters. Control characters are never allowed.
 * The part inside the angle brackets is not trimmed (`Name < a@b >` is invalid).
 */
function isValidMailbox(value: string): boolean {
  if (hasControlChar(value)) return false;
  const named = /^([^<>]*)<([^<>]+)>$/.exec(value);
  if (named) return isSimpleAddress(named[2]);
  return isSimpleAddress(value);
}

/** Returns the normalized origin, or undefined when the value is not acceptable. */
function normalizeAppBaseUrl(value: string, env: NodeJS.ProcessEnv): string | undefined {
  if (hasControlChar(value) || value.includes("?") || value.includes("#")) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  const isProduction = env.VERCEL_ENV === "production";
  if (url.protocol === "http:") {
    if (isProduction || !LOCAL_HOSTNAMES.has(url.hostname)) return undefined;
  } else if (url.protocol !== "https:") {
    return undefined;
  }

  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (url.pathname !== "/") return undefined;

  return url.origin;
}

export function readMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfigResult {
  const missing: MailEnvName[] = [];
  const invalid: MailEnvName[] = [];

  const apiKey = readValue(env, "RESEND_API_KEY");
  if (apiKey === undefined) missing.push("RESEND_API_KEY");

  const from = readValue(env, "MAIL_FROM");
  if (from === undefined) missing.push("MAIL_FROM");
  else if (!isValidMailbox(from)) invalid.push("MAIL_FROM");

  const baseUrlValue = readValue(env, "APP_BASE_URL");
  let appBaseUrl: string | undefined;
  if (baseUrlValue === undefined) missing.push("APP_BASE_URL");
  else {
    appBaseUrl = normalizeAppBaseUrl(baseUrlValue, env);
    if (appBaseUrl === undefined) invalid.push("APP_BASE_URL");
  }

  // Optional: unset is fine, but a set value must be valid.
  const replyTo = readValue(env, "MAIL_REPLY_TO");
  if (replyTo !== undefined && !isValidMailbox(replyTo)) {
    invalid.push("MAIL_REPLY_TO");
  }

  if (
    missing.length > 0 ||
    invalid.length > 0 ||
    apiKey === undefined ||
    from === undefined ||
    appBaseUrl === undefined
  ) {
    return { ok: false, missing, invalid };
  }

  const config: MailConfig = { apiKey, from, appBaseUrl };
  if (replyTo !== undefined) config.replyTo = replyTo;
  return { ok: true, config };
}

/** Builds the password reset URL from the configured base URL (never from request headers). */
export function buildResetUrl(appBaseUrl: string, token: string): string {
  const url = new URL("/reset-password", appBaseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}
