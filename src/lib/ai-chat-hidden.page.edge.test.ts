import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// #32 AI チャット非表示の境界ケース（ソースを文字列で検査する）。
// ai-chat-hidden.page.test.ts を補う：大文字小文字違いの指定子、CSS に残ったチャット用クラス、
// page.tsx の閉じタグの並び、残したチャット部品の先頭コメントと "use client" の位置。

const srcRoot = join(__dirname, "..");
const page = readFileSync(join(srcRoot, "app", "page.tsx"), "utf8");

const CHAT_FILES = [
  "components/ChatSidebar.tsx",
  "components/ChatMobile.tsx",
  "components/ChatMessage.tsx",
  "lib/chat-mock.ts",
];
const THIS_TESTS = ["lib/ai-chat-hidden.page.test.ts", "lib/ai-chat-hidden.page.edge.test.ts"];

function listFiles(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, ext));
    else if (ext.test(entry.name)) out.push(full);
  }
  return out;
}

const files = listFiles(srcRoot, /\.(ts|tsx|js|jsx|mjs|cjs|css)$/).map((full) => ({
  rel: relative(srcRoot, full).split(sep).join("/"),
  code: readFileSync(full, "utf8"),
}));
const others = files.filter((f) => !CHAT_FILES.includes(f.rel) && !THIS_TESTS.includes(f.rel));

function moduleSpecifiers(code: string): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  return Array.from(code.matchAll(re), (m) => m[1]);
}

describe("チャット部品以外：大文字小文字を変えた指定子・ディレクトリ形式でも import しない", () => {
  it("指定子のどの区切りにも chatsidebar / chatmobile / chatmessage / chat-mock が出てこない（大文字小文字を区別しない）", () => {
    const offenders = others.flatMap((f) =>
      moduleSpecifiers(f.code)
        .filter((s) => s.split("/").some((seg) => /^(chat(sidebar|mobile|message)|chat-mock)(\.\w+)?$/i.test(seg)))
        .map((s) => `${f.rel} → ${s}`),
    );
    assert.deepEqual(offenders, []);
  });
});

describe("チャット用の CSS クラス・body のスクロール固定が残っていない", () => {
  it("チャット部品以外（.css を含む）に nwa-chat- クラスの参照がない", () => {
    const offenders = others.filter((f) => /nwa-chat-/.test(f.code)).map((f) => f.rel);
    assert.deepEqual(offenders, []);
  });

  it("page.tsx は document.body.style.overflow を触らない（ChatMobile が持っていた処理）", () => {
    assert.doesNotMatch(page, /document\.body\.style\.overflow/);
  });
});

describe("page.tsx：チャットを外したあとの JSX の閉じ方", () => {
  it("</main> の直後が </div> → </ThemeContext.Provider> → ); の順に並ぶ", () => {
    assert.match(page, /<\/main>\s*<\/div>\s*<\/ThemeContext\.Provider>\s*\);/);
  });

  it("<main と </main> はそれぞれ 1 回だけ", () => {
    assert.equal(page.match(/<main\b/g)?.length, 1);
    assert.equal(page.match(/<\/main>/g)?.length, 1);
  });
});

describe("残したチャット部品：先頭の注記と \"use client\" の位置", () => {
  for (const rel of CHAT_FILES) {
    const code = readFileSync(join(srcRoot, rel), "utf8");
    it(`${rel} の先頭コメントに #32 とリリースで非表示である旨がある`, () => {
      const head = code.split("\n").slice(0, 4).join("\n");
      assert.match(head, /#32/);
      assert.match(head, /hidden in the release/);
    });

    if (rel.endsWith(".tsx")) {
      it(`${rel} の "use client" はコメントより後でも、コードより前にある`, () => {
        // ディレクティブはコメント以外の文より前にないと無効になる
        const beforeDirective = code.slice(0, code.indexOf('"use client"'));
        assert.ok(code.includes('"use client"'));
        const nonComment = beforeDirective
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "" && !l.startsWith("//"));
        assert.deepEqual(nonComment, []);
      });
    }
  }
});
