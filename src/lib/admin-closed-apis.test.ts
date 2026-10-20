import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// #81 Q3：管理画面から使っていない危険な書き込み API を閉じた（ハンドラを削除）。
// 検証のない作成・更新と、受験記録・問題の物理削除を API から実行できないようにするため。
// 必要になったら、入力検証・401 / 403 の分離・ログの最小化を入れて作り直す（例：Q1 の PATCH /api/admin/questions/[id]）。
// ここではソースを読んで、閉じたハンドラが戻っていないことを固定する（DB・ネットワークなし）。
// 同じパスに別のメソッド（Q1 の GET や PATCH など）を足すことは妨げない。
// 検査は URL で行う：src/app の下のすべての route ファイルを、ルートグループ (x)・並列ルート @x を除き、
// 動的セグメントの名前（[id] / [quizId] など）を区別せずに URL に直して、閉じた URL と照合する。

const ROOT = join(__dirname, "..", "..");
const APP_DIR = join(__dirname, "..", "app");
const API_DIR = join(APP_DIR, "api");
const PAGE = join(APP_DIR, "page.tsx");

type Closed = { dir: string; url: string; methods: string[] };

const CLOSED: Closed[] = [
  { dir: "admin/quizzes", url: "/api/admin/quizzes", methods: ["POST"] },
  { dir: "admin/quizzes/[id]", url: "/api/admin/quizzes/[id]", methods: ["PUT", "DELETE"] },
  { dir: "admin/quizzes/[id]/questions", url: "/api/admin/quizzes/[id]/questions", methods: ["POST"] },
  { dir: "admin/questions/[id]", url: "/api/admin/questions/[id]", methods: ["PUT", "DELETE"] },
];

const ROUTE_FILES = ["route.ts", "route.tsx", "route.js", "route.jsx", "route.mjs"];

/** export の内容が読み取れない（export * from など）ことを表す印。閉じたメソッドを含みうるとみなす */
const UNKNOWN = "*";

/**
 * コメントと文字列・テンプレートリテラルの中身を空白に置き換える（長さと改行は保つ）。
 * テンプレートの ${ ... } の中はコードとして残す。正規表現リテラルは扱わない（route ファイルでは使っていない前提）。
 */
