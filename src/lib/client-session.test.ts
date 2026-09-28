import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyAuthFailure,
  createSessionExpiryHandler,
  fetchSessionView,
  interpretSessionResponse,
  makeAuthFetch,
  type SessionView,
} from "./client-session";
import { MIDDLEWARE_MATCHER } from "./middleware-matcher";

// #30. No network: fetch, signOut and the fallback are fakes. All data are dummies.

const BASE = "http://localhost:3000";

type FakeResponseInit = { status?: number; redirected?: boolean; url?: string; body?: unknown; jsonFails?: boolean };

function fakeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const res = {
    status,
    ok: status >= 200 && status < 300,
    redirected: init.redirected ?? false,
    url: init.url ?? `${BASE}/api/x`,
    json: async () => {
      if (init.jsonFails) throw new SyntaxError("Unexpected token <");
      return init.body;
    },
  };
  return res as unknown as Response;
}

describe("interpretSessionResponse", () => {
  it("network failure is error", () => {
    assert.deepEqual(interpretSessionResponse(null), { kind: "error" });
  });

  it("5xx is error", () => {
    assert.deepEqual(interpretSessionResponse({ ok: false, status: 500, body: { user: { role: "STUDENT" } } }), { kind: "error" });
    assert.deepEqual(interpretSessionResponse({ ok: false, status: 502, body: undefined }), { kind: "error" });
  });

  it("a body that is not JSON (undefined) is error", () => {
    assert.deepEqual(interpretSessionResponse({ ok: true, status: 200, body: undefined }), { kind: "error" });
  });

  it("a JSON body that is not an object is error", () => {
    assert.deepEqual(interpretSessionResponse({ ok: true, status: 200, body: "x" }), { kind: "error" });
    assert.deepEqual(interpretSessionResponse({ ok: true, status: 200, body: [] }), { kind: "error" });
  });

  it("null body (revoked or no session) is expired", () => {
    assert.deepEqual(interpretSessionResponse({ ok: true, status: 200, body: null }), { kind: "expired" });
  });

  it("no user is expired", () => {
    assert.deepEqual(interpretSessionResponse({ ok: true, status: 200, body: {} }), { kind: "expired" });
    assert.deepEqual(interpretSessionResponse({ ok: true, status: 200, body: { user: null } }), { kind: "expired" });
  });

  it("a role that cannot be read is expired, never STUDENT", () => {
    for (const user of [{}, { role: null }, { role: "ADMIN" }, { role: "student" }, { role: 1 }, { name: "Dummy" }]) {
      const view = interpretSessionResponse({ ok: true, status: 200, body: { user } });
      assert.deepEqual(view, { kind: "expired" }, JSON.stringify(user));
      assert.notEqual(view.kind === "authenticated" ? view.role : null, "STUDENT");
    }
  });

  it("STUDENT and INSTRUCTOR are authenticated with their role", () => {
    assert.deepEqual(
      interpretSessionResponse({ ok: true, status: 200, body: { user: { role: "STUDENT", name: "Dummy Student" } } }),
      { kind: "authenticated", role: "STUDENT", name: "Dummy Student" }
    );
    assert.deepEqual(
      interpretSessionResponse({ ok: true, status: 200, body: { user: { role: "INSTRUCTOR" }, expires: "x" } }),
      { kind: "authenticated", role: "INSTRUCTOR" }
    );
  });
});

describe("fetchSessionView", () => {
  it("asks /api/auth/session without cache", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchFn = (async (input: string, init?: RequestInit) => {
      calls.push({ input, init });
      return fakeResponse({ body: { user: { role: "INSTRUCTOR" } } });
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchSessionView(fetchFn), { kind: "authenticated", role: "INSTRUCTOR" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, "/api/auth/session");
    assert.equal(calls[0].init?.cache, "no-store");
  });

  it("network failure is error (does not throw)", async () => {
    const fetchFn = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchSessionView(fetchFn), { kind: "error" });
  });

  it("a body that is not JSON is error", async () => {
    const fetchFn = (async () => fakeResponse({ jsonFails: true })) as unknown as typeof fetch;
    assert.deepEqual(await fetchSessionView(fetchFn), { kind: "error" });
  });

  it("null body is expired", async () => {
    const fetchFn = (async () => fakeResponse({ body: null })) as unknown as typeof fetch;
    assert.deepEqual(await fetchSessionView(fetchFn), { kind: "expired" });
  });
});

