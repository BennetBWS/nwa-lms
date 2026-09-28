import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyAuthFailure,
  createSessionExpiryHandler,
  fetchSessionView,
  interpretSessionResponse,
  makeAuthFetch,
  type SessionView,
} from "./client-session";

// #30 の境界値。client-session.test.ts を補う。ネットワークは使わない（fetch / signOut は偽物）。
// データはすべてダミー。

const BASE = "http://localhost:3000";

type FakeInit = { status?: number; redirected?: boolean; url?: string; body?: unknown; jsonFails?: boolean };

function fakeResponse(init: FakeInit = {}): Response {
  const status = init.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected: init.redirected ?? false,
    url: init.url ?? `${BASE}/api/x`,
    json: async () => {
      if (init.jsonFails) throw new SyntaxError("Unexpected token <");
      return init.body;
    },
  } as unknown as Response;
}

function fetchReturning(res: Response): typeof fetch {
  return (async () => res) as unknown as typeof fetch;
}

/** 次のマイクロタスク・タイマーまで待つ */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("interpretSessionResponse の境界値", () => {
  const ok = (body: unknown) => interpretSessionResponse({ ok: true, status: 200, body });

  it("role が取れない本文はどれも STUDENT にならない（expired か error）", () => {
    const bodies: unknown[] = [
      null,
      {},
      { user: null },
      { user: undefined },
      { user: {} },
      { user: { role: undefined } },
      { user: { role: "" } },
      { user: { role: " STUDENT" } },
      { user: { role: "STUDENT " } },
      { user: { role: "Student" } },
      { user: { role: "ADMIN" } },
      { user: { role: ["STUDENT"] } },
      { user: { role: { value: "STUDENT" } } },
      { user: { role: true } },
      { user: "STUDENT" },
      { user: ["STUDENT"] },
      { user: 1 },
      { role: "STUDENT" }, // user の外に role がある
      { expires: "2099-01-01T00:00:00.000Z" }, // user がない
      "STUDENT",
      ["STUDENT"],
      [{ user: { role: "STUDENT" } }],
      "",
      0,
      1,
      true,
      false,
      undefined,
    ];
    for (const body of bodies) {
      const view = ok(body);
      assert.notEqual(view.kind, "authenticated", JSON.stringify(body) ?? String(body));
      assert.ok(view.kind === "expired" || view.kind === "error", JSON.stringify(body) ?? String(body));
    }
  });

  it("user が配列・文字列・数値なら expired（ログイン状態とみなさない）", () => {
    for (const user of ["STUDENT", ["STUDENT"], 1, true]) {
      assert.deepEqual(ok({ user }), { kind: "expired" }, JSON.stringify(user));
    }
  });

  it("本文が JSON の非オブジェクト（数値・真偽値・空文字）は error", () => {
    for (const body of [0, 1, true, false, ""]) {
      assert.deepEqual(ok(body), { kind: "error" }, JSON.stringify(body));
    }
  });

  it("4xx（ok でない）は本文に STUDENT があっても error", () => {
    for (const status of [400, 401, 403, 404, 429]) {
      assert.deepEqual(
        interpretSessionResponse({ ok: false, status, body: { user: { role: "STUDENT" } } }),
        { kind: "error" },
        String(status)
      );
    }
  });

  it("5xx で本文が null（ログアウト扱いの本文）でも error（expired にしない）", () => {
    assert.deepEqual(interpretSessionResponse({ ok: false, status: 503, body: null }), { kind: "error" });
  });

  it("name が文字列でないときは name を付けない", () => {
    for (const name of [null, 1, {}, ["x"]]) {
      assert.deepEqual(ok({ user: { role: "STUDENT", name } }), { kind: "authenticated", role: "STUDENT" }, JSON.stringify(name));
    }
    assert.deepEqual(ok({ user: { role: "STUDENT", name: "" } }), { kind: "authenticated", role: "STUDENT", name: "" });
  });

  it("余分なフィールド（email / id）は結果に出さない", () => {
    const view = ok({ user: { role: "INSTRUCTOR", name: "Dummy", email: "dummy@example.com", id: "u1" }, expires: "x" });
    assert.deepEqual(view, { kind: "authenticated", role: "INSTRUCTOR", name: "Dummy" });
  });
});

