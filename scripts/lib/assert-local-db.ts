/**
 * Guard for destructive seed scripts.
 *
 * Throws unless every provided database URL points at a local host and the
 * process is not running in a production / Vercel environment.
 *
 * Error messages include only the hostname. They never include the full URL,
 * username or password.
 */

// Characters that end the URL authority. If one of them appears in the raw userinfo
// (an unencoded "#", "/" or "?" in the password), the URL parser stops the authority
// early and reads "user:<password digits>" as host:port, so the "hostname" would be
// the username. Such URLs are treated as unparsable and nothing from them is shown.
const AUTHORITY_TERMINATORS = /[#/?]/;

/**
 * Parse a database URL, or return null when it cannot be parsed safely.
 *
 * Returns null when `new URL()` throws, and also when the raw userinfo (between the
 * scheme's "//" and the last "@") contains "#", "/" or "?": the parsed hostname would
 * then come from the username / password. Callers must not print anything from the
 * raw string when this returns null.
 */
export function parseDatabaseUrl(raw: string): URL | null {
  const schemeEnd = raw.indexOf("//");
  if (schemeEnd !== -1) {
    const rest = raw.slice(schemeEnd + 2);
    const at = rest.lastIndexOf("@");
    if (at !== -1 && AUTHORITY_TERMINATORS.test(rest.slice(0, at))) {
      return null;
    }
  }

  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "host.docker.internal",
]);

// Postgres / Prisma honour these query parameters over the URL authority host,
// so a local-looking URL could still connect elsewhere. Always reject them.
const FORBIDDEN_QUERY_PARAMS: ReadonlySet<string> = new Set(["host", "hostaddr"]);

export function assertLocalDatabase(urls: Array<string | undefined>): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run: NODE_ENV is \"production\". Seed scripts may only run against a local database."
    );
  }

  if (process.env.VERCEL_ENV) {
    throw new Error(
      "Refusing to run: VERCEL_ENV is set. Seed scripts may only run against a local database."
    );
  }

  const defined = urls.filter((u): u is string => u !== undefined);
  if (defined.length === 0) {
    throw new Error(
      "Refusing to run: no database URL is set. Seed scripts may only run against a local database."
    );
  }

  defined.forEach((raw, index) => {
    const parsed = parseDatabaseUrl(raw);
    if (parsed === null) {
      throw new Error(
        `Refusing to run: database URL #${index + 1} could not be parsed.`
      );
    }

    // Report only the (normalised) parameter name, never its value.
    for (const key of Array.from(parsed.searchParams.keys())) {
      const name = key.toLowerCase();
      if (FORBIDDEN_QUERY_PARAMS.has(name)) {
        throw new Error(
          `Refusing to run: database URL #${index + 1} query parameter "${name}" is not allowed.`
        );
      }
    }

    const hostname = parsed.hostname.toLowerCase();

    if (!ALLOWED_HOSTNAMES.has(hostname)) {
      const shown = hostname === "" ? "(empty)" : hostname;
      throw new Error(
        `Refusing to run: database host "${shown}" is not local. Seed scripts may only run against a local database.`
      );
    }
  });
}
