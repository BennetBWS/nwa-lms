import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import {
  OTHER_EMAIL,
  USER_EMAIL,
  USER_ID,
  captureConsole,
  findLeaks,
  installFakePrisma,
  jsonRequest,
  type FakePrisma,
  type LogEntry,
} from "./forgot-password-route.test-helpers";

// #9: config combinations and response equivalence for POST /api/auth/forgot-password.
// The route reads the mail config on every request, so each test sets process.env itself.
// SAFETY: dummy values only (example.test / example.com), unresolvable Resend base URL,
// globalThis.fetch is always mocked, and prisma is a fake on globalThis (no DB, no network).

const API_KEY = "re_dummy_key_for_config_matrix_tests";
const FROM_ADDR = "no-reply@mail.example.test";
const MAIL_FROM = `NWA 設定マトリクス <${FROM_ADDR}>`;
const REPLY_TO = "support-matrix@example.test";
const BASE_HOST = "lms-matrix.example.test";
const APP_BASE_URL = `https://${BASE_HOST}`;

const MAIL_VARS = ["RESEND_API_KEY", "MAIL_FROM", "APP_BASE_URL", "MAIL_REPLY_TO", "VERCEL_ENV"];

process.env.RESEND_BASE_URL = "https://resend.invalid";
for (const name of MAIL_VARS) delete process.env[name];

function setCompleteConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    RESEND_API_KEY: API_KEY,
    MAIL_FROM,
    APP_BASE_URL,
    MAIL_REPLY_TO: REPLY_TO,
    ...overrides,
  };
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const skipText = (detail: string) =>
  `[forgot-password] Mail sending is not configured (${detail}). Skipped sending the reset email.`;

type SentBody = { from: unknown; reply_to?: unknown; to: unknown; html: string };
type ResendCtor = typeof import("resend").Resend;

let POST: (req: Request) => Promise<Response>;
let resendClasses: ResendCtor[];
let fake: FakePrisma;
let logs: LogEntry[];
let sent: SentBody[];
let fetchCalls: number;

before(async () => {
  fake = installFakePrisma();
  const requireFromRoot = createRequire(path.join(process.cwd(), "package.json"));
  const cjs = (requireFromRoot("resend") as { Resend: ResendCtor }).Resend;
  const esm = (await import("resend")).Resend;
  resendClasses = cjs === esm ? [cjs] : [cjs, esm];
  ({ POST } = await import("../../src/app/api/auth/forgot-password/route"));
});

function mockFetchOk() {
  mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls++;
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "email_dummy" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.createdTokens.length = 0;
  fake.failWith = undefined;
  logs = captureConsole();
  sent = [];
  fetchCalls = 0;
  mockFetchOk();
});

afterEach(() => {
  mock.restoreAll();
  for (const name of MAIL_VARS) delete process.env[name];
});

/** Values that must never appear in any log line. */
const secrets = (token: string | undefined) => [
  token ?? "",
  USER_EMAIL,
  USER_ID,
  API_KEY,
  MAIL_FROM,
  FROM_ADDR,
  REPLY_TO,
  BASE_HOST,
  APP_BASE_URL,
  "/reset-password",
];

async function snapshot(res: Response) {
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: await res.text(),
  };
}

