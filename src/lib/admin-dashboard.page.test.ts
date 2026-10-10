import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #32 PR B 管理ダッシュボード：page.tsx（// @ts-nocheck）の AdminDashboard のソースを検査する。DB・ネットワークなし。
// 描画しての確認は admin-dashboard.render.page.test.ts。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const dashboard = component("AdminDashboard");

describe("page.tsx：AdminDashboard の固定値・見本データが残っていない", () => {
  it("固定の数値・月・増減・配色がない", () => {
    for (const s of ['"24"', '"62"', '"7"', '"12"', '"Jan"', '"Feb"', '"Mar"', '"Apr"', "change:", "s.change", "courseColors", "TrendingUp", "_count"]) {
      assert.ok(!dashboard.includes(s), `${s} が AdminDashboard に残っている`);
    }
    assert.ok(!/\{\s*m:\s*"/.test(dashboard), "Monthly Trends の固定の data が残っている");
  });

  it("/api/admin/courses を読まない（統計は /api/admin/stats だけ）", () => {
    assert.ok(!dashboard.includes("/api/admin/courses"), "/api/admin/courses を読んでいる");
    assert.equal(dashboard.split('authFetch("/api/admin/stats")').length - 1, 1, "/api/admin/stats の取得が 1 か所でない");
  });

  it("応答は toAdminDashboardView で確かめ、import されている", () => {
    assert.ok(dashboard.includes("toAdminDashboardView(data)"), "toAdminDashboardView を使っていない");
    assert.match(src, /import \{ toAdminDashboardView \} from "@\/lib\/admin-stats";/);
  });

  it("グラフの data は応答から作る（stats.monthly・distPie）", () => {
    assert.match(dashboard, /<AreaChart data=\{stats\.monthly\}>/);
    assert.match(dashboard, /<Pie data=\{distPie\} nameKey="name"/);
  });
});

describe("page.tsx：AdminDashboard の読み込み", () => {
  it("二重読み込みを防ぐ ref があり、セッション切れは classifyAuthFailure で判定する", () => {
    assert.match(dashboard, /const statsInFlight = useRef\(false\);/);
    assert.match(dashboard, /if \(statsInFlight\.current\) return;/);
    assert.match(dashboard, /classifyAuthFailure\(\{ status: res\.status, redirected: res\.redirected, url: res\.url \}\) === "expired"/);
  });

  it("失敗は role=\"alert\" と再読み込み（loadStats）", () => {
    assert.ok(dashboard.includes('role="alert"'), "role=alert がない");
    assert.match(dashboard, /onClick=\{loadStats\}/);
  });
});

describe("page.tsx：AdminDashboard の見本データ（追加）", () => {
  it("増減の見本（+3・+5%・+4）・旧 state（adminData）・英語の系列名（Active / Completed）が残っていない", () => {
    for (const s of ['"+3"', '"+5%"', '"+4"', "adminData", "setAdminData", 'name="Active"', 'name="Completed"', "c._count"]) {
      assert.ok(!dashboard.includes(s), `${s} が AdminDashboard に残っている`);
    }
  });

  it("円と凡例の色は応答（toAdminDashboardView で検証済み）の color だけを使い、固定の配列から選ばない", () => {
    assert.match(dashboard, /<Cell key=\{e\.key\} fill=\{e\.color\} \/>/);
    assert.ok(!/#[0-9A-Fa-f]{6}", "#[0-9A-Fa-f]{6}"/.test(dashboard), "固定の配色の配列が残っている");
  });

  it("TrendingUp を import していない（page.tsx 全体で未使用）", () => {
    assert.ok(!src.includes("TrendingUp"), "TrendingUp が残っている");
  });
});