function blankCommentsAndStrings(source: string): string {
  const out = source.split("");
  const blank = (i: number) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  // テンプレートの ${ の入れ子：数値は ${ の中で開いている { の数
  const templateStack: number[] = [];
  let i = 0;
  const n = source.length;
  const readString = (quote: string) => {
    // i は開き引用符の次。閉じ引用符の位置まで空白にする
    while (i < n && source[i] !== quote) {
      if (source[i] === "\\") {
        blank(i);
        i++;
      }
      if (i < n) blank(i);
      i++;
    }
    i++; // 閉じ引用符
  };
  const readTemplate = () => {
    // i はテンプレート本文の先頭。` か ${ まで空白にする
    while (i < n) {
      if (source[i] === "\\") {
        blank(i);
        i++;
        if (i < n) blank(i);
        i++;
        continue;
      }
      if (source[i] === "`") {
        i++;
        return;
      }
      if (source[i] === "$" && source[i + 1] === "{") {
        templateStack.push(0);
        i += 2;
        return;
      }
      blank(i);
      i++;
    }
  };
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && source[i] !== "\n") blank(i++);
    } else if (c === "/" && d === "*") {
      blank(i++);
      blank(i++);
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) blank(i++);
      if (i < n) {
        blank(i++);
        blank(i++);
      }
    } else if (c === '"' || c === "'") {
      i++;
      readString(c);
    } else if (c === "`") {
      i++;
      readTemplate();
    } else if (templateStack.length > 0 && c === "{") {
      templateStack[templateStack.length - 1]++;
      i++;
    } else if (templateStack.length > 0 && c === "}") {
      if (templateStack[templateStack.length - 1] === 0) {
        templateStack.pop();
        i++;
        readTemplate();
      } else {
        templateStack[templateStack.length - 1]--;
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join("");
}

/** "a as B" / "type X" / "a: B" / "...rest" / "a = 1" から、外から見える名前を取り出す */
function bindingName(part: string, original: string): string | null {
  const text = part.trim();
  if (text === "") return null;
  const asMatch = /\bas\s+([\s\S]+)$/.exec(text);
  if (asMatch) {
    const raw = asMatch[1].trim();
    if (/^["']/.test(raw)) {
      // export { h as "POST" }：文字列の中身は空白にしてあるので、元のソースから読む
      const q = /\bas\s+(["'])([^"']*)\1/.exec(original);
      return q ? q[2] : UNKNOWN;
    }
    return raw;
  }
  const colon = text.lastIndexOf(":");
  const name = (colon >= 0 ? text.slice(colon + 1) : text).replace(/^\.\.\./, "").replace(/=[\s\S]*$/, "").replace(/^type\s+/, "").trim();
  return name || null;
}

/** route ファイルが export している名前（関数・const・分割代入・export { ... }・export * の形を拾う） */
function exportedMethods(source: string): Set<string> {
  const out = new Set<string>();
  const code = blankCommentsAndStrings(source);
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    for (let m = re.exec(code); m; m = re.exec(code)) fn(m);
  };
  const addList = (list: string, offset: number, splitter: RegExp) => {
    let pos = 0;
    for (const part of list.split(splitter)) {
      const original = source.slice(offset + pos, offset + pos + part.length);
      pos += part.length + 1;
      const name = bindingName(part, original);
      if (name) out.add(name);
    }
  };
  // export [declare] [async] function [*] NAME / export const|let|var NAME
  each(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?\s*|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/g, (m) => out.add(m[1]));
  // export const { GET, POST: h } = handlers / export const [GET] = ...
  each(/\bexport\s+(?:const|let|var)\s*\{([^}]*)\}/g, (m) => addList(m[1], m.index + m[0].indexOf("{") + 1, /,/));
  each(/\bexport\s+(?:const|let|var)\s*\[([^\]]*)\]/g, (m) => addList(m[1], m.index + m[0].indexOf("[") + 1, /,/));
  // export { a, b as POST } [from "..."] / export type { ... }
  each(/\bexport\s*(?:type\s*)?\{([^}]*)\}/g, (m) => addList(m[1], m.index + m[0].indexOf("{") + 1, /,/));
  // export * from "..."（中身が分からない）/ export * as NAME from "..."
  each(/\bexport\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*|["'][^"']*["']))?/g, (m) => {
    if (m[1] === undefined) out.add(UNKNOWN);
    else if (/^["']/.test(m[1])) {
      const q = /\bas\s+(["'])([^"']*)\1/.exec(source.slice(m.index, m.index + m[0].length));
      out.add(q ? q[2] : UNKNOWN);
    } else out.add(m[1]);
  });
  // CommonJS：exports.PUT = ... / module.exports.PUT = ... / module.exports = ...
  each(/(?<![\w$.])(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g, (m) => out.add(m[1]));
  each(/(?<![\w$.])module\.exports\s*=/g, () => out.add(UNKNOWN));
  return out;
}

function listRouteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...listRouteFiles(p));
    else if (ROUTE_FILES.includes(name)) found.push(p);
  }
  return found;
}

type Seg = { kind: "static"; name: string } | { kind: "dynamic" } | { kind: "catchAll"; optional: boolean };

/** app ディレクトリからの相対ディレクトリを URL のセグメントに直す（(group) と @slot は URL に出ない） */
function toSegments(relDir: string): Seg[] {
  const segs: Seg[] = [];
  for (const s of relDir.split("/").filter(Boolean)) {
    if (/^\(.*\)$/.test(s) || s.startsWith("@")) continue;
    if (/^\[\[\.\.\..+\]\]$/.test(s)) segs.push({ kind: "catchAll", optional: true });
    else if (/^\[\.\.\..+\]$/.test(s)) segs.push({ kind: "catchAll", optional: false });
    else if (/^\[.+\]$/.test(s)) segs.push({ kind: "dynamic" });
    else segs.push({ kind: "static", name: s });
  }
  return segs;
}

/** route のセグメント（実際のファイル）が閉じた URL（[x] は任意の 1 セグメント）を受けるか */
function routeServes(route: Seg[], closed: Seg[]): boolean {
  const [r, ...rest] = route;
  if (r === undefined) return closed.length === 0;
  if (r.kind === "catchAll") return r.optional ? true : closed.length >= 1;
  const [c, ...cRest] = closed;
  if (c === undefined) return false;
  if (r.kind === "dynamic" && c.kind === "dynamic") return routeServes(rest, cRest);
  if (r.kind === "static" && c.kind === "static" && r.name === c.name) return routeServes(rest, cRest);
  return false;
}

