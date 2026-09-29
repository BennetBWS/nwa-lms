import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #32 受講生ダッシュボード：page.tsx（@ts-nocheck）の StudentDashboard をソースで検査する。
// レンダリングはしない。見本データが残っていないこと・配線・並べ方を文字列で確認する。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const dashboard = component("StudentDashboard");

describe("StudentDashboard：見本データを残さない", () => {
  const banned: Array<[string, RegExp]> = [
    ["calEvents", /calEvents/],
    ["calLoading", /calLoading/],
    ["fmtTime", /fmtTime/],
    ["calColors", /calColors/],
    ["Schedule カード", /Schedule/],
    ["weekly（配列・見出し）", /\bweekly\b/i],
    ["「4日」バッジ", /4日/],
    ["weeklyHours", /weeklyHours/],
    ["ようこそのフォールバック", /ようこそ！学習を始めましょう/],
    ['title.split("が")', /split\("が"\)/],
    ["お知らせの new 固定", /time: "new"/],
    ["見本 Activity（AG）", /レスポンシブ #15/],
    ["見本 Activity（クイズ）", /JS クイズ/],
    ["見本 Activity（回答）", /山田先生が回答/],
    ["Next Up の見本 todos", /\btodos\b/],
    ["Next Up の赤い点（hi）", /\bhi: true\b|t\.hi\b/],
    ["CTA の見本「コース」", /name: "コース"|\|\| "コース"/],
  ];
  for (const [label, re] of banned) {
    it(`${label} がない`, () => {
      assert.doesNotMatch(dashboard, re);
    });
  }
});

describe("StudentDashboard：データの配線", () => {
  it("student-dashboard の関数を import して使う", () => {
    const m = src.match(/import \{([^}]*)\} from "@\/lib\/student-dashboard";/);
    assert.ok(m, "import がない");
    const names = m[1].split(",").map((s) => s.trim());
    for (const n of ["pickActiveCourse", "toActivityItems", "toNewsItems"]) {
      assert.ok(names.includes(n), n);
      assert.match(dashboard, new RegExp(`\\b${n}\\(`), `${n} を呼んでいない`);
    }
  });

  it("学習時間カードは「直近7日」で completedLast7Days を表示する", () => {
    assert.match(dashboard, /label: "直近7日", value: String\(dashData\?\.completedLast7Days \|\| 0\), sub: "lessons"/);
    assert.doesNotMatch(dashboard, /学習時間/);
  });

  it("お知らせ・Activity は API の値を now 付きで変換する", () => {
    assert.match(dashboard, /toNewsItems\(dashData\?\.notifications, now\)/);
    assert.match(dashboard, /toActivityItems\(dashData\?\.recentActivity, now\)/);
  });

  it("Next Up は nextLessons を表示し、クリックでそのコースのレッスンへ", () => {
    assert.match(dashboard, /dashData\?\.nextLessons/);
    assert.match(dashboard, /setCurrentPage\("lesson", \{ courseId: l\.courseId \}\)/);
  });

  it("空の状態の文言", () => {
    for (const text of ["お知らせはありません", "まだ学習履歴はありません"]) {
      assert.ok(dashboard.includes(text), text);
    }
  });

  it("読み込みに失敗したら 1 枚のエラー表示と再読み込みボタン", () => {
    assert.ok(dashboard.includes("ダッシュボードを読み込めませんでした"));
    assert.match(dashboard, /if \(loadFailed \|\| !dashData\) return \(/);
    assert.match(dashboard, /onClick=\{loadDashboard\}/);
    assert.match(dashboard, /\.catch\(\(\) => setLoadFailed\(true\)\)/);
    // エラー表示は bento（集計カード）より前で return する
    assert.ok(dashboard.indexOf("if (loadFailed || !dashData)") < dashboard.indexOf('className="nwa-bento"'));
  });

  it("コースが 0 件なら CTA を出さない", () => {
    assert.match(dashboard, /\{activeCourse && \(\s*<FadeIn delay=\{80\} style=\{\{ gridColumn: "span 8" \}\}>/);
  });

  it("お知らせのアバターは Bell アイコン（タイトルの 1 文字目ではない）", () => {
    assert.doesNotMatch(dashboard, /title\.charAt\(0\)/);
    assert.match(dashboard, /<Bell size=\{12\} aria-hidden="true" \/>/);
  });
});

describe("StudentDashboard：並べ方（12 列）", () => {
  it("統計 3 → CTA 8 ＋ Next Up 4 → カリキュラム 12 → お知らせ 6 ＋ Activity 6", () => {
    const spans = Array.from(dashboard.matchAll(/gridColumn: ([^}]+?) \}/g), (m) => m[1]);
    assert.deepEqual(spans, [
      '"span 3"',
      '"span 8"',
      'activeCourse ? "span 4" : "span 12"',
      '"span 12"',
      '"span 6"',
      '"span 6"',
    ]);
  });

  it("タブレット（6 列）では span 12 を全幅に、span 6 は上書きしない（全幅）", () => {
    const tablet = src.slice(src.indexOf("@media (max-width: 1024px)"), src.indexOf("@media (max-width: 768px)"));
    assert.match(tablet, /\.nwa-bento \{ grid-template-columns: repeat\(6, 1fr\) !important; \}/);
    assert.match(tablet, /\[style\*="span 12"\] \{ grid-column: span 6 !important; \}/);
    assert.match(tablet, /\[style\*="span 4"\] \{ grid-column: span 6 !important; \}/);
    assert.match(tablet, /\[style\*="span 8"\] \{ grid-column: span 6 !important; \}/);
    assert.doesNotMatch(tablet, /\[style\*="span 6"\]/);
  });

  it("スマホでは 1 列", () => {
    const mobile = src.slice(src.indexOf("@media (max-width: 768px)"), src.indexOf("@media (max-width: 480px)"));
    assert.match(mobile, /\.nwa-bento \{ grid-template-columns: 1fr !important;/);
    assert.match(mobile, /\.nwa-bento > \* \{ grid-column: span 1 !important; \}/);
  });
});
