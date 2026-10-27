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
 * テンプレートの ${ ... } の中はコードとして残す。
 *
 * 既知の穴：正規表現リテラルは扱わない（いまの route ファイルでは使っていない前提）。
 * 正規表現の中の引用符・バッククォート・コメント記号（例 /"/、/`/、/a\/*b/）を文字列やコメントの始まりと読み違え、
 * そのあとの本物のコードまで空白にしうる。この場合は export を見落とす方向（閉じたメソッドが戻っても検査が通る方向）に失敗する。
 * route ファイルに正規表現リテラルを書くときは、この関数を直すか、正規表現を別のファイルに置く。
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

/**
 * 管理用のクイズ・問題の API への参照（文字列として書かれた URL。行ごとに照合する）。
 * 既知の穴：URL を分けて組み立てた場合（"/api/admin/" + "quizzes" など）は拾わない（見落とす方向に失敗する）。
 */
const ADMIN_QUIZ_API_REF = /api\/admin\/(?:quizzes|questions)\b/;

/** 参照の走査から外す route ファイルの置き場所（リポジトリからの相対、区切りは /） */
const OWN_ROUTE_DIRS = ["src/app/api/admin/quizzes/", "src/app/api/admin/questions/"];

/**
 * 管理用のクイズ・問題の API 自身の route ファイルか。
 * これらの route はログ・コメントに自分のパス（例 "PATCH /api/admin/questions/[id]"）を書く慣習があるため、参照の走査から外す。
 * 外すのはこの 2 つのディレクトリの下の route ファイルだけで、同じ場所のほかのファイル（helpers.ts など）や、
 * ほかの API の route ファイル・src/components などは走査する。
 */
function isOwnAdminQuizRoute(rel: string): boolean {
  const name = rel.split("/").pop() ?? "";
  return ROUTE_FILES.includes(name) && OWN_ROUTE_DIRS.some((d) => rel.startsWith(d));
}

/** 1 つのファイル（rel はリポジトリからの相対、区切りは /）の中の参照の位置（"rel:行"） */
function adminQuizApiRefs(rel: string, source: string): string[] {
  if (isOwnAdminQuizRoute(rel)) return [];
  const hits: string[] = [];
  source.split("\n").forEach((text, i) => {
    if (ADMIN_QUIZ_API_REF.test(text)) hits.push(`${rel}:${i + 1}`);
  });
  return hits;
}

function routesServing(url: string): Array<{ rel: string; path: string }> {
  const closed = toSegments(url);
  return listRouteFiles(APP_DIR)
    .map((path) => ({ path, rel: relative(APP_DIR, path).split(sep).join("/") }))
    .filter(({ rel }) => routeServes(toSegments(rel.split("/").slice(0, -1).join("/")), closed));
}

// ───────────── 画面（#81 Q2 のクイズ管理）から呼ぶ形 ─────────────
// 画面は GET（一覧・詳細）と PATCH（問題の修正）だけを使う。パスは画面用の lib の 3 行だけに書き、
// page.tsx はその定数・関数を authFetch の 1 つ目の引数としてだけ使う。閉じたメソッド（POST・PUT・DELETE）は使わない。

/** パスを書いてよい画面用の lib（リポジトリからの相対） */
const VIEW_LIB = "src/lib/admin-quiz-view.ts";

/** VIEW_LIB の中で、パスを書いてよい行（前後の空白を除いた全文）。URL の定数・関数の 3 行だけ */
const VIEW_LIB_URL_LINES = [
  'export const ADMIN_QUIZ_LIST_URL = "/api/admin/quizzes";',
  "return `/api/admin/quizzes/${encodeURIComponent(quizId)}`;",
  "return `/api/admin/questions/${encodeURIComponent(questionId)}`;",
];

/** URL の定数・関数と、page.tsx で許す呼び方（GET は 2 つ目の引数なし、PATCH は method: "PATCH" だけ） */
const VIEW_URL_HELPERS: Array<{ name: string; method: "GET" | "PATCH" }> = [
  { name: "ADMIN_QUIZ_LIST_URL", method: "GET" },
  { name: "adminQuizDetailUrl", method: "GET" },
  { name: "adminQuestionUrl", method: "PATCH" },
];

const HELPER_NAME_RE = new RegExp(`(?<![\\w$])(?:${VIEW_URL_HELPERS.map((x) => x.name).join("|")})(?![\\w$])`, "g");

