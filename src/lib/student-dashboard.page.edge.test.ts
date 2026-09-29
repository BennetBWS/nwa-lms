import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #32 page.tsx（// @ts-nocheck）の StudentDashboard をソースで追加検査する。
// @ts-nocheck のため typecheck では未定義の識別子や取り違えを検出できない。ここで文字列として確かめる。
// レンダリングはしない。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const dashboard = component("StudentDashboard");

/** page.tsx のトップレベルで import / 定義されている名前 */
function definedNames(): Set<string> {
  const names = new Set<string>();
  for (const m of Array.from(src.matchAll(/^import\s+([\s\S]*?)\s+from\s+"[^"]+";/gm))) {
    const clause = m[1];
    const def = clause.match(/^(\w+)/);
    if (def) names.add(def[1]);
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const n = part.trim().split(/\s+as\s+/).pop();
        if (n) names.add(n);
      }
    }
  }
  for (const m of Array.from(src.matchAll(/^(?:export\s+)?(?:const|let|var|function)\s+(\w+)/gm))) names.add(m[1]);
  return names;
}

describe("StudentDashboard：未定義の識別子がない（@ts-nocheck の穴埋め）", () => {
  const defined = definedNames();

  it("JSX で使うコンポーネントはすべて import か定義がある", () => {
    const used = new Set(Array.from(dashboard.matchAll(/<([A-Z]\w*)[\s/>]/g), (m) => m[1]));
    assert.ok(used.size > 5);
    // Icon はループ内のローカル変数
    used.delete("Icon");
    const missing = Array.from(used).filter((n) => !defined.has(n));
    assert.deepEqual(missing, []);
  });

  it("stats の icon に使うアイコンも import 済み", () => {
    const icons = Array.from(dashboard.matchAll(/icon: ([A-Z]\w*)/g), (m) => m[1]);
    assert.deepEqual(icons, ["BookOpen", "CheckCircle2", "Flame", "Target"]);
    for (const i of icons) assert.ok(defined.has(i), i);
  });

  it("呼び出している外部の関数・値が定義されている", () => {
    for (const n of [
      "authFetch",
      "glassStyle",
      "greetingTitle",
      "pickActiveCourse",
      "toNewsItems",
      "toActivityItems",
      "CourseIcons",
      "T",
      "useState",
      "useEffect",
    ]) {
      assert.ok(defined.has(n), n);
      assert.match(dashboard, new RegExp(`\\b${n}\\b`), `${n} を使っていない`);
    }
  });

  it("削除した state・関数を参照していない", () => {
    for (const n of ["setCalEvents", "setCalLoading", "calEvents", "fmtTime", "weekly", "todos", "HelpCircle", "MessageSquare"]) {
      assert.doesNotMatch(dashboard, new RegExp(`\\b${n}\\b`), n);
    }
  });

  it("見本 todos で使っていた HelpCircle / MessageSquare は import が残るが、他の画面で使っているので残してよい", () => {
    const body = src.slice(src.indexOf("// COURSE ICONS")).replace(dashboard, "");
    for (const n of ["HelpCircle", "MessageSquare"]) {
      assert.ok(defined.has(n), n);
      assert.match(body, new RegExp(`icon: ${n}\\b|<${n}\\b|: ${n}[,}]`), `${n} は他でも未使用`);
    }
  });
});

describe("StudentDashboard：state と読み込み", () => {
  it("state は dashData / loading / loadFailed の 3 つだけで、すべて使っている", () => {
    const states = Array.from(dashboard.matchAll(/const \[(\w+), (\w+)\] = useState\(([^)]*)\)/g), (m) => [m[1], m[2], m[3]]);
    assert.deepEqual(states, [
      ["dashData", "setDashData", "null"],
      ["loading", "setLoading", "true"],
      ["loadFailed", "setLoadFailed", "false"],
    ]);
    for (const [v, setter] of states) {
      assert.ok(dashboard.split(v).length > 2, `${v} を読んでいない`);
      assert.ok(dashboard.split(`${setter}(`).length > 1, `${setter} を呼んでいない`);
    }
  });

  it("res.ok でない・res.redirected のときは JSON を読まずに失敗扱い", () => {
    assert.match(dashboard, /if \(!res\.ok \|\| res\.redirected\) return null;/);
    assert.match(dashboard, /if \(data && !data\.error\) setDashData\(data\);\s*else setLoadFailed\(true\);/);
  });

  it("再読み込みは loading を戻し、前回の失敗フラグを消してから読む", () => {
    const load = dashboard.slice(dashboard.indexOf("const loadDashboard"), dashboard.indexOf("useEffect("));
    assert.ok(load.indexOf("setLoading(true)") < load.indexOf("authFetch("));
    assert.ok(load.indexOf("setLoadFailed(false)") < load.indexOf("authFetch("));
    assert.match(load, /\.finally\(\(\) => setLoading\(false\)\)/);
  });

  it("初回の読み込みは useEffect の空依存で 1 回", () => {
    assert.match(dashboard, /useEffect\(\(\) => \{ loadDashboard\(\); \}, \[\]\);/);
  });

  it("読み込み中 → 失敗 → 本体 の順に return する", () => {
    const iLoading = dashboard.indexOf("if (loading) return");
    const iFailed = dashboard.indexOf("if (loadFailed || !dashData) return");
    const iMain = dashboard.indexOf('className="nwa-bento"');
    assert.ok(iLoading >= 0 && iLoading < iFailed && iFailed < iMain);
  });
});

