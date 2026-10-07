import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// #32 AI チャットはリリースでは非表示：ソースを文字列で検査する。
// page.tsx から外れていること、src/ の中でチャット部品を使っているのがチャット部品どうしだけであることを確認する。

const srcRoot = join(__dirname, "..");
const page = readFileSync(join(srcRoot, "app", "page.tsx"), "utf8");

// src/ からの相対パス（区切りは /）
const CHAT_FILES = [
  "components/ChatSidebar.tsx",
  "components/ChatMobile.tsx",
  "components/ChatMessage.tsx",
  "lib/chat-mock.ts",
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// import 文・export ... from・動的 import・require のモジュール指定子を取り出す
function moduleSpecifiers(code: string): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  return Array.from(code.matchAll(re), (m) => m[1]);
}

function isChatModule(spec: string): boolean {
  const base = spec.split("/").pop() ?? "";
  return /^(Chat[A-Z]\w*|chat-mock)(\.(ts|tsx|js|jsx))?$/.test(base);
}

describe("page.tsx：AI チャットを表示しない", () => {
  const banned: Array<[string, RegExp]> = [
    ["@/components/ChatSidebar の import", /@\/components\/ChatSidebar/],
    ["@/components/ChatMobile の import", /@\/components\/ChatMobile/],
    ["chat-mock の import", /chat-mock/],
    ["<ChatSidebar", /<ChatSidebar\b/],
    ["<ChatMobile", /<ChatMobile\b/],
  ];
  for (const [label, re] of banned) {
    it(`${label} がない`, () => {
      assert.doesNotMatch(page, re);
    });
  }

  it("Chat 部品・chat-mock をどの指定子でも import していない", () => {
    assert.deepEqual(moduleSpecifiers(page).filter(isChatModule), []);
  });
});

describe("src/：チャット部品を使うのはチャット部品どうしだけ", () => {
  const files = listSourceFiles(srcRoot).map((full) => ({
    rel: relative(srcRoot, full).split(sep).join("/"),
    code: readFileSync(full, "utf8"),
  }));

  it("検査対象のチャット部品がすべて存在する", () => {
    const rels = new Set(files.map((f) => f.rel));
    for (const f of CHAT_FILES) assert.ok(rels.has(f), `${f} が見つからない`);
  });

  it("チャット部品以外のファイルは Chat 部品・chat-mock を import しない", () => {
    const offenders = files
      .filter((f) => !CHAT_FILES.includes(f.rel))
      .flatMap((f) => moduleSpecifiers(f.code).filter(isChatModule).map((s) => `${f.rel} → ${s}`));
    assert.deepEqual(offenders, []);
  });

  it("src/app 配下はチャットの部品名も chat-mock も参照しない", () => {
    const offenders = files
      .filter((f) => f.rel.startsWith("app/"))
      .filter((f) => /\bChat(Sidebar|Mobile|Message)\b|chat-mock/.test(f.code))
      .map((f) => f.rel);
    assert.deepEqual(offenders, []);
  });

  it("検出の仕組みが働く（チャット部品どうしの import は見つかる）", () => {
    const sidebar = files.find((f) => f.rel === "components/ChatSidebar.tsx");
    assert.ok(sidebar);
    const found = moduleSpecifiers(sidebar.code).filter(isChatModule);
    assert.ok(found.includes("./ChatMessage"));
    assert.ok(found.includes("@/lib/chat-mock"));
  });
});