describe("classifyAuthFailure", () => {
  it("401 is expired", () => {
    assert.equal(classifyAuthFailure({ status: 401, redirected: false, url: `${BASE}/api/dashboard` }), "expired");
  });

  it("a redirect to /login is expired", () => {
    assert.equal(classifyAuthFailure({ status: 200, redirected: true, url: `${BASE}/login?callbackUrl=%2F` }), "expired");
    assert.equal(classifyAuthFailure({ status: 200, redirected: true, url: `${BASE}/login` }), "expired");
  });

  it("a redirect elsewhere is none", () => {
    assert.equal(classifyAuthFailure({ status: 200, redirected: true, url: `${BASE}/` }), "none");
    assert.equal(classifyAuthFailure({ status: 200, redirected: true, url: `${BASE}/loginhelp` }), "none");
    assert.equal(classifyAuthFailure({ status: 200, redirected: true, url: "" }), "none");
  });

  it("403 is forbidden", () => {
    assert.equal(classifyAuthFailure({ status: 403, redirected: false, url: `${BASE}/api/admin/students` }), "forbidden");
  });

  it("other statuses are none", () => {
    for (const status of [200, 201, 400, 404, 409, 500, 503]) {
      assert.equal(classifyAuthFailure({ status, redirected: false, url: `${BASE}/api/x` }), "none", String(status));
    }
  });
});