describe("設定不足の組み合わせ: 送信しない・固定文言 1 行・200 success", () => {
  const cases: {
    title: string;
    env: Record<string, string | undefined>;
    detail: string;
    mustNotLog: string[];
  }[] = [
    {
      title: "全未設定",
      env: { RESEND_API_KEY: undefined, MAIL_FROM: undefined, APP_BASE_URL: undefined, MAIL_REPLY_TO: undefined },
      detail: "missing: RESEND_API_KEY, MAIL_FROM, APP_BASE_URL",
      mustNotLog: [],
    },
    {
      title: "RESEND_API_KEY のみ設定",
      env: { MAIL_FROM: undefined, APP_BASE_URL: undefined, MAIL_REPLY_TO: undefined },
      detail: "missing: MAIL_FROM, APP_BASE_URL",
      mustNotLog: [],
    },
    {
      title: "MAIL_REPLY_TO だけ不正（他は揃っている）",
      env: { MAIL_REPLY_TO: `${REPLY_TO}\r\nBcc: attacker@example.test` },
      detail: "invalid: MAIL_REPLY_TO",
      mustNotLog: ["attacker@example.test", "Bcc"],
    },
    {
      title: "MAIL_FROM が不正（@ なし）でも値はログに出ない",
      env: { MAIL_FROM: "NWA 不正送信元 <no-reply.mail.example.test>" },
      detail: "invalid: MAIL_FROM",
      mustNotLog: ["no-reply.mail.example.test", "不正送信元"],
    },
    {
      title: "APP_BASE_URL が http（非 localhost）",
      env: { APP_BASE_URL: `http://${BASE_HOST}` },
      detail: "invalid: APP_BASE_URL",
      mustNotLog: [],
    },
  ];

  for (const c of cases) {
    for (const production of [false, true]) {
      const level = production ? "error" : "warn";
      it(`${c.title}（${production ? "本番: error" : "非本番: warn"}）`, async () => {
        setCompleteConfig(c.env);
        if (production) process.env.VERCEL_ENV = "production";

        const res = await POST(jsonRequest({ email: USER_EMAIL }));

        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { success: true });
        assert.equal(fake.createdTokens.length, 1, "token is still issued");
        assert.equal(fetchCalls, 0, "no request to Resend");
        assert.deepEqual(logs, [{ level, text: skipText(c.detail) }]);
        assert.deepEqual(findLeaks(logs, [...secrets(fake.createdTokens[0]), ...c.mustNotLog]), []);
      });
    }
  }

  it("VERCEL_ENV=preview は非本番扱い（warn）", async () => {
    process.env.VERCEL_ENV = "preview";
    const res = await POST(jsonRequest({ email: USER_EMAIL }));
    assert.equal(res.status, 200);
    assert.deepEqual(logs, [
      { level: "warn", text: skipText("missing: RESEND_API_KEY, MAIL_FROM, APP_BASE_URL") },
    ]);
  });
});

