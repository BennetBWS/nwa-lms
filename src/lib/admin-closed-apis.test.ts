import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// #81 Q3：管理画面から使っていない危険な書き込み API を閉じた（ハンドラを削除）。
// 検証のない作成・更新と、受験記録・問題の物理削除を API から実行できないようにするため。
// 必要になったら、入力検証・401 / 403 の分離・ログの最小化を入れて作り直す（例：Q1 の PATCH /api/admin/questions/[id]）。
// ここではソースを読んで、閉じたハンドラが戻っていないことを固定する（DB・ネットワークなし）。
// 同じパスに別のメソッド（Q1 の GET や PATCH など）を足すことは妨げない。

const API_DIR = join(__dirname, "..", "app", "api");
const PAGE = join(__dirname, "..", "app", "page.tsx");

type Closed = { dir: string; url: string; methods: string[] };

const CLOSED: Closed[] = [
  { dir: "admin/quizzes", url: "/api/admin/quizzes", methods: ["POST"] },
  { dir: "admin/quizzes/[id]", url: "/api/admin/quizzes/[id]", methods: ["PUT", "DELETE"] },
  { dir: "admin/quizzes/[id]/questions", url: "/api/admin/quizzes/[id]/questions", methods: ["POST"] },
  { dir: "admin/questions/[id]", url: "/api/admin/questions/[id]", methods: ["PUT", "DELETE"] },
];

const ROUTE_FILES = ["route.ts", "route.tsx", "route.js", "route.mjs"];

/** route ファイルが export しているメソッド名（関数・const・export { ... } の形をすべて拾う） */
function exportedMethods(source: string): Set<string> {
  const out = new Set<string>();
  const direct = /export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/g;
  for (let m = direct.exec(source); m; m = direct.exec(source)) out.add(m[1]);
  const braces = /export\s*(?:type\s*)?\{([^}]*)\}/g;
  for (let m = braces.exec(source); m; m = braces.exec(source)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) out.add(name);
    }
  }
  return out;
}

describe("使っていない危険な書き込み API は閉じたまま（#81 Q3）", () => {
  it("exportedMethods は関数・const・export { } の形を拾う（検査の前提）", () => {
    const sample = [
      "export async function GET() {}",
      "export function PUT() {}",
      "export const DELETE = async () => {};",
      "const handler = () => {};",
      "export { handler as POST };",
      "export { PATCH } from './x';",
    ].join("\n");
    assert.deepEqual(
      Array.from(exportedMethods(sample)).sort(),
      ["DELETE", "GET", "PATCH", "POST", "PUT"],
      "export の形の一部を見落としている"
    );
  });

  for (const { dir, url, methods } of CLOSED) {
    for (const method of methods) {
      it(`${method} ${url} は export されていない`, () => {
        for (const file of ROUTE_FILES) {
          const path = join(API_DIR, dir, file);
          if (!existsSync(path)) continue;
          const exported = exportedMethods(readFileSync(path, "utf8"));
          assert.equal(exported.has(method), false, `${dir}/${file} が ${method} を export している（#81 Q3 で閉じた API）`);
        }
      });
    }
  }

  it("GET /api/admin/quizzes は残っている（Q1 で作り直すまで）", () => {
    const path = join(API_DIR, "admin", "quizzes", "route.ts");
    assert.ok(existsSync(path), "admin/quizzes/route.ts がない");
    assert.ok(exportedMethods(readFileSync(path, "utf8")).has("GET"), "admin/quizzes/route.ts に GET がない");
  });

  it("画面（page.tsx）は管理用のクイズ・問題の API を呼んでいない", () => {
    const source = readFileSync(PAGE, "utf8");
    const hits = source
      .split("\n")
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter(({ text }) => /\/api\/admin\/(quizzes|questions)\b/.test(text));
    // Q2 で画面から呼ぶときは、閉じたメソッドを使っていないことを確かめてからこの検査を更新する
    assert.deepEqual(hits, [], `page.tsx が管理用のクイズ・問題の API を参照している：${JSON.stringify(hits)}`);
  });
});