function routesServing(url: string): Array<{ rel: string; path: string }> {
  const closed = toSegments(url);
  return listRouteFiles(APP_DIR)
    .map((path) => ({ path, rel: relative(APP_DIR, path).split(sep).join("/") }))
    .filter(({ rel }) => routeServes(toSegments(rel.split("/").slice(0, -1).join("/")), closed));
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

  it("exportedMethods はそのほかの export の形も拾う（分割代入・export * ・改行・CommonJS など）", () => {
    const cases: Array<[string, string, string[]]> = [
      ["NextAuth の形（分割代入）", "export const { GET, POST } = handlers;", ["GET", "POST"]],
      ["分割代入の別名・既定値・残り", "export const { a: PUT, DELETE = x, ...PATCH } = h;", ["DELETE", "PATCH", "PUT"]],
      ["配列の分割代入", "export const [POST] = list;", ["POST"]],
      ["export * from", 'export * from "./impl";', [UNKNOWN]],
      ["export * as NAME from", 'export * as DELETE from "./impl";', ["DELETE"]],
      ["export {} の改行", "export {\n  a as PUT,\n  b as DELETE,\n};", ["DELETE", "PUT"]],
      ["export{} の空白なし", "export{a as POST}", ["POST"]],
      ["文字列の別名", 'export { h as "DELETE" };', ["DELETE"]],
      ["export let / var", "export let PUT = 1;\nexport var DELETE = 2;", ["DELETE", "PUT"]],
      ["generator", "export function* POST() {}", ["POST"]],
      ["export type {}", "export type { PUT } from './t';", ["PUT"]],
      ["CommonJS", "exports.PUT = h;\nmodule.exports.DELETE = h;", ["DELETE", "PUT"]],
      ["module.exports =", "module.exports = { PUT };", [UNKNOWN]],
      ["改行をはさむ async function", "export\nasync\nfunction\nDELETE() {}", ["DELETE"]],
    ];
    for (const [label, source, expected] of cases) {
      assert.deepEqual(Array.from(exportedMethods(source)).sort(), expected, `${label}：${JSON.stringify(source)}`);
    }
  });

  it("exportedMethods はコメント・文字列・テンプレートの中の export を拾わない", () => {
    const cases: Array<[string, string]> = [
      ["行コメント", "// export async function PUT() {}"],
      ["ブロックコメント", "/* export const DELETE = 1;\n export { h as POST } */"],
      ["JSDoc", "/**\n * export function PUT() {}\n */"],
      ["二重引用符", 'const s = "export async function POST() {}";'],
      ["一重引用符", "const s = 'export { h as DELETE }';"],
      ["エスケープした引用符を含む文字列", 'const s = "\\" export const PUT = 1";'],
      ["テンプレート", "const s = `export * from './x'`;"],
      ["テンプレートの ${} のあとの本文", "const s = `${a}\nexport const DELETE = 1`;"],
      ["入れ子の {} を含む ${}", "const s = `${ {a: 1}.a } export function PUT(){}`;"],
      ["文字列の中のコメント記号", 'const s = "//"; const t = "export const POST = 1";'],
    ];
    for (const [label, source] of cases) {
      assert.deepEqual(Array.from(exportedMethods(source)), [], `${label}を誤検出した：${JSON.stringify(source)}`);
    }
  });

  it("exportedMethods はコメント・文字列のあとの本物の export を拾う（消しすぎない）", () => {
    const source = [
      "// export const DELETE = 1",
      'const s = "export function PUT() {}";',
      "const t = `x ${y} z`;",
      "/* } */ export async function GET() {}",
      "export const PATCH = async () => {};",
    ].join("\n");
    assert.deepEqual(Array.from(exportedMethods(source)).sort(), ["GET", "PATCH"], "本物の export を見落としている");
  });

  it("Q1 で同じパスに GET / PATCH を足しても、閉じたメソッドとはみなさない", () => {
    const q1Like = [
      'import { NextResponse } from "next/server";',
      "// 旧 PUT / DELETE は #81 Q3 で閉じた。PATCH で作り直す",
      "export async function GET() {}",
      "export async function PATCH() {}",
    ].join("\n");
    const exported = exportedMethods(q1Like);
    for (const m of ["POST", "PUT", "DELETE", UNKNOWN]) assert.equal(exported.has(m), false, `${m} を誤検出した`);
    assert.ok(exported.has("GET") && exported.has("PATCH"), "GET / PATCH を拾えていない");
  });

  it("URL の照合（検査の前提）：(group)・@slot・動的セグメントの名前・catch-all を扱う", () => {
    const serves = (dir: string, url: string) => routeServes(toSegments(dir), toSegments(url));
    assert.ok(serves("api/admin/quizzes/[quizId]", "/api/admin/quizzes/[id]"), "動的セグメントの名前の違いを同じ URL とみなせない");
    assert.ok(serves("(admin)/api/admin/questions/[id]", "/api/admin/questions/[id]"), "ルートグループを URL から除けない");
    assert.ok(serves("api/@x/admin/quizzes", "/api/admin/quizzes"), "並列ルートを URL から除けない");
    assert.ok(serves("api/admin/[...rest]", "/api/admin/quizzes/[id]"), "catch-all を見落としている");
    assert.ok(serves("api/admin/quizzes/[[...rest]]", "/api/admin/quizzes"), "optional catch-all を見落としている");
    assert.equal(serves("api/admin/quizzes/reorder", "/api/admin/quizzes/[id]"), false, "固定のセグメントを閉じた [id] とみなしている");
    assert.equal(serves("api/admin/quizzes/[id]", "/api/admin/quizzes"), false, "子の URL を親とみなしている");
    assert.equal(serves("api/quizzes/[quizId]", "/api/admin/quizzes/[id]"), false, "受講生の API を管理用とみなしている");
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

      it(`${method} ${url} は、別の場所（ルートグループ・動的セグメント名の違い・catch-all・route.tsx など）の route ファイルからも export されていない`, () => {
        for (const { rel, path } of routesServing(url)) {
          const exported = exportedMethods(readFileSync(path, "utf8"));
          assert.equal(exported.has(method), false, `${rel} が ${method} を export している（${url} として受ける。#81 Q3 で閉じた API）`);
          assert.equal(exported.has(UNKNOWN), false, `${rel} が export * / module.exports = を使っていて、${method} を出していないことを確かめられない`);
        }
      });
    }
  }

  it("URL の走査は admin/quizzes/route.ts を見つける（走査の前提）", () => {
    // Q1 で [id] などの route ファイルが増えても失敗しないよう、ここでは「含む」だけを確かめる
    const found = routesServing("/api/admin/quizzes").map(({ rel }) => rel);
    assert.ok(found.includes("api/admin/quizzes/route.ts"), `admin/quizzes/route.ts が走査で見つからない：${JSON.stringify(found)}`);
  });

  it("Pages Router（pages/api）に管理用のクイズ・問題の API がない", () => {
    for (const base of [join(ROOT, "pages"), join(ROOT, "src", "pages")]) {
      for (const sub of ["api/admin/quizzes", "api/admin/questions", "api/admin/quizzes.ts", "api/admin/questions.ts", "api/admin/quizzes.js", "api/admin/questions.js"]) {
        assert.equal(existsSync(join(base, sub)), false, `${relative(ROOT, join(base, sub))} がある（Pages Router の API は閉じた URL を受けうる）`);
      }
    }
  });

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

  it("テスト以外のコード（src・scripts・prisma）は管理用のクイズ・問題の API を参照していない", () => {
    const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
    const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.test-helpers\.ts$/;
    const files: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (CODE.test(name) && !TEST.test(name) && !name.includes("__tests__")) files.push(p);
      }
    };
    for (const d of ["src", "scripts", "prisma"]) walk(join(ROOT, d));
    assert.ok(files.length >= 50, `走査したファイルが ${files.length} 件しかない（走査の前提）`);
    const hits: string[] = [];
    for (const f of files) {
      // route ファイルの中のパスはディレクトリで決まるので、文字列として出てくるのは呼び出し元だけ
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((text, i) => {
        if (/api\/admin\/(?:quizzes|questions)\b/.test(text)) hits.push(`${relative(ROOT, f)}:${i + 1}`);
      });
    }
    // Q2 で呼び出し元を足すときは、閉じたメソッドを使っていないことを確かめてからこの検査を更新する
    assert.deepEqual(hits, [], `管理用のクイズ・問題の API の参照が残っている：${JSON.stringify(hits)}`);
  });
});