/** source の open（"(" の位置）に対応する ")" の位置。コメント・文字列は blankCommentsAndStrings で消した code を渡す */
function closingParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 呼び出しの引数の文字列（"(" と ")" の中身）を、トップレベルの , で分ける */
function splitTopLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out.map((a) => a.trim()).filter((a) => a !== "");
}

type HelperUse = { name: string; line: number; ok: boolean; why: string };

/**
 * page.tsx の中の URL の定数・関数の使い方を調べる（import の行は除く）。
 * 許すのは authFetch(<定数・関数の呼び出し>) と authFetch(<関数の呼び出し>, { method: "PATCH", ... }) だけ：
 * - 1 つ目の引数がちょうどその定数・関数の呼び出しであること（URL に何かを足さない）
 * - GET の定数・関数は 2 つ目の引数がないこと（既定の GET）
 * - PATCH の関数は 2 つ目の引数のメソッドが "PATCH" だけであること（method をほかに書かない・変数にしない）
 * 文字列の中身は original から読む（code はコメント・文字列を空白にしたもの）
 */
function helperUses(original: string): HelperUse[] {
  const code = blankCommentsAndStrings(original);
  const uses: HelperUse[] = [];
  const lineOf = (i: number) => code.slice(0, i).split("\n").length;
  for (let m = HELPER_NAME_RE.exec(code); m; m = HELPER_NAME_RE.exec(code)) {
    const name = m[0];
    const at = m.index;
    const lineStart = code.lastIndexOf("\n", at) + 1;
    const lineEnd = code.indexOf("\n", at);
    const lineText = code.slice(lineStart, lineEnd < 0 ? code.length : lineEnd);
    const line = lineOf(at);
    // import { ... } の中（複数行の import の名前の行を含む）は使い方ではない
    const before = code.slice(0, at);
    const lastImport = before.lastIndexOf("import {");
    if (lastImport >= 0 && before.indexOf("}", lastImport) < 0) continue;
    const helper = VIEW_URL_HELPERS.find((x) => x.name === name)!;
    // 直前が authFetch( であること
    const head = code.slice(0, at).replace(/\s+$/, "");
    if (!head.endsWith("authFetch(")) {
      uses.push({ name, line, ok: false, why: `authFetch の 1 つ目の引数でない：${lineText.trim()}` });
      continue;
    }
    const open = head.length - 1;
    const close = closingParen(code, open);
    if (close < 0) {
      uses.push({ name, line, ok: false, why: "authFetch の閉じかっこが見つからない" });
      continue;
    }
    const args = splitTopLevelArgs(code.slice(open + 1, close));
    const originalArgs = splitTopLevelArgs(original.slice(open + 1, close));
    const first = args[0] ?? "";
    const firstOk = name === "ADMIN_QUIZ_LIST_URL" ? first === name : new RegExp(`^${name}\\([^()]*\\)$`).test(first);
    if (!firstOk || args.length > 2) {
      uses.push({ name, line, ok: false, why: `1 つ目の引数が定数・関数の呼び出しだけでない、または引数が多い：${first}` });
      continue;
    }
    if (helper.method === "GET") {
      uses.push({ name, line, ok: args.length === 1, why: args.length === 1 ? "" : "GET の URL に 2 つ目の引数（メソッドなど）を渡している" });
      continue;
    }
    const init = originalArgs[1] ?? "";
    const methods = Array.from(init.matchAll(/\bmethod\s*:\s*([^,}]+)/g), (x) => x[1].trim());
    const ok = args.length === 2 && methods.length === 1 && methods[0] === '"PATCH"' && !/\.\.\./.test(init);
    uses.push({ name, line, ok, why: ok ? "" : `PATCH 以外のメソッド・展開を含む：${init}` });
  }
  return uses;
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
      // 元の場所（api/<dir>/route.*）は routesServing(url) に含まれる（下の前提の確認）ので、別の検査は置かない
      it(`${method} ${url} は、元の場所と別の場所（ルートグループ・動的セグメント名の違い・catch-all・route.tsx など）の route ファイルから export されていない`, () => {
        const served = routesServing(url);
        for (const file of ROUTE_FILES) {
          const path = join(API_DIR, dir, file);
          if (!existsSync(path)) continue;
          assert.ok(served.some((r) => r.path === path), `${dir}/${file} が URL の走査に含まれていない（走査の前提）`);
        }
        for (const { rel, path } of served) {
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

  it("GET /api/admin/quizzes は残っている（#81 Q1 で作り直した一覧）", () => {
    const path = join(API_DIR, "admin", "quizzes", "route.ts");
    assert.ok(existsSync(path), "admin/quizzes/route.ts がない");
    assert.ok(exportedMethods(readFileSync(path, "utf8")).has("GET"), "admin/quizzes/route.ts に GET がない");
  });

  // #81 Q2：画面（クイズ管理）は GET（一覧・詳細）と PATCH（問題の修正）だけを、画面用の lib の URL の定数・関数で呼ぶ。
  // 呼び出しを足す・変えるときは、閉じたメソッド（POST / PUT / DELETE）を使っていないことを確かめてから、ここと下の検査を更新する
  it("画面（page.tsx）は管理用のクイズ・問題の API のパスを直書きしない", () => {
    const source = readFileSync(PAGE, "utf8");
    const hits = source
      .split("\n")
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter(({ text }) => /\/api\/admin\/(quizzes|questions)\b/.test(text));
    assert.deepEqual(hits, [], `page.tsx が管理用のクイズ・問題の API のパスを直書きしている：${JSON.stringify(hits)}`);
  });

  it("画面（page.tsx）は URL の定数・関数を authFetch の 1 つ目の引数としてだけ使い、GET と PATCH だけで呼ぶ", () => {
    const uses = helperUses(readFileSync(PAGE, "utf8"));
    const bad = uses.filter((u) => !u.ok);
    assert.deepEqual(bad, [], `許していない呼び方がある：${JSON.stringify(bad)}`);
    // 3 つとも使っている（検査が空振りしていない）。PATCH は問題の修正の 1 か所だけ
    for (const { name } of VIEW_URL_HELPERS) {
      assert.ok(uses.some((u) => u.name === name), `page.tsx が ${name} を使っていない（検査の前提）`);
    }
    assert.equal(uses.filter((u) => u.name === "adminQuestionUrl").length, 1, "問題の PATCH の呼び出しが 1 か所でない");
  });

  it("呼び方の検査は、閉じたメソッド・URL の組み立て・authFetch 以外での使い方を拾う（検査の前提）", () => {
    const ok = [
      "authFetch(ADMIN_QUIZ_LIST_URL).then(r => r);",
      "authFetch(adminQuizDetailUrl(id));",
      'authFetch(adminQuestionUrl(q.id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });',
      'import {\n  ADMIN_QUIZ_LIST_URL,\n  adminQuestionUrl,\n} from "@/lib/admin-quiz-view";',
      "// コメントの adminQuestionUrl(id) は数えない",
    ];
    for (const source of ok) {
      const bad = helperUses(source).filter((u) => !u.ok);
      assert.deepEqual(bad, [], `正しい呼び方を拒んだ：${source}`);
    }
    const ng = [
      'authFetch(adminQuestionUrl(id), { method: "DELETE" });',
      'authFetch(adminQuestionUrl(id), { method: "PUT" });',
      'authFetch(adminQuizDetailUrl(id), { method: "PUT" });',
      'authFetch(ADMIN_QUIZ_LIST_URL, { method: "POST", body: "{}" });',
      'authFetch(adminQuizDetailUrl(id) + "/questions", { method: "POST" });',
      "authFetch(adminQuestionUrl(id), { method: m });",
      'authFetch(adminQuestionUrl(id), { ...init, method: "PATCH" });',
      'authFetch(adminQuestionUrl(id), { method: "PATCH", method: "DELETE" });',
      "authFetch(adminQuestionUrl(id), init);",
      "fetch(adminQuestionUrl(id), init);",
      "const u = adminQuestionUrl(id);",
      "const u = ADMIN_QUIZ_LIST_URL;",
    ];
    for (const source of ng) {
      const uses = helperUses(source);
      assert.ok(uses.length > 0 && uses.some((u) => !u.ok), `許していない呼び方を見落とした：${source}`);
    }
  });

  it("参照の走査は、外した route ファイル以外の参照を拾う（検査の前提）", () => {
    const ref = 'await fetch(`/api/admin/questions/${id}`, { method: "PUT" });';
    const log = 'console.error("PATCH /api/admin/questions/[id] failed");';
    // 外すのは管理用のクイズ・問題の API 自身の route ファイルだけ
    assert.deepEqual(adminQuizApiRefs("src/app/api/admin/questions/[id]/route.ts", log), [], "questions/[id]/route.ts のログを参照とみなした");
    assert.deepEqual(adminQuizApiRefs("src/app/api/admin/quizzes/route.ts", log), [], "quizzes/route.ts のログを参照とみなした");
    assert.deepEqual(adminQuizApiRefs("src/app/api/admin/quizzes/[id]/questions/route.tsx", log), [], "quizzes/[id]/questions/route.tsx のログを参照とみなした");
    // それ以外は拾う
    const mustHit: string[] = [
      "src/components/FakeQuizEditor.tsx",
      "src/app/page.tsx",
      "src/lib/admin-api.ts",
      "src/app/api/admin/students/route.ts",
      "src/app/api/admin/quizzes/helpers.ts",
      "src/app/api/admin/quizzesx/route.ts",
      "src/app/(admin)/api/admin/questions/[id]/route.ts",
      "scripts/fake.ts",
    ];
    for (const rel of mustHit) {
      assert.deepEqual(adminQuizApiRefs(rel, `const a = 1;\n${ref}`), [`${rel}:2`], `${rel} の参照を見落とした`);
    }
  });

  // #81 Q2：パスを書いてよいのは画面用の lib（VIEW_LIB）の URL の 3 行だけ。呼び出し元を足すときは、閉じたメソッドを
  // 使っていないことを確かめてから、この検査と上の page.tsx の検査の両方を更新する
  it("テスト以外のコード（src・scripts・prisma）は、画面用の lib の URL の 3 行のほかに管理用のクイズ・問題の API を参照していない", () => {
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
      // 管理用のクイズ・問題の API 自身の route ファイル（src/app/api/admin/quizzes/・questions/ の下）は外す。
      // ログ・コメントに自分のパスを書く慣習があり、Q1 で PATCH /api/admin/questions/[id] を足すと落ちるため。
      // そのほかのファイルに出てくるパスは呼び出し元とみなす（外す範囲は isOwnAdminQuizRoute と上の前提の検査を参照）
      const rel = relative(ROOT, f).split(sep).join("/");
      const source = readFileSync(f, "utf8");
      const refs = adminQuizApiRefs(rel, source);
      if (rel !== VIEW_LIB) {
        hits.push(...refs);
        continue;
      }
      // 画面用の lib は、URL の 3 行だけを許す（コメントにもパスを書かない）
      const lines = source.split("\n");
      hits.push(...refs.filter((r) => !VIEW_LIB_URL_LINES.includes(lines[Number(r.split(":").pop()) - 1].trim())));
    }
    assert.deepEqual(hits, [], `管理用のクイズ・問題の API の参照が残っている：${JSON.stringify(hits)}`);
  });

  it("画面用の lib は URL の 3 行をそれぞれ 1 回だけ持ち、メソッドの名前・fetch を書かない", () => {
    const source = readFileSync(join(ROOT, VIEW_LIB), "utf8");
    const lines = source.split("\n").map((l) => l.trim());
    for (const want of VIEW_LIB_URL_LINES) {
      assert.equal(lines.filter((l) => l === want).length, 1, `${VIEW_LIB} に ${want} が 1 行だけない`);
    }
    const code = blankCommentsAndStrings(source);
    assert.doesNotMatch(source, /["'`](?:POST|PUT|DELETE|PATCH|GET)["'`]/, `${VIEW_LIB} がメソッドの名前を文字列で書いている（メソッドは page.tsx の呼び出しで決める）`);
    assert.doesNotMatch(code, /\bmethod\b|(?<![\w$.])fetch\s*\(|authFetch/, `${VIEW_LIB} が通信をしている`);
  });

  it("URL の定数・関数を使うのは page.tsx と画面用の lib だけ（テストを除く）", () => {
    const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
    const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.test-helpers\.ts$/;
    const users: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (CODE.test(name) && !TEST.test(name)) {
          const code = blankCommentsAndStrings(readFileSync(p, "utf8"));
          HELPER_NAME_RE.lastIndex = 0;
          if (HELPER_NAME_RE.test(code)) users.push(relative(ROOT, p).split(sep).join("/"));
          HELPER_NAME_RE.lastIndex = 0;
        }
      }
    };
    for (const d of ["src", "scripts", "prisma"]) walk(join(ROOT, d));
    assert.deepEqual(users.sort(), ["src/app/page.tsx", VIEW_LIB].sort(), "page.tsx と画面用の lib のほかに URL の定数・関数を使うファイルがある");
  });
});
