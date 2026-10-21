import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// #47 P3 並び順 [order, id] の取りこぼしを、ソースを読んで確かめる（DB・ネットワークなし）。
// ソースを読む確認はこのファイルにまとめる（course-order.test.ts は実際にルートを呼んで確かめる）：
// - orderBy の値は共通の定数か、[order, id] のリテラルだけ（配列で order だけ、キーを引用符で囲む、変数に入れる、も検出する）
// - prisma 以外の変数（tx / db）で Course / Section / Lesson を読む箇所や、src/lib で読む箇所も一覧に入れる
// - 画面・純関数で order だけを比べる並べ替え（a.order - b.order で同点を決めない）がない

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTs(p));
    else if (/\.tsx?$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** コメントを除く（行番号がずれないように改行は残す）。行コメントは行頭か空白のあとの // だけ（URL の // を誤って消さない） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, (_c, pre: string) => pre);
}

function readSrc(f: string): string {
  return stripComments(readFileSync(f, "utf8"));
}

function rel(f: string): string {
  return relative(ROOT, f).split("\\").join("/");
}

/** 開き括弧の位置から、対応する閉じ括弧までを返す（文字列リテラル内の括弧は考えない。orderBy の値には出てこない） */
function balanced(src: string, start: number): string {
  const open = src[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    if (depth === 0) {
      assert.equal(ch, close, `括弧の対応が取れない（${src.slice(start, start + 40)}）`);
      return src.slice(start, i + 1);
    }
  }
  throw new Error(`括弧が閉じていない（${src.slice(start, start + 40)}）`);
}

type OrderByUse = { file: string; line: number; value: string };

/** ソース中の `orderBy:` の値をすべて取り出す（リテラルは括弧の対応で、そうでなければ識別子を） */
function orderByUses(file: string, src: string): OrderByUse[] {
  const out: OrderByUse[] = [];
  const re = /\borderBy\s*:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const at = m.index + m[0].length;
    const line = src.slice(0, m.index).split("\n").length;
    const ch = src[at];
    let value: string;
    if (ch === "[" || ch === "{") value = balanced(src, at);
    else value = (/^[A-Za-z_$][\w$.]*(?:\([^)]*\))?/.exec(src.slice(at)) ?? [src.slice(at, at + 30)])[0];
    out.push({ file, line, value });
  }
  return out;
}