describe("createSessionExpiryHandler", () => {
  it("signs out once however many times it is called (5 in parallel)", async () => {
    let signOutCalls = 0;
    let fallbackCalls = 0;
    let release: () => void = () => {};
    const handler = createSessionExpiryHandler({
      signOut: () => {
        signOutCalls++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      fallback: () => {
        fallbackCalls++;
      },
    });
    const all = Promise.all([handler(), handler(), handler(), handler(), handler()]);
    release();
    await all;
    await handler();
    assert.equal(signOutCalls, 1);
    assert.equal(fallbackCalls, 0);
  });

  it("falls back once when signOut (including its dynamic import) fails", async () => {
    let signOutCalls = 0;
    let fallbackCalls = 0;
    const handler = createSessionExpiryHandler({
      signOut: async () => {
        signOutCalls++;
        throw new Error("ChunkLoadError");
      },
      fallback: () => {
        fallbackCalls++;
      },
    });
    await Promise.all([handler(), handler(), handler(), handler(), handler()]);
    await handler();
    assert.equal(signOutCalls, 1);
    assert.equal(fallbackCalls, 1);
  });

  it("does not reject even if the fallback throws", async () => {
    const handler = createSessionExpiryHandler({
      signOut: async () => {
        throw new Error("x");
      },
      fallback: () => {
        throw new Error("y");
      },
    });
    await assert.doesNotReject(handler());
  });
});

describe("makeAuthFetch", () => {
  function setup(response: Response, session: SessionView | "throws" = { kind: "authenticated", role: "INSTRUCTOR" }) {
    const counts = { fetch: 0, expired: 0, check: 0 };
    const seen: Array<{ input: string; init?: RequestInit }> = [];
    const authFetch = makeAuthFetch({
      fetch: (async (input: string, init?: RequestInit) => {
        counts.fetch++;
        seen.push({ input, init });
        return response;
      }) as unknown as typeof fetch,
      onExpired: async () => {
        counts.expired++;
      },
      checkSession: async () => {
        counts.check++;
        if (session === "throws") throw new Error("x");
        return session;
      },
    });
    return { authFetch, counts, seen };
  }

  it("200: returns the response, no check, no expiry", async () => {
    const res = fakeResponse({ status: 200, body: [] });
    const { authFetch, counts, seen } = setup(res);
    const init: RequestInit = { method: "POST", body: "{}" };
    assert.equal(await authFetch("/api/progress", init), res);
    assert.deepEqual(counts, { fetch: 1, expired: 0, check: 0 });
    assert.equal(seen[0].input, "/api/progress");
    assert.equal(seen[0].init, init);
  });

  it("401: calls onExpired without asking the session, returns the response", async () => {
    const res = fakeResponse({ status: 401, body: { error: "Unauthorized" } });
    const { authFetch, counts } = setup(res);
    assert.equal(await authFetch("/api/dashboard"), res);
    assert.deepEqual(counts, { fetch: 1, expired: 1, check: 0 });
  });

  it("redirected to /login: calls onExpired", async () => {
    const res = fakeResponse({ status: 200, redirected: true, url: `${BASE}/login?callbackUrl=%2F` });
    const { authFetch, counts } = setup(res);
    assert.equal(await authFetch("/api/courses"), res);
    assert.deepEqual(counts, { fetch: 1, expired: 1, check: 0 });
  });

  it("403 with an expired session: calls onExpired", async () => {
    const res = fakeResponse({ status: 403, body: { error: "Forbidden" } });
    const { authFetch, counts } = setup(res, { kind: "expired" });
    assert.equal(await authFetch("/api/admin/students?status=all"), res);
    assert.deepEqual(counts, { fetch: 1, expired: 1, check: 1 });
  });

  it("403 with an authenticated session (real forbidden): no expiry", async () => {
    const res = fakeResponse({ status: 403, body: { error: "Forbidden" } });
    const { authFetch, counts } = setup(res, { kind: "authenticated", role: "STUDENT" });
    assert.equal(await authFetch("/api/admin/courses"), res);
    assert.deepEqual(counts, { fetch: 1, expired: 0, check: 1 });
  });

  it("403 when the session check fails (error or throws): no expiry", async () => {
    for (const session of [{ kind: "error" } as SessionView, "throws" as const]) {
      const res = fakeResponse({ status: 403 });
      const { authFetch, counts } = setup(res, session);
      assert.equal(await authFetch("/api/admin/courses"), res);
      assert.deepEqual(counts, { fetch: 1, expired: 0, check: 1 });
    }
  });

  it("other errors (400 / 500): no check, no expiry", async () => {
    for (const status of [400, 404, 500]) {
      const res = fakeResponse({ status });
      const { authFetch, counts } = setup(res);
      assert.equal(await authFetch("/api/x"), res);
      assert.deepEqual(counts, { fetch: 1, expired: 0, check: 0 }, String(status));
    }
  });

  it("still returns the response when onExpired rejects", async () => {
    const res = fakeResponse({ status: 401 });
    const authFetch = makeAuthFetch({
      fetch: (async () => res) as unknown as typeof fetch,
      onExpired: async () => {
        throw new Error("x");
      },
      checkSession: async () => ({ kind: "expired" }),
    });
    assert.equal(await authFetch("/api/x"), res);
  });

  it("network errors are thrown as before, without expiry", async () => {
    let expired = 0;
    const authFetch = makeAuthFetch({
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
      onExpired: async () => {
        expired++;
      },
      checkSession: async () => ({ kind: "expired" }),
    });
    await assert.rejects(authFetch("/api/x"), TypeError);
    assert.equal(expired, 0);
  });
});

describe("middleware matcher (#30)", () => {
  // Approximation: `new RegExp("^" + p + "$")` is not how Next.js compiles the matcher
  // (it goes through path-to-regexp and adds prefixes such as /_next/data/<id> and a
  // `.json` suffix), so this does not match Next's interpretation exactly. It checks
  // the intent of the pattern: pages are matched, /api and /api/* are not.
  const re = new RegExp("^" + MIDDLEWARE_MATCHER + "$");

  for (const path of ["/", "/login", "/reset-password", "/apiary"]) {
    it(`matches ${path}`, () => {
      assert.equal(re.test(path), true);
    });
  }

  for (const path of ["/api/dashboard", "/api/auth/session", "/api", "/_next/static/x.js", "/favicon.ico"]) {
    it(`does not match ${path}`, () => {
      assert.equal(re.test(path), false);
    });
  }

  it("src/middleware.ts has the same literal as MIDDLEWARE_MATCHER", () => {
    // Next.js only reads a literal `config.matcher`, so the middleware cannot import the
    // constant. Compare the source text instead.
    const source = readFileSync(join(__dirname, "..", "middleware.ts"), "utf8");
    const match = /matcher:\s*\[\s*("(?:[^"\\]|\\.)*")\s*,?\s*\]/.exec(source);
    assert.ok(match, "config.matcher with a single string literal");
    assert.equal(JSON.parse(match[1]), MIDDLEWARE_MATCHER);
  });
});