describe("fetchSessionView の境界値", () => {
  it("4xx / 5xx は error（JSON が読めても読めなくても）", async () => {
    for (const status of [401, 403, 404, 500, 502]) {
      assert.deepEqual(await fetchSessionView(fetchReturning(fakeResponse({ status, body: { user: { role: "STUDENT" } } }))), { kind: "error" });
      assert.deepEqual(await fetchSessionView(fetchReturning(fakeResponse({ status, jsonFails: true }))), { kind: "error" });
    }
  });

  it("本文 {} / {user:null} / role なし / 不正な role は expired", async () => {
    for (const body of [{}, { user: null }, { user: {} }, { user: { role: "ADMIN" } }]) {
      assert.deepEqual(await fetchSessionView(fetchReturning(fakeResponse({ body }))), { kind: "expired" }, JSON.stringify(body));
    }
  });

  it("本文が文字列・配列は error", async () => {
    for (const body of ["x", [], [{ user: { role: "STUDENT" } }]]) {
      assert.deepEqual(await fetchSessionView(fetchReturning(fakeResponse({ body }))), { kind: "error" }, JSON.stringify(body));
    }
  });

  it("fetch が同期的に例外を投げても error を返す（reject しない）", async () => {
    const fetchFn = (() => {
      throw new TypeError("sync");
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchSessionView(fetchFn), { kind: "error" });
  });

  it("json() が同期的に例外を投げても error", async () => {
    const res = {
      ok: true,
      status: 200,
      json: () => {
        throw new SyntaxError("sync");
      },
    } as unknown as Response;
    assert.deepEqual(await fetchSessionView(fetchReturning(res)), { kind: "error" });
  });

  it("STUDENT の本文は STUDENT", async () => {
    assert.deepEqual(await fetchSessionView(fetchReturning(fakeResponse({ body: { user: { role: "STUDENT" } } }))), {
      kind: "authenticated",
      role: "STUDENT",
    });
  });
});

describe("classifyAuthFailure の境界値", () => {
  it("/login の下の階層・クエリ・ハッシュ付きへのリダイレクトは expired", () => {
    for (const url of [
      `${BASE}/login/`,
      `${BASE}/login/x`,
      `${BASE}/login?callbackUrl=${encodeURIComponent(`${BASE}/`)}`,
      `${BASE}/login#top`,
      "https://nwa-lms.example.com/login?callbackUrl=%2Fapi%2Fdashboard",
    ]) {
      assert.equal(classifyAuthFailure({ status: 200, redirected: true, url }), "expired", url);
    }
  });

  it("/login に似ているが違うパスへのリダイレクトは none", () => {
    for (const url of [
      `${BASE}/loginx`,
      `${BASE}/logins`,
      `${BASE}/Login`,
      `${BASE}/x/login`,
      `${BASE}/?next=/login`,
      `${BASE}/forgot-password`,
      "/login", // 相対 URL は URL として解釈できないので none（ブラウザの res.url は常に絶対 URL）
      "not a url",
    ]) {
      assert.equal(classifyAuthFailure({ status: 200, redirected: true, url }), "none", url);
    }
  });

  it("redirected=false なら url が /login でも none", () => {
    assert.equal(classifyAuthFailure({ status: 200, redirected: false, url: `${BASE}/login` }), "none");
  });

  it("401 は redirected・url に関係なく expired", () => {
    assert.equal(classifyAuthFailure({ status: 401, redirected: true, url: `${BASE}/` }), "expired");
    assert.equal(classifyAuthFailure({ status: 401, redirected: false, url: "" }), "expired");
  });

  it("403 で /login にリダイレクトされたら expired（forbidden より優先）", () => {
    assert.equal(classifyAuthFailure({ status: 403, redirected: true, url: `${BASE}/login` }), "expired");
  });

  it("403 で /login 以外にリダイレクトされたら forbidden", () => {
    assert.equal(classifyAuthFailure({ status: 403, redirected: true, url: `${BASE}/` }), "forbidden");
  });

  it("402 / 407 / 419 / 440 などは none", () => {
    for (const status of [0, 204, 302, 307, 402, 407, 419, 440, 499]) {
      assert.equal(classifyAuthFailure({ status, redirected: false, url: `${BASE}/api/x` }), "none", String(status));
    }
  });
});

describe("createSessionExpiryHandler の境界値", () => {
  it("signOut の完了前も完了後も同じ Promise を返す", async () => {
    let release: () => void = () => {};
    const handler = createSessionExpiryHandler({
      signOut: () => new Promise<void>((resolve) => (release = resolve)),
      fallback: () => {},
    });
    const first = handler();
    const second = handler();
    assert.equal(first, second);
    release();
    await first;
    assert.equal(handler(), first);
  });

  it("連続呼び出し（前の呼び出しの完了後）でも signOut は 1 回", async () => {
    let signOutCalls = 0;
    const handler = createSessionExpiryHandler({
      signOut: async () => {
        signOutCalls++;
      },
      fallback: () => assert.fail("fallback は呼ばれない"),
    });
    for (let i = 0; i < 10; i++) await handler();
    assert.equal(signOutCalls, 1);
  });

  it("signOut が同期的に例外を投げても fallback を 1 回だけ呼び、reject しない", async () => {
    let signOutCalls = 0;
    let fallbackCalls = 0;
    const handler = createSessionExpiryHandler({
      signOut: (() => {
        signOutCalls++;
        throw new Error("sync");
      }) as () => Promise<void>,
      fallback: () => {
        fallbackCalls++;
      },
    });
    await assert.doesNotReject(Promise.all([handler(), handler(), handler()]));
    await assert.doesNotReject(handler());
    assert.equal(signOutCalls, 1);
    assert.equal(fallbackCalls, 1);
  });

  it("signOut の reject 後に並行・連続で呼んでも fallback は 1 回", async () => {
    let fallbackCalls = 0;
    let rejectSignOut: (e: Error) => void = () => {};
    const handler = createSessionExpiryHandler({
      signOut: () => new Promise<void>((_, reject) => (rejectSignOut = reject)),
      fallback: () => {
        fallbackCalls++;
      },
    });
    const all = Promise.all([handler(), handler(), handler(), handler(), handler()]);
    rejectSignOut(new Error("network"));
    await all;
    await handler();
    await handler();
    assert.equal(fallbackCalls, 1);
  });

  it("fallback が例外を投げても、その後の呼び出しで signOut / fallback を再実行しない", async () => {
    let signOutCalls = 0;
    let fallbackCalls = 0;
    const handler = createSessionExpiryHandler({
      signOut: async () => {
        signOutCalls++;
        throw new Error("x");
      },
      fallback: () => {
        fallbackCalls++;
        throw new Error("y");
      },
    });
    await assert.doesNotReject(handler());
    await assert.doesNotReject(handler());
    assert.equal(signOutCalls, 1);
    assert.equal(fallbackCalls, 1);
  });

  it("signOut が非 Error 値（文字列・undefined）で reject しても fallback が動く", async () => {
    for (const reason of ["str", undefined, null]) {
      let fallbackCalls = 0;
      const handler = createSessionExpiryHandler({
        signOut: () => Promise.reject(reason),
        fallback: () => {
          fallbackCalls++;
        },
      });
      await assert.doesNotReject(handler());
      assert.equal(fallbackCalls, 1, String(reason));
    }
  });

  it("ハンドラごとに状態は独立（別インスタンスはそれぞれ 1 回ずつ signOut）", async () => {
    let calls = 0;
    const deps = {
      signOut: async () => {
        calls++;
      },
      fallback: () => {},
    };
    await createSessionExpiryHandler(deps)();
    await createSessionExpiryHandler(deps)();
    assert.equal(calls, 2);
  });
});

describe("makeAuthFetch の境界値", () => {
  function build(opts: {
    response: Response | ((input: string) => Response);
    session?: SessionView | "throws" | "rejects" | (() => Promise<SessionView>);
    onExpired?: () => Promise<void>;
  }) {
    const counts = { fetch: 0, check: 0, expired: 0 };
    const authFetch = makeAuthFetch({
      fetch: (async (input: string) => {
        counts.fetch++;
        return typeof opts.response === "function" ? opts.response(input) : opts.response;
      }) as unknown as typeof fetch,
      onExpired:
        opts.onExpired ??
        (async () => {
          counts.expired++;
        }),
      checkSession: (() => {
        counts.check++;
        const s = opts.session ?? { kind: "authenticated", role: "INSTRUCTOR" };
        if (s === "throws") throw new Error("sync");
        if (s === "rejects") return Promise.reject(new Error("async"));
        if (typeof s === "function") return s();
        return Promise.resolve(s);
      }) as () => Promise<SessionView>,
    });
    return { authFetch, counts };
  }

  it("/login 以外へのリダイレクト（200）では onExpired も checkSession も呼ばない", async () => {
    const res = fakeResponse({ status: 200, redirected: true, url: `${BASE}/` });
    const { authFetch, counts } = build({ response: res });
    assert.equal(await authFetch("/api/courses"), res);
    assert.deepEqual(counts, { fetch: 1, check: 0, expired: 0 });
  });

  it("/login?callbackUrl=... へのリダイレクトは onExpired 1 回、checkSession なし", async () => {
    const res = fakeResponse({
      status: 200,
      redirected: true,
      url: `${BASE}/login?callbackUrl=${encodeURIComponent(`${BASE}/api/dashboard`)}`,
    });
    const { authFetch, counts } = build({ response: res });
    assert.equal(await authFetch("/api/dashboard"), res);
    assert.deepEqual(counts, { fetch: 1, check: 0, expired: 1 });
  });

  it("403 で checkSession が同期的に例外 / reject しても Response を返し、onExpired は呼ばない", async () => {
    for (const session of ["throws", "rejects"] as const) {
      const res = fakeResponse({ status: 403 });
      const { authFetch, counts } = build({ response: res, session });
      assert.equal(await authFetch("/api/admin/courses"), res);
      assert.deepEqual(counts, { fetch: 1, check: 1, expired: 0 }, session);
    }
  });

  it("403 で session が loading（想定外の値）でも onExpired は呼ばない", async () => {
    const res = fakeResponse({ status: 403 });
    const { authFetch, counts } = build({ response: res, session: { kind: "loading" } });
    assert.equal(await authFetch("/api/admin/courses"), res);
    assert.deepEqual(counts, { fetch: 1, check: 1, expired: 0 });
  });

  it("onExpired が同期的に例外を投げても Response を返す（401 / 403+expired）", async () => {
    for (const [status, session] of [
      [401, undefined],
      [403, { kind: "expired" } as SessionView],
    ] as const) {
      const res = fakeResponse({ status });
      const { authFetch } = build({
        response: res,
        session,
        onExpired: (() => {
          throw new Error("sync");
        }) as () => Promise<void>,
      });
      assert.equal(await authFetch("/api/x"), res, String(status));
    }
  });

  it("Response の本文は読まない（呼び出し側が json() を 1 回だけ読める）", async () => {
    let jsonCalls = 0;
    const res = {
      status: 403,
      ok: false,
      redirected: false,
      url: `${BASE}/api/admin/students`,
      json: async () => {
        jsonCalls++;
        return { error: "Forbidden" };
      },
    } as unknown as Response;
    const { authFetch } = build({ response: res, session: { kind: "expired" } });
    await authFetch("/api/admin/students?status=all");
    assert.equal(jsonCalls, 0);
  });

  it("onExpired の完了を待ってから Response を返す", async () => {
    const order: string[] = [];
    const res = fakeResponse({ status: 401 });
    const { authFetch } = build({
      response: res,
      onExpired: async () => {
        await tick();
        order.push("expired");
      },
    });
    await authFetch("/api/x");
    order.push("returned");
    assert.deepEqual(order, ["expired", "returned"]);
  });

  it("403 が並行して 5 件：checkSession は 5 回（重複排除はしない）、expired なら onExpired も 5 回。signOut は createSessionExpiryHandler 経由で 1 回", async () => {
    let signOutCalls = 0;
    const expire = createSessionExpiryHandler({
      signOut: async () => {
        signOutCalls++;
        await tick();
      },
      fallback: () => assert.fail("fallback は呼ばれない"),
    });
    const counts = { check: 0, expired: 0 };
    const res = fakeResponse({ status: 403 });
    const authFetch = makeAuthFetch({
      fetch: (async () => res) as unknown as typeof fetch,
      onExpired: () => {
        counts.expired++;
        return expire();
      },
      checkSession: async () => {
        counts.check++;
        await tick();
        return { kind: "expired" };
      },
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => authFetch("/api/admin/courses")));
    for (const r of results) assert.equal(r, res);
    assert.deepEqual(counts, { check: 5, expired: 5 });
    assert.equal(signOutCalls, 1);
  });

  it("403 が並行して 5 件で本当の権限なし（authenticated）：checkSession 5 回、onExpired 0 回", async () => {
    const res = fakeResponse({ status: 403 });
    const { authFetch, counts } = build({ response: res, session: { kind: "authenticated", role: "STUDENT" } });
    await Promise.all(Array.from({ length: 5 }, () => authFetch("/api/admin/courses")));
    assert.deepEqual(counts, { fetch: 5, check: 5, expired: 0 });
  });

  it("401 と 200 が混在：onExpired は 401 の件数分だけ", async () => {
    const { authFetch, counts } = build({
      response: (input) => fakeResponse({ status: input.includes("dashboard") ? 401 : 200 }),
    });
    await Promise.all([authFetch("/api/dashboard"), authFetch("/api/courses"), authFetch("/api/dashboard")]);
    assert.deepEqual(counts, { fetch: 3, check: 0, expired: 2 });
  });

  it("fetch の同期例外もそのまま投げ、onExpired / checkSession は呼ばない", async () => {
    let expired = 0;
    let checked = 0;
    const authFetch = makeAuthFetch({
      fetch: (() => {
        throw new TypeError("sync");
      }) as unknown as typeof fetch,
      onExpired: async () => {
        expired++;
      },
      checkSession: async () => {
        checked++;
        return { kind: "expired" };
      },
    });
    await assert.rejects(authFetch("/api/x"), TypeError);
    assert.equal(expired, 0);
    assert.equal(checked, 0);
  });

  it("input と init をそのまま fetch に渡す（init 省略時は undefined）", async () => {
    const seen: unknown[][] = [];
    const authFetch = makeAuthFetch({
      fetch: (async (...args: unknown[]) => {
        seen.push(args);
        return fakeResponse();
      }) as unknown as typeof fetch,
      onExpired: async () => {},
      checkSession: async () => ({ kind: "error" }),
    });
    await authFetch("/api/notifications");
    const init = { method: "PUT" };
    await authFetch("/api/admin/students/s1/deactivate", init);
    assert.deepEqual(seen[0], ["/api/notifications", undefined]);
    assert.equal(seen[1][0], "/api/admin/students/s1/deactivate");
    assert.equal(seen[1][1], init);
  });
});
