import { mock } from "node:test";

// Shared helpers for the forgot-password route tests (#12).
//
// SAFETY: the route imports `prisma` from src/lib/prisma.ts, which reuses
// `globalThis.prisma` when present. Tests install a fake there BEFORE importing
// the route, so no PrismaClient is created and no database is contacted.
// All addresses are example.com dummies.

export const USER_EMAIL = "student-12@example.com";
export const USER_ID = "user_dummy_12";
export const OTHER_EMAIL = "nobody-12@example.com";

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type Call = { method: string; args: unknown[] };

export type FakePrisma = {
  calls: Call[];
  createdTokens: string[];
  failWith: unknown;
  user: { findUnique: (args: { where: { email: string } }) => Promise<unknown> };
  passwordReset: {
    updateMany: (args: unknown) => Promise<{ count: number }>;
    create: (args: { data: { token: string } }) => Promise<unknown>;
  };
};

export function installFakePrisma(): FakePrisma {
  const fake: FakePrisma = {
    calls: [],
    createdTokens: [],
    failWith: undefined,
    user: {
      async findUnique(args) {
        fake.calls.push({ method: "user.findUnique", args: [args] });
        if (fake.failWith !== undefined) throw fake.failWith;
        return args.where.email === USER_EMAIL
          ? { id: USER_ID, email: USER_EMAIL, name: "Dummy Student" }
          : null;
      },
    },
    passwordReset: {
      async updateMany(args) {
        fake.calls.push({ method: "passwordReset.updateMany", args: [args] });
        return { count: 1 };
      },
      async create(args) {
        fake.calls.push({ method: "passwordReset.create", args: [args] });
        fake.createdTokens.push(args.data.token);
        return { id: "pr_dummy", ...args.data };
      },
    },
  };
  (globalThis as unknown as { prisma: unknown }).prisma = fake;
  return fake;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
export type LogEntry = { level: (typeof CONSOLE_METHODS)[number]; text: string };

/** Replace every console method with a capturing mock. Returns the captured entries. */
export function captureConsole(): LogEntry[] {
  const logs: LogEntry[] = [];
  for (const level of CONSOLE_METHODS) {
    mock.method(console, level, (...args: unknown[]) => {
      logs.push({ level, text: args.map(stringifyArg).join(" ") });
    });
  }
  return logs;
}

function stringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) {
    return `${a.name} ${a.message} ${a.stack ?? ""} ${JSON.stringify(a)}`;
  }
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Asserts that no captured log line contains any sensitive value. Returns offending lines. */
export function findLeaks(logs: LogEntry[], secrets: string[]): string[] {
  return logs
    .map((l) => l.text)
    .filter(
      (t) =>
        UUID_RE.test(t) ||
        t.includes("reset-password?token=") ||
        t.includes("token=") ||
        secrets.some((s) => s && t.includes(s))
    );
}