describe("StudentDashboard：変数の取り違えがない", () => {
  it("統計カードは API の対応するキーを読む", () => {
    const pairs: Array<[string, string]> = [
      ["受講中", "activeCourses"],
      ["完了", "completedLessons"],
      ["直近7日", "completedLast7Days"],
      ["全体進度", "overallProgress"],
    ];
    for (const [label, key] of pairs) {
      assert.match(dashboard, new RegExp(`label: "${label}", value: String\\(dashData\\?\\.${key} \\|\\| 0\\)`), label);
    }
  });

  it("courses は API の completedLessons / totalLessons を渡し、pickActiveCourse の件数判定に使える", () => {
    assert.match(dashboard, /completedLessons: c\.completedLessons, totalLessons: c\.totalLessons/);
    assert.match(dashboard, /const activeCourse = pickActiveCourse\(courses\);/);
  });

  it("お知らせは news（toNewsItems の結果）、Activity は activity を描画する", () => {
    const newsBlock = dashboard.slice(dashboard.indexOf(">お知らせ<"), dashboard.indexOf(">Activity<"));
    const actBlock = dashboard.slice(dashboard.indexOf(">Activity<"));
    assert.match(newsBlock, /news\.length === 0 && emptyText\("お知らせはありません"\)/);
    assert.match(newsBlock, /news\.map\(\(n, i\) =>/);
    for (const f of ["n.title", "n.message", "n.time", "n.unread", "key={n.id}"]) assert.ok(newsBlock.includes(f), f);
    assert.doesNotMatch(newsBlock, /activity|\ba\./);
    assert.match(actBlock, /activity\.length === 0 && emptyText\("まだ学習履歴はありません"\)/);
    assert.match(actBlock, /activity\.map\(\(a, i\) =>/);
    for (const f of ["a.text", "a.time"]) assert.ok(actBlock.includes(f), f);
    assert.doesNotMatch(actBlock, /\bnews\b|\bn\./);
  });

  it("Next Up は nextLessons の各要素（l）の title と courseId を使う（activeCourse ではない）", () => {
    const block = dashboard.slice(dashboard.indexOf(">Next Up<"), dashboard.indexOf("Row 3"));
    assert.match(block, /nextLessons\.map\(\(l, i\) =>/);
    assert.match(block, /key=\{l\.lessonId\}/);
    assert.match(block, /onClick=\{\(\) => setCurrentPage\("lesson", \{ courseId: l\.courseId \}\)\}/);
    assert.match(block, /\{l\.title\}/);
    assert.doesNotMatch(block, /activeCourse\.id/);
  });

  it("nextLessons が配列でなければ空扱い（古い API 応答でも落ちない）", () => {
    assert.match(dashboard, /const nextLessons = Array\.isArray\(dashData\?\.nextLessons\) \? dashData\.nextLessons : \[\];/);
  });

  it("カリキュラムの受講中・完了は丸めた % ではなく件数で判定する（表示の % は c.progress のまま）", () => {
    assert.ok(definedNames().has("isInProgress"));
    assert.match(dashboard, /const isAct = isInProgress\(c\);/);
    assert.match(dashboard, /const isDone = c\.totalLessons > 0 && c\.completedLessons === c\.totalLessons;/);
    assert.doesNotMatch(dashboard, /c\.progress > 0 && c\.progress < 100|c\.progress === 100/);
    assert.match(dashboard, /\{c\.progress\}%/);
  });

  it("CTA のクリック先は activeCourse のコース", () => {
    assert.match(dashboard, /onClick=\{\(\) => setCurrentPage\("lesson", \{ courseId: activeCourse\.id \}\)\}/);
  });

  it("カリキュラムの「詳細」はコース一覧へ", () => {
    assert.match(dashboard, /onClick=\{\(\) => setCurrentPage\("courses"\)\}/);
  });
});

describe("StudentDashboard：空の状態の分岐", () => {
  it("コース 0 件：CTA なし・Next Up は全幅・カリキュラムは「コースはまだありません」", () => {
    assert.match(dashboard, /\{activeCourse && \(/);
    assert.match(dashboard, /gridColumn: activeCourse \? "span 4" : "span 12"/);
    assert.match(dashboard, /\{courses\.length === 0 && emptyText\("コースはまだありません"\)\}/);
  });

  it("Next Up の空表示は nextUpEmptyMessage に件数（コース数・API の completedLessons / totalLessons）を渡す", () => {
    assert.ok(definedNames().has("nextUpEmptyMessage"));
    assert.match(
      dashboard,
      /emptyText\(nextUpEmptyMessage\(\{ courseCount: courses\.length, completedLessons: dashData\.completedLessons, totalLessons: dashData\.totalLessons \}\)\)/
    );
    // 固定の「すべて完了しました」をソースに直書きしない
    assert.doesNotMatch(dashboard, /"すべて完了しました"/);
  });

  it("お知らせ 0 件・活動 0 件は、それぞれのカードの中だけで空表示（カードは残す）", () => {
    // 空でも span 6 のカードを 2 枚出す（条件付きレンダリングで包まない）
    assert.match(dashboard, /<FadeIn delay=\{200\} style=\{\{ gridColumn: "span 6" \}\}>/);
    assert.match(dashboard, /<FadeIn delay=\{240\} style=\{\{ gridColumn: "span 6" \}\}>/);
    assert.doesNotMatch(dashboard, /news\.length > 0 && \(\s*<FadeIn|activity\.length > 0 && \(\s*<FadeIn/);
  });

  it("失敗時のエラーカードは role=alert で、集計カード（0 で埋めたもの）を出さない", () => {
    const failed = dashboard.slice(dashboard.indexOf("if (loadFailed || !dashData) return"), dashboard.indexOf("const emptyText"));
    assert.match(failed, /role="alert"/);
    assert.doesNotMatch(failed, /nwa-bento|stats\.map|直近7日/);
  });
});
