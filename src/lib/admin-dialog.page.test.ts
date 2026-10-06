import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #44 管理ダッシュボードのダイアログ（招待・無効化/再有効化の確認）が
// FadeIn（transform）やカード（overflow: hidden）に閉じ込められないよう、
// document.body 直下へ Portal で描画していることを page.tsx のソースで確認する。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

/** `const Name = (...) => {` から次のトップレベル `const X = ` までを切り出す */
function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** `{cond && (` の直後から、対応する `)}` までを切り出す */
function conditionalBlock(body: string, cond: string): string {
  const head = `{${cond} && (`;
  const start = body.indexOf(head);
  assert.ok(start >= 0, `${head} が見つからない`);
  let depth = 1;
  for (let i = start + head.length; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return body.slice(start + head.length, i);
    }
  }
  assert.fail(`${head} の閉じかっこが見つからない`);
}

const portal = component("ModalPortal");
const admin = component("AdminDashboard");

describe("page.tsx：ModalPortal", () => {
  it("react-dom から createPortal を import している", () => {
    assert.match(src, /import \{\s*createPortal\s*\} from "react-dom";/);
  });

  it("createPortal で document.body に描画する", () => {
    assert.match(portal, /createPortal\(children, document\.body\)/);
  });

  it("マウント前（SSR・初回描画）は何も描画しない", () => {
    assert.match(portal, /const \[mounted, setMounted\] = useState\(false\)/);
    assert.match(portal, /useEffect\(\(\) => \{ setMounted\(true\); \}, \[\]\)/);
    const guard = portal.indexOf("if (!mounted) return null;");
    assert.ok(guard >= 0, "マウント前に null を返していない");
    assert.ok(guard < portal.indexOf("createPortal("), "createPortal より前に判定していない");
  });
});

const dialogs = [
  { label: "招待ダイアログ", cond: "inviteModal", close: "onClick={() => setInviteModal(false)}" },
  { label: "無効化・再有効化の確認ダイアログ", cond: "statusDialog", close: "onClick={closeStatusDialog}" },
];

for (const d of dialogs) {
  describe(`page.tsx：${d.label}`, () => {
    const block = conditionalBlock(admin, d.cond).trim();

    it("背景ごと ModalPortal で包んでいる", () => {
      assert.ok(block.startsWith("<ModalPortal>"), "ModalPortal で始まっていない");
      assert.ok(block.endsWith("</ModalPortal>"), "ModalPortal で終わっていない");
      const fixed = block.indexOf('position: "fixed"');
      assert.ok(fixed > block.indexOf("<ModalPortal>"), "背景が ModalPortal の中にない");
    });

    // 背景の div（1 行目）と本体の div（2 行目）を取り出す
    const lines = block.split("\n").map((l) => l.trim());
    const backdrop = lines[1];
    const panel = lines[2];

    it("背景は画面全体に重ね、余白とスクロールを持ち、クリックで閉じる", () => {
      assert.match(backdrop, /^<div style=\{\{ position: "fixed", inset: 0,/);
      assert.match(backdrop, /padding: 16/);
      assert.match(backdrop, /overflowY: "auto"/);
      assert.ok(backdrop.includes(d.close), "背景クリックで閉じる処理がない");
    });

    it("本体はクリックを背景に伝えず、高さを画面に収めてスクロールする", () => {
      assert.match(panel, /onClick=\{e => e\.stopPropagation\(\)\}/);
      assert.match(panel, /maxHeight: "calc\(100dvh - 32px\)"/);
      assert.match(panel, /overflowY: "auto"/);
      assert.match(panel, /maxWidth: "90vw"/);
    });
  });
}

describe("page.tsx：AdminDashboard のほかの position: fixed", () => {
  it("fixed は 2 つのダイアログの背景だけ（どちらも ModalPortal の中）", () => {
    const count = admin.split('position: "fixed"').length - 1;
    assert.equal(count, 2);
  });

  it("確認ダイアログのキャンセルに autoFocus が残っている", () => {
    const block = conditionalBlock(admin, "statusDialog");
    assert.match(block, /<Button variant="outline" autoFocus onClick=\{closeStatusDialog\}/);
  });
});
