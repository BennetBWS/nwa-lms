import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildResetUrl, readMailConfig, type MailConfigResult } from "./mail-config";

// Dummy values only (example.test). Never put real keys or addresses here.
const KEY = "re_dummy_key_for_mail_config_tests";
const FROM = "Next World Academy <no-reply@mail.example.test>";
const BASE = "https://lms.example.test";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    RESEND_API_KEY: KEY,
    MAIL_FROM: FROM,
    APP_BASE_URL: BASE,
    ...overrides,
  };
  const out: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  return out;
}

function expectOk(result: MailConfigResult) {
  if (result.ok === false) {
    assert.fail(`expected ok, got missing=${result.missing.join(",")} invalid=${result.invalid.join(",")}`);
  }
  return result.config;
}

function expectNg(result: MailConfigResult) {
  if (result.ok === true) assert.fail("expected not ok");
  return result;
}

describe("readMailConfig", () => {
  it("returns the config when all required variables are valid", () => {
    assert.deepEqual(expectOk(readMailConfig(env())), { apiKey: KEY, from: FROM, appBaseUrl: BASE });
  });

  it("includes replyTo only when MAIL_REPLY_TO is set", () => {
    assert.equal(expectOk(readMailConfig(env({ MAIL_REPLY_TO: "  " }))).replyTo, undefined);
    assert.equal(
      expectOk(readMailConfig(env({ MAIL_REPLY_TO: "support@example.test" }))).replyTo,
      "support@example.test"
    );
  });

  it("reports every missing variable by name (blank counts as missing)", () => {
    const r = expectNg(
      readMailConfig(env({ RESEND_API_KEY: undefined, MAIL_FROM: undefined, APP_BASE_URL: undefined }))
    );
    assert.deepEqual(r.missing, ["RESEND_API_KEY", "MAIL_FROM", "APP_BASE_URL"]);
    assert.deepEqual(r.invalid, []);

    const blank = expectNg(readMailConfig(env({ RESEND_API_KEY: "   ", MAIL_FROM: "" })));
    assert.deepEqual(blank.missing, ["RESEND_API_KEY", "MAIL_FROM"]);
  });

  it("does not include any value in the result when not ok", () => {
    const r = expectNg(
      readMailConfig(env({ MAIL_FROM: "no-at-sign", APP_BASE_URL: "https://user:pw@lms.example.test" }))
    );
    const json = JSON.stringify(r);
    for (const v of [KEY, "no-at-sign", "lms.example.test", "user:pw"]) {
      assert.ok(!json.includes(v), `result must not contain ${v}`);
    }
  });

  describe("MAIL_FROM", () => {
    it("accepts `addr` and `Display Name <addr>` (Japanese / spaces allowed)", () => {
      for (const from of [
        "no-reply@mail.example.test",
        "Next World Academy <no-reply@mail.example.test>",
        "ネクストワールド アカデミー <no-reply@mail.example.test>",
        "<no-reply@mail.example.test>",
      ]) {
        assert.equal(expectOk(readMailConfig(env({ MAIL_FROM: from }))).from, from);
      }
    });

    it("trims surrounding spaces", () => {
      assert.equal(expectOk(readMailConfig(env({ MAIL_FROM: `  ${FROM}  ` }))).from, FROM);
    });

    it("rejects line breaks and values without @", () => {
      for (const from of [
        "no-reply@mail.example.test\r\nBcc: x@example.test",
        "Name\n <no-reply@mail.example.test>",
        "no-reply.example.test",
        "Name <no-reply.example.test>",
        "Name <a@example.test",
        "a b@example.test",
      ]) {
        assert.deepEqual(expectNg(readMailConfig(env({ MAIL_FROM: from }))).invalid, ["MAIL_FROM"], from);
      }
    });
  });

  describe("MAIL_REPLY_TO", () => {
    it("rejects line breaks and values without @", () => {
      for (const replyTo of ["support@example.test\nBcc: x@example.test", "support.example.test"]) {
        assert.deepEqual(
          expectNg(readMailConfig(env({ MAIL_REPLY_TO: replyTo }))).invalid,
          ["MAIL_REPLY_TO"],
          replyTo
        );
      }
    });
  });

  describe("APP_BASE_URL", () => {
    it("normalizes a trailing slash to the origin", () => {
      assert.equal(expectOk(readMailConfig(env({ APP_BASE_URL: `${BASE}/` }))).appBaseUrl, BASE);
      assert.equal(
        expectOk(readMailConfig(env({ APP_BASE_URL: "https://LMS.Example.Test:443/" }))).appBaseUrl,
        BASE
      );
    });

    it("rejects non-http(s) schemes, paths, queries, fragments and credentials", () => {
      for (const url of [
        "javascript:alert(1)",
        "data:text/html,hi",
        "ftp://lms.example.test",
        "lms.example.test",
        "not a url",
        `${BASE}/app`,
        `${BASE}/reset-password`,
        `${BASE}//`,
        `${BASE}/?x=1`,
        `${BASE}?`,
        `${BASE}/#top`,
        `${BASE}#`,
        "https://user@lms.example.test",
        "https://user:pw@lms.example.test",
        "http://lms.example.test",
      ]) {
        assert.deepEqual(expectNg(readMailConfig(env({ APP_BASE_URL: url }))).invalid, ["APP_BASE_URL"], url);
      }
    });

    it("allows http only for localhost / 127.0.0.1 outside production", () => {
      assert.equal(
        expectOk(readMailConfig(env({ APP_BASE_URL: "http://localhost:3000" }))).appBaseUrl,
        "http://localhost:3000"
      );
      assert.equal(
        expectOk(readMailConfig(env({ APP_BASE_URL: "http://127.0.0.1:3000/", VERCEL_ENV: "preview" })))
          .appBaseUrl,
        "http://127.0.0.1:3000"
      );
      for (const url of ["http://localhost:3000", "http://127.0.0.1"]) {
        assert.deepEqual(
          expectNg(readMailConfig(env({ APP_BASE_URL: url, VERCEL_ENV: "production" }))).invalid,
          ["APP_BASE_URL"],
          url
        );
      }
    });

    it("https is accepted in production", () => {
      assert.equal(
        expectOk(readMailConfig(env({ VERCEL_ENV: "production" }))).appBaseUrl,
        BASE
      );
    });
  });

  it("reports missing and invalid together", () => {
    const r = expectNg(
      readMailConfig(env({ MAIL_FROM: undefined, APP_BASE_URL: "javascript:alert(1)", MAIL_REPLY_TO: "x" }))
    );
    assert.deepEqual(r.missing, ["MAIL_FROM"]);
    assert.deepEqual(r.invalid, ["APP_BASE_URL", "MAIL_REPLY_TO"]);
  });

  it("defaults to process.env", () => {
    const saved = { ...process.env };
    try {
      delete process.env.RESEND_API_KEY;
      delete process.env.MAIL_FROM;
      delete process.env.APP_BASE_URL;
      assert.deepEqual(expectNg(readMailConfig()).missing, ["RESEND_API_KEY", "MAIL_FROM", "APP_BASE_URL"]);
    } finally {
      for (const k of ["RESEND_API_KEY", "MAIL_FROM", "APP_BASE_URL"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("buildResetUrl", () => {
  it("builds <base>/reset-password?token=<token>", () => {
    const token = "0f0e0d0c-0b0a-4908-8706-050403020100";
    assert.equal(buildResetUrl(BASE, token), `${BASE}/reset-password?token=${token}`);
    assert.equal(
      buildResetUrl("http://localhost:3000", token),
      `http://localhost:3000/reset-password?token=${token}`
    );
  });

  it("encodes the token as a query parameter", () => {
    assert.equal(
      buildResetUrl(BASE, "a&b=c #d"),
      `${BASE}/reset-password?token=a%26b%3Dc+%23d`
    );
  });
});

// #9 追加: 境界値の補強
describe("readMailConfig 境界値（追加）", () => {
  describe("MAIL_FROM", () => {
    it("本番想定の表示名付きアドレスがそのまま通る", () => {
      const from = "Next World Academy <no-reply@mail.bws-bennet.com>";
      assert.equal(expectOk(readMailConfig(env({ MAIL_FROM: from }))).from, from);
      const ja = "ネクストワールド　アカデミー 事務局 <no-reply@mail.bws-bennet.com>";
      assert.equal(expectOk(readMailConfig(env({ MAIL_FROM: ja }))).from, ja);
    });

    it("前後の改行は trim され、trim 後の値が送信に使われる", () => {
      for (const [from, expected] of [
        ["no-reply@mail.example.test\r", "no-reply@mail.example.test"],
        ["no-reply@mail.example.test\n", "no-reply@mail.example.test"],
        ["\nno-reply@mail.example.test", "no-reply@mail.example.test"],
        ["\r\nNext World Academy <no-reply@mail.example.test>", "Next World Academy <no-reply@mail.example.test>"],
        ["Next World Academy <no-reply@mail.example.test>\r\n", "Next World Academy <no-reply@mail.example.test>"],
      ]) {
        assert.equal(expectOk(readMailConfig(env({ MAIL_FROM: from }))).from, expected, JSON.stringify(from));
      }
    });

    it("trim 後に残る制御文字（改行・タブ・NUL・DEL）は拒否する", () => {
      for (const from of [
        "Next World\r\nAcademy <no-reply@mail.example.test>",
        "Next World\rAcademy <no-reply@mail.example.test>",
        "Next\tWorld Academy <no-reply@mail.example.test>",
        "Name <no-reply@mail.example.test>\nBcc: x@example.test",
        "no-reply@mail.exa\u0000mple.test",
        "Name\u007f <no-reply@mail.example.test>",
      ]) {
        assert.deepEqual(
          expectNg(readMailConfig(env({ MAIL_FROM: from }))).invalid,
          ["MAIL_FROM"],
          JSON.stringify(from)
        );
      }
    });

    it("山括弧が複数・入れ子・閉じ忘れなら拒否する", () => {
      for (const from of [
        "A <a@example.test> <b@example.test>",
        "A <<a@example.test>>",
        "A <a@example.test> trailing",
        "a@example.test>",
        "<>",
      ]) {
        assert.deepEqual(expectNg(readMailConfig(env({ MAIL_FROM: from }))).invalid, ["MAIL_FROM"], from);
      }
    });
  });

  describe("APP_BASE_URL", () => {
    it("大文字ホスト・:443・末尾スラッシュを origin に正規化する", () => {
      for (const url of [
        "HTTPS://LMS.EXAMPLE.TEST",
        "https://lms.example.test:443",
        "https://Lms.Example.Test:443/",
        "  https://lms.example.test/  ",
      ]) {
        assert.equal(expectOk(readMailConfig(env({ APP_BASE_URL: url }))).appBaseUrl, BASE, url);
      }
    });

    it("標準以外のポートは保持する", () => {
      assert.equal(
        expectOk(readMailConfig(env({ APP_BASE_URL: "https://lms.example.test:8443/" }))).appBaseUrl,
        "https://lms.example.test:8443"
      );
    });

    it("非本番の http://localhost:3000 は許可、本番の http は全て拒否", () => {
      assert.equal(
        expectOk(readMailConfig(env({ APP_BASE_URL: "http://localhost:3000/" }))).appBaseUrl,
        "http://localhost:3000"
      );
      assert.equal(
        expectOk(readMailConfig(env({ APP_BASE_URL: "http://LOCALHOST:3000" }))).appBaseUrl,
        "http://localhost:3000"
      );
      for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://lms.example.test"]) {
        assert.deepEqual(
          expectNg(readMailConfig(env({ APP_BASE_URL: url, VERCEL_ENV: "production" }))).invalid,
          ["APP_BASE_URL"],
          url
        );
      }
    });

    it("localhost に似た別ホストの http は拒否する", () => {
      for (const url of [
        "http://localhost.example.test",
        "http://127.0.0.1.example.test",
        "http://localhost@lms.example.test",
        "http://0.0.0.0:3000",
        "http://127.0.0.2:3000",
      ]) {
        assert.deepEqual(expectNg(readMailConfig(env({ APP_BASE_URL: url }))).invalid, ["APP_BASE_URL"], url);
      }
    });

    it("http://[::1] は現状拒否（IPv6 ループバックは localhost 扱いしない）", () => {
      for (const url of ["http://[::1]", "http://[::1]:3000/"]) {
        assert.deepEqual(expectNg(readMailConfig(env({ APP_BASE_URL: url }))).invalid, ["APP_BASE_URL"], url);
      }
      // https なら IPv6 リテラルでも通る（プロトコル条件のみで判定しているため）
      assert.equal(
        expectOk(readMailConfig(env({ APP_BASE_URL: "https://[::1]:3000" }))).appBaseUrl,
        "https://[::1]:3000"
      );
    });

    it("javascript: / 認証情報 / パス / クエリ / フラグメント / 改行付きは拒否する", () => {
      for (const url of [
        "javascript:alert(1)",
        "JavaScript://lms.example.test/%0aalert(1)",
        "https://:pw@lms.example.test",
        "https://user:@lms.example.test",
        "https://lms.example.test/reset-password?token=x",
        "https://lms.example.test/?",
        "https://lms.example.test/#",
        "https://lms.example.test/a/",
        "https://lms.example.test\r\n.evil.example",
        "https://lms.example.test\n/evil",
      ]) {
        assert.deepEqual(
          expectNg(readMailConfig(env({ APP_BASE_URL: url }))).invalid,
          ["APP_BASE_URL"],
          JSON.stringify(url)
        );
      }
    });

    it("前後の改行・空白は trim され、結果の origin に制御文字は残らない", () => {
      // MAIL_FROM と同じく trim 後の値で判定する。出力は URL.origin。
      for (const url of ["https://lms.example.test/\n", "\r\nhttps://lms.example.test", "\thttps://lms.example.test\t"]) {
        const base = expectOk(readMailConfig(env({ APP_BASE_URL: url }))).appBaseUrl;
        assert.equal(base, BASE, JSON.stringify(url));
        assert.ok(!/[\u0000-\u001f\u007f]/.test(base));
      }
    });

    it("trim 後の途中に残る制御文字（タブ・改行・NUL・DEL）は拒否する", () => {
      // URL パーサーはタブ・改行を黙って除去するため、パース前に拒否する。
      for (const url of [
        "https://lms.exa\tmple.test",
        "https://lms.exa\nmple.test",
        "https://lms.example.test\r/",
        "https://lms.example.test\u0000",
        "https://lms.example.test\u007f",
      ]) {
        assert.deepEqual(
          expectNg(readMailConfig(env({ APP_BASE_URL: url }))).invalid,
          ["APP_BASE_URL"],
          JSON.stringify(url)
        );
      }
    });

    it("不正時の結果に値（ホスト名・認証情報）が含まれない", () => {
      const r = expectNg(
        readMailConfig(env({ APP_BASE_URL: "https://someone:hunter2@lms.example.test/path?q=1#f" }))
      );
      const json = JSON.stringify(r);
      for (const v of ["someone", "hunter2", "lms.example.test", "path", "q=1"]) {
        assert.ok(!json.includes(v), v);
      }
    });
  });
});

describe("buildResetUrl（追加）", () => {
  it("正規化済みの origin から作った URL は APP_BASE_URL のホストだけを指す", () => {
    const token = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const base = expectOk(readMailConfig(env({ APP_BASE_URL: "https://LMS.Example.Test:443/" }))).appBaseUrl;
    const url = new URL(buildResetUrl(base, token));
    assert.equal(url.origin, BASE);
    assert.equal(url.pathname, "/reset-password");
    assert.equal(url.searchParams.get("token"), token);
    assert.equal(Array.from(url.searchParams.keys()).length, 1);
  });
});

// #9 レビュー指摘: アドレス部の最低限チェック
describe("readMailConfig アドレス部の最低限チェック", () => {
  const invalidMailboxes = [
    "@",
    "Name <@>",
    "a@b@c",
    "Name <a@b@c>",
    "@example.test",
    "no-reply@",
    "Name <@example.test>",
    "Name <no-reply@>",
    "Name < a@example.test >",
    "Name < a@example.test>",
    "Name <a@example.test >",
    "Name <a @example.test>",
    "Name <a@example.test\u3000>",
  ];

  it("MAIL_FROM: @ が 1 つでない・ローカル部/ドメインが空・アドレス部に空白があれば拒否する", () => {
    for (const from of invalidMailboxes) {
      assert.deepEqual(
        expectNg(readMailConfig(env({ MAIL_FROM: from }))).invalid,
        ["MAIL_FROM"],
        JSON.stringify(from)
      );
    }
  });

  it("MAIL_REPLY_TO: 同じ条件で拒否する", () => {
    for (const replyTo of invalidMailboxes) {
      assert.deepEqual(
        expectNg(readMailConfig(env({ MAIL_REPLY_TO: replyTo }))).invalid,
        ["MAIL_REPLY_TO"],
        JSON.stringify(replyTo)
      );
    }
  });

  it("不正時の結果に値が含まれない", () => {
    const r = expectNg(readMailConfig(env({ MAIL_FROM: "Secret Name <a@b@c>", MAIL_REPLY_TO: "Other < x@y >" })));
    const json = JSON.stringify(r);
    for (const v of ["Secret", "a@b@c", "Other", "x@y"]) {
      assert.ok(!json.includes(v), v);
    }
  });

  it("本番想定の値は引き続き通る（表示名付き・全角スペース入り日本語表示名・アドレスのみ）", () => {
    for (const from of [
      "Next World Academy <no-reply@mail.bws-bennet.com>",
      "ネクストワールド　アカデミー <no-reply@mail.bws-bennet.com>",
      "info@bws-bennet.com",
    ]) {
      assert.equal(expectOk(readMailConfig(env({ MAIL_FROM: from }))).from, from, from);
    }
    for (const replyTo of ["info@bws-bennet.com", "NWA 事務局 <info@bws-bennet.com>"]) {
      assert.equal(expectOk(readMailConfig(env({ MAIL_REPLY_TO: replyTo }))).replyTo, replyTo, replyTo);
    }
  });
});