/** 空白と引用符を除いた形（`[{ "order": 'asc' }]` → `[{order:asc}]`） */
function normalize(v: string): string {
  return v.replace(/\s+/g, "").replace(/["'`]/g, "").replace(/,(?=[\]}])/g, "");
}

const SHARED_CONSTANTS = new Set(["COURSE_ORDER_BY", "SECTION_ORDER_BY", "LESSON_ORDER_BY"]);
/** order を含むリテラルで認める形（同点を id で決める） */
const ORDER_ID_LITERALS = new Set(["[{order:asc},{id:asc}]", "[{order:desc},{id:desc}]"]);

/** orderBy の値が「order で並べるのに同点を決めない」なら理由を返す。問題なければ null */
function orderByProblem(value: string): string | null {
  const n = normalize(value);
  if (n.startsWith("[") || n.startsWith("{")) {
    if (!/(^|[{,])order:/.test(n)) return null; // order を使わない並び（createdAt など）は対象外
    return ORDER_ID_LITERALS.has(n) ? null : "order を使うのに [order, id] の形でない";
  }
  return SHARED_CONSTANTS.has(n) ? null : "共通の定数（COURSE_ORDER_BY など）以外の識別子。値を確かめられない";
}

describe("orderBy の検出器そのもの（わざと壊した書き方を見つける）", () => {
  it("コメントの中の orderBy: は数えない（行番号は変えない）", () => {
    const src = "// No orderBy: lastActive\n/* orderBy: { order: \"asc\" }\n */\nconst u = \"http://x\"; orderBy: COURSE_ORDER_BY";
    const uses = orderByUses("x.ts", stripComments(src));
    assert.deepEqual(uses.map((u) => [u.line, u.value]), [[4, "COURSE_ORDER_BY"]], "コメントの除去が違う");
  });

  const cases: Array<[string, boolean]> = [
    ['orderBy: { order: "asc" }', true],
    ['orderBy: {order:"desc"}', true],
    ['orderBy: { "order": "asc" }', true],
    ["orderBy: { 'order': 'asc' }", true],
    ['orderBy: [{ order: "asc" }]', true],
    ['orderBy: [{ id: "asc" }, { order: "asc" }]', true],
    ['orderBy: [{ order: "asc" }, { title: "asc" }]', true],
    ['orderBy: [\n  { order: "asc" },\n  { id: "asc" },\n]', false],
    ['orderBy: [{ order: "asc" }, { id: "asc" }]', false],
    ["orderBy: COURSE_ORDER_BY,", false],
    ["orderBy: LESSON_ORDER_BY }", false],
    ["orderBy: ORDER_ONLY,", true],
    ["orderBy: someHelper(),", true],
    ['orderBy: { createdAt: "desc" }', false],
    ['orderBy: [{ createdAt: "asc" }, { id: "asc" }]', false],
    ['orderBy: { name: "asc" }', false],
    ['orderBy: { reorderedAt: "asc" }', false],
  ];
  for (const [code, bad] of cases) {
    it(`${JSON.stringify(code)} は${bad ? "検出する" : "認める"}`, () => {
      const uses = orderByUses("x.ts", code);
      assert.equal(uses.length, 1, `orderBy を 1 件取り出せない（${uses.length} 件）`);
      assert.equal(orderByProblem(uses[0].value) !== null, bad, `判定が違う（値 ${uses[0].value}）`);
    });
  }
});

describe("src の orderBy はすべて [order, id]（共通の定数またはリテラル）", () => {
  it("order を使う orderBy に、同点を決めないもの・値を確かめられない識別子がない", () => {
    const uses = listTs(SRC).flatMap((f) => orderByUses(rel(f), readSrc(f)));
    assert.ok(uses.length >= 20, `orderBy の取り出しが少なすぎる（${uses.length} 件）。検出器が壊れていないか`);
    const offenders = uses
      .map((u) => ({ u, problem: orderByProblem(u.value) }))
      .filter((x) => x.problem !== null)
      .map((x) => `${x.u.file}:${x.u.line} ${x.u.value.replace(/\s+/g, " ")}（${x.problem}）`);
    assert.deepEqual(offenders, [], "order だけで並べる orderBy が見つかった");
  });

  it("共通の定数は、コース・セクション・レッスンを読む箇所で実際に使われている", () => {
    const all = listTs(SRC).map((f) => readSrc(f)).join("\n");
    for (const name of Array.from(SHARED_CONSTANTS)) {
      const n = all.split(new RegExp(`orderBy\\s*:\\s*${name}\\b`)).length - 1;
      assert.ok(n > 0, `${name} が orderBy に使われていない`);
    }
  });
});

describe("Course / Section / Lesson を読む箇所の一覧（prisma 以外の変数・src/lib も含める）", () => {
  // course-order.test.ts の ROUTES（実際に呼んで並び順を確かめるルート）は、そのファイルから読む（一覧を二重に持たない）
  function testedRoutes(): string[] {
    const src = readFileSync(join(__dirname, "course-order.test.ts"), "utf8");
    const files = Array.from(src.matchAll(/\bfile:\s*"([^"]+)"/g)).map((m) => `src/app/api/${m[1]}`);
    assert.ok(files.length >= 9, `course-order.test.ts の ROUTES を読めない（${files.length} 件）`);
    return files;
  }

  /** 並び順を確かめなくてよい理由がある箇所 */
  const ORDER_NOT_NEEDED: Record<string, string> = {
    "src/app/api/admin/courses/[id]/route.ts": "コースの削除のために tx で section / lesson の id を集めるだけ。並び順を使わない",
    "src/app/api/admin/quizzes/[id]/route.ts": "クイズ管理の詳細（#81 Q1）。クイズのコース名を id で 1 件読むだけ（並びはコースの一覧の GET が COURSE_ORDER_BY で決める）",
    "src/app/api/progress/route.ts": "講師の完了で、レッスンの存在を id で 1 件確かめるだけ（#47 P4。受講生は lesson-access で判定）。並び順を使わない",
  };

  /**
   * ルートとして呼ばずに、ソースの orderBy で並び順を確かめる箇所（src/lib など）。
   * ファイル内の orderBy が 1 件以上あり、すべてが共通の定数か [order, id] のリテラルであることを求める。
   */
  const ORDER_BY_CHECKED_IN_SOURCE: Record<string, string> = {
    "src/lib/lesson-access.ts": "API のロック判定（#46 B-1、#47 P4）。コースを並べてロックを計算する",
  };
  /**
   * 別のブランチで追加されるファイル。存在しない間は確認を飛ばし、存在すれば上の確認をすべて行う。
   * 今は空（lesson-access.ts は B-1（PR #64）が入ったので外した。#47 P4）
   */
  const MAY_NOT_EXIST = new Set<string>();

  /** ファイル内の orderBy が、共通の定数か [order, id] のリテラルだけかを確かめる。問題の一覧を返す */
  function strictOrderByProblems(file: string, src: string): string[] {
    const uses = orderByUses(file, src);
    if (uses.length === 0) return [`${file} に orderBy がない`];
    return uses
      .filter((u) => !SHARED_CONSTANTS.has(normalize(u.value)) && !ORDER_ID_LITERALS.has(normalize(u.value)))
      .map((u) => `${u.file}:${u.line} ${u.value.replace(/\s+/g, " ")}（共通の定数でも [order, id] のリテラルでもない）`);
  }

  const READ_RE = /\b([A-Za-z_$][\w$]*)\s*\.\s*(course|section|lesson)\s*\.\s*(findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow)\b/g;

  function readers(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const f of listTs(SRC)) {
      const hits = Array.from(readSrc(f).matchAll(READ_RE)).map((m) => `${m[1]}.${m[2]}.${m[3]}`);
      if (hits.length > 0) out.set(rel(f), hits);
    }
    return out;
  }

  it("検出器は prisma 以外の変数（tx / db）と findFirstOrThrow も拾う", () => {
    const sample = "await tx.lesson.findMany({});\nconst c = db.course.findFirstOrThrow({});\nprisma.section.findUnique({})\nprisma.quiz.findMany({})";
    const hits = Array.from(sample.matchAll(READ_RE)).map((m) => `${m[1]}.${m[2]}.${m[3]}`);
    assert.deepEqual(hits, ["tx.lesson.findMany", "db.course.findFirstOrThrow", "prisma.section.findUnique"], "検出器の結果が違う");
  });

  it("読む箇所は、ルートのテスト（ROUTES）か、並び順が要らない理由のある一覧のどちらかに入っている", () => {
    const known = new Set([...testedRoutes(), ...Object.keys(ORDER_NOT_NEEDED), ...Object.keys(ORDER_BY_CHECKED_IN_SOURCE)]);
    const unknown = Array.from(readers().entries()).filter(([f]) => !known.has(f)).map(([f, hits]) => `${f}（${hits.join(", ")}）`);
    assert.deepEqual(
      unknown,
      [],
      "Course / Section / Lesson を読む新しい箇所がある。course-order.test.ts の ROUTES に加えて並び順を確かめるか、ORDER_BY_CHECKED_IN_SOURCE（ソースの orderBy で確かめる）か ORDER_NOT_NEEDED（並び順が要らない理由）に書く"
    );
  });

  it("一覧に書いたファイルが実在する（古い一覧で検出を素通りさせない）", () => {
    for (const f of [...testedRoutes(), ...Object.keys(ORDER_NOT_NEEDED), ...Object.keys(ORDER_BY_CHECKED_IN_SOURCE)]) {
      if (MAY_NOT_EXIST.has(f)) continue;
      assert.ok(existsSync(join(ROOT, f)), `${f} が存在しない`);
    }
  });

  it("ソースで確かめる箇所は、orderBy がすべて共通の定数か [order, id] のリテラル（存在する場合）", () => {
    const problems: string[] = [];
    for (const f of Object.keys(ORDER_BY_CHECKED_IN_SOURCE)) {
      const path = join(ROOT, f);
      if (!existsSync(path)) {
        assert.ok(MAY_NOT_EXIST.has(f), `${f} が存在しない`);
        continue;
      }
      problems.push(...strictOrderByProblems(f, readSrc(path)));
    }
    assert.deepEqual(problems, [], "ソースで確かめる箇所の orderBy が [order, id] でない");
  });

  it("ソースで確かめる検出器は、orderBy がないファイル・order 以外の並び・知らない識別子を拾う", () => {
    assert.deepEqual(strictOrderByProblems("ok.ts", 'x({ orderBy: COURSE_ORDER_BY }); y({ orderBy: [{ order: "asc" }, { id: "asc" }] })'), [], "正しい書き方を誤って拾う");
    assert.equal(strictOrderByProblems("none.ts", "prisma.course.findMany({})").length, 1, "orderBy がないファイルを拾わない");
    assert.equal(strictOrderByProblems("t.ts", 'x({ orderBy: { createdAt: "asc" } })').length, 1, "order 以外の並びを拾わない");
    assert.equal(strictOrderByProblems("t.ts", "x({ orderBy: ORDER_ONLY })").length, 1, "知らない識別子を拾わない");
    assert.equal(strictOrderByProblems("t.ts", 'x({ orderBy: { order: "asc" } })').length, 1, "order だけの並びを拾わない");
  });
});

describe("画面・純関数の並べ替えも同点を決める", () => {
  it("a.order - b.order のあとに同点の比較（||）がない並べ替えがない", () => {
    const offenders: string[] = [];
    for (const f of listTs(SRC)) {
      const src = readSrc(f);
      for (const m of Array.from(src.matchAll(/\b\w+(?:\.\w+)*\.order\s*-\s*\w+(?:\.\w+)*\.order\b(?!\s*\|\|)/g))) {
        offenders.push(`${rel(f)}:${src.slice(0, m.index).split("\n").length} ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, [], "order だけを比べる並べ替えがある（同点の順が API の [order, id] と食い違う）");
  });

  it("検出器は order だけの比較を拾い、|| で同点を決める比較は認める", () => {
    const re = /\b\w+(?:\.\w+)*\.order\s*-\s*\w+(?:\.\w+)*\.order\b(?!\s*\|\|)/g;
    assert.equal(Array.from("xs.sort((a, b) => a.order - b.order)".matchAll(re)).length, 1, "order だけの比較を拾わない");
    assert.equal(Array.from("xs.sort((a, b) => a.section.order - b.section.order)".matchAll(re)).length, 1, "入れ子の order を拾わない");
    assert.equal(Array.from("(a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)".matchAll(re)).length, 0, "|| つきの比較を誤って拾う");
  });
});