describe("成功時", () => {
  it("MAIL_REPLY_TO 未設定なら reply_to を送らず、ログも出ない", async () => {
    setCompleteConfig({ MAIL_REPLY_TO: undefined });
    const res = await POST(jsonRequest({ email: USER_EMAIL }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, MAIL_FROM);
    assert.ok(!("reply_to" in sent[0]), "reply_to is omitted");
    assert.deepEqual(logs, []);
  });

  it("本番（VERCEL_ENV=production・https）でも成功時はログが一切出ない", async () => {
    setCompleteConfig();
    process.env.VERCEL_ENV = "production";
    const res = await POST(jsonRequest({ email: USER_EMAIL }));
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(logs, []);
  });

  it("設定変更がリクエストごとに反映される（モジュール読み込み時に固定されない）", async () => {
    await POST(jsonRequest({ email: USER_EMAIL }));
    assert.equal(fetchCalls, 0);
    assert.equal(logs.length, 1);

    setCompleteConfig();
    logs.length = 0;
    await POST(jsonRequest({ email: USER_EMAIL }));
    assert.equal(fetchCalls, 1);
    assert.deepEqual(logs, []);
  });
});

describe("リセット URL は APP_BASE_URL のみから作られる", () => {
  const spoofedRequests = (): { title: string; req: Request }[] => {
    const body = JSON.stringify({ email: USER_EMAIL });
    const make = (url: string, headers: Record<string, string>) =>
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
    return [
      { title: "request.url が別ホスト", req: make("https://evil.example/api/auth/forgot-password", {}) },
      { title: "Host", req: make("http://localhost/api/auth/forgot-password", { host: "evil.example" }) },
      {
        title: "X-Forwarded-Host / X-Forwarded-Proto",
        req: make("http://localhost/api/auth/forgot-password", {
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "http",
        }),
      },
      {
        title: "Forwarded（RFC 7239）",
        req: make("http://localhost/api/auth/forgot-password", {
          forwarded: "for=203.0.113.1;host=evil.example;proto=http",
        }),
      },
      { title: "Origin / Referer", req: make("http://localhost/api/auth/forgot-password", { origin: "https://evil.example", referer: "https://evil.example/login" }) },
    ];
  };

  for (const { title, req } of spoofedRequests()) {
    it(`${title} を偽装しても変わらない`, async () => {
      setCompleteConfig({ APP_BASE_URL: `${APP_BASE_URL}/` });
      const res = await POST(req);
      assert.equal(res.status, 200);
      const token = fake.createdTokens[0];
      assert.equal(sent.length, 1);
      const hrefs = Array.from(sent[0].html.matchAll(/href="([^"]*)"/g), (m) => m[1]);
      assert.deepEqual(hrefs, [`${APP_BASE_URL}/reset-password?token=${token}`]);
      assert.ok(!sent[0].html.includes("evil.example"));
      assert.ok(!sent[0].html.includes("localhost"));
    });
  }
});

describe("送信失敗時のレスポンスは未登録メールと同一", () => {
  type Mode = { title: string; install: () => void; logText: string };
  const modes: Mode[] = [
    {
      title: "Resend 422",
      install: () =>
        mock.method(globalThis, "fetch", async () => {
          fetchCalls++;
          return new Response(
            JSON.stringify({
              statusCode: 422,
              name: "validation_error",
              message: `Invalid from ${MAIL_FROM} to ${USER_EMAIL} key ${API_KEY} ${APP_BASE_URL}`,
            }),
            { status: 422, headers: { "content-type": "application/json" } }
          );
        }),
      logText: "[forgot-password] Failed to send the reset email: name=validation_error status=422",
    },
    {
      title: "Resend 500（name が形式外）",
      install: () =>
        mock.method(globalThis, "fetch", async () => {
          fetchCalls++;
          return new Response(
            JSON.stringify({ statusCode: 500, name: `Oops ${USER_EMAIL}`, message: API_KEY }),
            { status: 500, headers: { "content-type": "application/json" } }
          );
        }),
      logText: "[forgot-password] Failed to send the reset email: name=unknown status=500",
    },
    {
      title: "fetch 失敗",
      install: () =>
        mock.method(globalThis, "fetch", async () => {
          fetchCalls++;
          throw new TypeError(`fetch failed ${USER_EMAIL} ${API_KEY}`);
        }),
      logText: "[forgot-password] Failed to send the reset email: name=application_error status=none",
    },
    {
      title: "send が throw",
      install: () => {
        for (const ResendClass of resendClasses) {
          mock.method(ResendClass.prototype, "post", async () => {
            throw new RangeError(`boom ${USER_EMAIL} ${API_KEY} ${MAIL_FROM}`);
          });
        }
      },
      logText: "[forgot-password] Failed to send the reset email: threw RangeError",
    },
  ];

  for (const mode of modes) {
    it(`${mode.title}: ステータス・Content-Type・ボディが未登録メールと一致し、ログは name/status のみ`, async () => {
      setCompleteConfig();

      const unknown = await snapshot(await POST(jsonRequest({ email: OTHER_EMAIL })));
      assert.equal(fetchCalls, 0, "no mail for an unknown address");
      assert.deepEqual(logs, []);

      mock.restoreAll();
      logs = captureConsole();
      mockFetchOk();
      mode.install();

      const registered = await snapshot(await POST(jsonRequest({ email: USER_EMAIL })));
      const token = fake.createdTokens[0];
      assert.ok(token);

      assert.deepEqual(registered, unknown);
      assert.deepEqual(unknown, {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
      assert.deepEqual(logs, [{ level: "error", text: mode.logText }]);
      assert.deepEqual(findLeaks(logs, secrets(token)), []);
    });
  }
});
