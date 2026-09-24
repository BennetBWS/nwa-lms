/**
 * Guard for destructive seed scripts.
 *
 * Throws unless every provided database URL points at a local host and the
 * process is not running in a production / Vercel environment.
 *
 * Error messages include only the hostname. They never include the full URL,
 * username or password.
 */

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
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(
        `Refusing to run: database URL #${index + 1} could not be parsed.`
      );
    }

    // Report only the (normalised) parameter name, never its value.
    for (const key of parsed.searchParams.keys()) {
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
