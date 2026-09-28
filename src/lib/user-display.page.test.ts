import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #32 page.tsx（@ts-nocheck で型チェック対象外）の配線をソースで確認する。
// レンダリングはせず、props 名・import・描画条件・スタイルを文字列で検査する。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

/** `const Name = (...) => {` から次のトップレベル `const X = ` までを切り出す */
function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const sidebar = component("Sidebar");
const dashboard = component("StudentDashboard");
const rootStart = src.indexOf("export default function NWALearningPlatform");
const root = src.slice(rootStart);

describe("page.tsx：import", () => {
  it("lucide-react から User アイコンを import している", () => {
    const m = src.match(/import \{([^}]*)\} from "lucide-react";/);
    assert.ok(m, "lucide-react の import がない");
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    assert.ok(names.includes("User"), "User が import されていない");
  });

  it("User を別の宣言で上書きしていない", () => {
    assert.doesNotMatch(src, /\b(const|let|var|function|class)\s+User\b/);
  });

  it("user-display の 3 関数を import している", () => {
    const m = src.match(/import \{([^}]*)\} from "@\/lib\/user-display";/);
    assert.ok(m);
    const names = m[1].split(",").map((s) => s.trim());
    for (const n of ["avatarInitial", "displayName", "greetingTitle"]) assert.ok(names.includes(n), n);
  });
});

describe("page.tsx：Sidebar", () => {
  it("props に userName を受け取り、displayName / avatarInitial に渡す", () => {
    assert.match(sidebar, /^const Sidebar = \(\{[^}]*\buserName\b[^}]*\}\) =>/);
    assert.match(sidebar, /displayName\(userName\) \?\? "ユーザー"/);
    assert.match(sidebar, /avatarInitial\(userName\)/);
  });

  it("ハードコードされた Tec / T が残っていない", () => {
    assert.doesNotMatch(sidebar, />Tec</);
    assert.doesNotMatch(sidebar, />T<\/AvatarFallback>/);
  });

  it("頭文字が null のときは User アイコンを出す", () => {
    assert.match(sidebar, /<AvatarFallback[^>]*>\{initial \?\? <User\b[^>]*\/>\}<\/AvatarFallback>/);
  });

  it("通知のバッジ（ダミーの 2 件）を削除している", () => {
    const line = sidebar.split("\n").find((l) => l.includes('id: "notifications"'));
    assert.ok(line);
    assert.doesNotMatch(line, /badge/);
    assert.doesNotMatch(sidebar, /badge:\s*\d/);
  });

  it("バッジは値があり 0 でないときだけ描画する", () => {
    assert.match(sidebar, /\{item\.badge != null && item\.badge !== 0 && \(/);
    // 条件式の評価（JSX の && と同じ意味）
    const shows = (badge: unknown) => Boolean(badge != null && badge !== 0);
    assert.equal(shows(undefined), false);
    assert.equal(shows(null), false);
    assert.equal(shows(0), false);
    assert.equal(shows(2), true);
  });

  it("ロール表示は isAdmin で 講師 / 在校生", () => {
    assert.match(sidebar, /\{isAdmin \? "講師" : "在校生"\}/);
  });

  it("名前は 1 行で省略表示し、title に全文を入れる", () => {
    const m = sidebar.match(/<div title=\{shownName\} style=\{\{([^}]*)\}\}>\{shownName\}<\/div>/);
    assert.ok(m, "名前の div が見つからない");
    const style = m[1];
    assert.match(style, /overflow: "hidden"/);
    assert.match(style, /textOverflow: "ellipsis"/);
    assert.match(style, /whiteSpace: "nowrap"/);
    assert.match(style, /minWidth: 0/);
  });

  it("名前を包む flex 子要素に minWidth: 0 がある（省略が効くため）", () => {
    const idx = sidebar.indexOf("<div title={shownName}");
    const before = sidebar.slice(0, idx);
    const parent = before.slice(before.lastIndexOf("<div"));
    assert.match(parent, /flex: 1, minWidth: 0/);
  });
});

describe("page.tsx：StudentDashboard", () => {
  it("props に userName を受け取り、見出しは greetingTitle(userName)", () => {
    assert.match(dashboard, /^const StudentDashboard = \(\{[^}]*\buserName\b[^}]*\}\) =>/);
    assert.match(dashboard, /<h1[^>]*>\{greetingTitle\(userName\)\}<\/h1>/);
    assert.doesNotMatch(dashboard, /おかえりなさい、Tec さん/);
  });

  it("長い名前で見出しがはみ出さない（overflowWrap: anywhere）", () => {
    const h1 = dashboard.match(/<h1 style=\{\{([^}]*)\}\}>\{greetingTitle/);
    assert.ok(h1);
    assert.match(h1[1], /overflowWrap: "anywhere"/);
  });
});

describe("page.tsx：NWALearningPlatform からの受け渡し", () => {
  it("Sidebar と StudentDashboard に userName={sessionView.name} を渡す（取り違えなし）", () => {
    assert.match(root, /<Sidebar [^>]*\buserName=\{sessionView\.name\}[^>]*\/>/);
    assert.match(root, /<StudentDashboard [^>]*\buserName=\{sessionView\.name\}[^>]*\/>/);
    // 別名の props（name= / user= / username=）で渡していない
    assert.doesNotMatch(root, /<(Sidebar|StudentDashboard) [^>]*\b(name|user|username|userNmae)=\{/);
  });

  it("Sidebar と pages の描画は authenticated でないときの早期 return より後", () => {
    const guard = root.indexOf('if (sessionView.kind !== "authenticated")');
    assert.ok(guard >= 0);
    const sidebarUse = root.indexOf("<Sidebar ");
    const pagesUse = root.indexOf("{pages[page]");
    assert.ok(sidebarUse > guard, "Sidebar が認証確認より前で描画される");
    assert.ok(pagesUse > guard, "pages が認証確認より前で描画される");
    // ガード内の return で Sidebar / pages を描画していない
    const guardBlock = root.slice(guard, sidebarUse);
    assert.doesNotMatch(guardBlock, /\{pages\[/);
  });

  it("sessionView.name を参照するのは userName の 2 か所だけ", () => {
    const uses = root.match(/sessionView\.name/g) ?? [];
    assert.equal(uses.length, 2);
  });
});
