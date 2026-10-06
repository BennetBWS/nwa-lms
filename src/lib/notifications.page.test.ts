import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #32 通知ページ：page.tsx（@ts-nocheck）の Notifications をソースで検査する。
// レンダリングはしない。見本データが残っていないこと・配線・文言を文字列で確認する。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const notifications = component("Notifications");

describe("Notifications：見本データを残さない", () => {
  const banned: Array<[string, RegExp]> = [
    ["見本（山田先生）", /山田先生/],
    ["見本（Apple模写）", /Apple模写/],
    ["見本（JS DOM操作クイズ）", /JS DOM操作クイズ/],
    ["見本（パスワード変更のお知らせ）", /パスワード変更のお知らせ/],
    ['time: "new" の固定', /time: "new"/],
    ["iconMap", /iconMap/],
    ["colorMap", /colorMap/],
  ];
  for (const [label, re] of banned) {
    it(`${label} がない`, () => {
      assert.doesNotMatch(notifications, re);
    });
  }
});

describe("Notifications：データの配線", () => {
  it("toNewsItems を import して、API の値を now 付きで変換する", () => {
    const m = src.match(/import \{([^}]*)\} from "@\/lib\/student-dashboard";/);
    assert.ok(m, "import がない");
    assert.ok(m[1].split(",").map((s) => s.trim()).includes("toNewsItems"));
    assert.match(notifications, /toNewsItems\(notifs, now\)/);
  });

  it("/api/notifications を authFetch で読み、失効は classifyAuthFailure で判定する", () => {
    const m = src.match(/import \{([^}]*)\} from "@\/lib\/client-session";/);
    assert.ok(m, "import がない");
    assert.ok(m[1].split(",").map((s) => s.trim()).includes("classifyAuthFailure"));
    assert.match(notifications, /authFetch\("\/api\/notifications"\)/);
    assert.match(
      notifications,
      /classifyAuthFailure\(\{ status: res\.status, redirected: res\.redirected, url: res\.url \}\) === "expired"/
    );
  });

  it("ok でない・リダイレクト・配列でない応答は失敗", () => {
    assert.match(notifications, /if \(!res\.ok \|\| res\.redirected\) return null;/);
    assert.match(notifications, /if \(Array\.isArray\(data\)\) setNotifs\(data\);\s*else setLoadFailed\(true\);/);
    assert.match(notifications, /\.catch\(\(\) => setLoadFailed\(true\)\)/);
  });

  it("useRef で二重読み込みを防ぐ", () => {
    assert.match(notifications, /useRef\(false\)/);
    assert.match(notifications, /if \(notifsInFlight\.current\) return;/);
  });

  it("行の key は通知の id", () => {
    assert.match(notifications, /key=\{x\.id\}/);
  });
});

describe("Notifications：表示", () => {
  it("空と失敗の文言、失敗は role=alert と再読み込みボタン（読み込み中は disabled）", () => {
    assert.ok(notifications.includes("通知はありません"));
    assert.ok(notifications.includes("通知を読み込めませんでした"));
    assert.match(notifications, /role="alert"/);
    assert.match(notifications, /onClick=\{loadNotifications\} disabled=\{loading\}/);
  });

  it("アイコンは Bell だけ", () => {
    assert.match(notifications, /<Bell size=\{18\} aria-hidden="true"/);
    for (const icon of ["MessageSquare", "GraduationCap", "Award", "Settings"]) {
      assert.doesNotMatch(notifications, new RegExp(`\\b${icon}\\b`), icon);
    }
  });

  it("未読のドットに aria-label がある", () => {
    assert.match(notifications, /aria-label="未読"/);
  });

  it("クリックしても何も起きない行に pointer やホバーの変化を付けない", () => {
    assert.doesNotMatch(notifications, /cursor: "pointer"/);
    assert.doesNotMatch(notifications, /onMouseEnter|onMouseLeave/);
  });
});
