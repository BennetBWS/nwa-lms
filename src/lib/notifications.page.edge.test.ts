import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAuthFailure } from "./client-session";
import { toNewsItems } from "./student-dashboard";

// #32 page.tsx（// @ts-nocheck）の Notifications を追加検査する。
// loadNotifications の本文をソースから取り出し、偽の useState / useRef / authFetch と
// 本物の classifyAuthFailure で動かして状態遷移を確かめる。レンダリング・DB・ネットワークなし。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const notifications = component("Notifications");
const loadSrc = notifications.slice(notifications.indexOf("const loadNotifications"), notifications.indexOf("useEffect("));

type FakeRes = { status: number; ok: boolean; redirected: boolean; url: string; json: () => Promise<unknown> };
type State = { notifs: unknown; loading: boolean; loadFailed: boolean; inFlight: boolean; fetches: number; jsonReads: number };

/** loadNotifications を実際に動かすハーネス。respond は fetch ごとの応答（例外を返すなら throw） */
function harness(respond: () => Promise<FakeRes>) {
  const st: State = { notifs: null, loading: true, loadFailed: false, inFlight: false, fetches: 0, jsonReads: 0 };
  const ref = {
    get current() {
      return st.inFlight;
    },
    set current(v: boolean) {
      st.inFlight = v;
    },
  };
  const authFetch = (url: string) => {
    assert.equal(url, "/api/notifications");
    st.fetches++;
    return respond().then((r) => ({
      ...r,
      json: () => {
        st.jsonReads++;
        return r.json();
      },
    }));
  };
  const make = new Function(
    "authFetch",
    "classifyAuthFailure",
    "notifsInFlight",
    "setNotifs",
    "setLoading",
    "setLoadFailed",
    `${loadSrc}\nreturn loadNotifications;`
  );
  const load = make(
    authFetch,
    classifyAuthFailure,
    ref,
    (v: unknown) => (st.notifs = v),
    (v: boolean) => (st.loading = v),
    (v: boolean) => (st.loadFailed = v)
  ) as () => void;
  return { st, load };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const API = "https://nwa-lms.example.com/api/notifications";
const ROW = { id: "n1", title: "ダミー", message: "本文", read: false, createdAt: "2026-09-29T12:00:00.000Z" };

function res(p: Partial<FakeRes> & { body?: unknown }): () => Promise<FakeRes> {
  const { body, ...rest } = p;
  return () =>
    Promise.resolve({
      status: 200,
      ok: true,
      redirected: false,
      url: API,
      json: () => Promise.resolve(body),
      ...rest,
    });
}

describe("Notifications：loadNotifications の状態遷移（実行）", () => {
  it("成功：配列を setNotifs し、loading=false・失敗なし・フラグが戻る", async () => {
    const { st, load } = harness(res({ body: [ROW] }));
    load();
    assert.equal(st.inFlight, true);
    assert.equal(st.loading, true);
    await settle();
    assert.deepEqual(st.notifs, [ROW]);
    assert.equal(st.loading, false);
    assert.equal(st.loadFailed, false);
    assert.equal(st.inFlight, false);
  });

  it("成功（空配列）：notifs は [] で失敗にしない", async () => {
    const { st, load } = harness(res({ body: [] }));
    load();
    await settle();
    assert.deepEqual(st.notifs, []);
    assert.equal(st.loadFailed, false);
    assert.equal(st.loading, false);
  });

  for (const [label, r] of [
    ["/login へのリダイレクト", { status: 200, ok: true, redirected: true, url: "https://nwa-lms.example.com/login?callbackUrl=%2F" }],
    ["/login/ 配下へのリダイレクト", { status: 200, ok: true, redirected: true, url: "https://nwa-lms.example.com/login/" }],
    ["401", { status: 401, ok: false, redirected: false, url: API }],
  ] as Array<[string, Partial<FakeRes>]>) {
    it(`失効（${label}）：JSON を読まず、読み込み中のまま・失敗にしない・フラグを戻さない`, async () => {
      const { st, load } = harness(res(r));
      load();
      await settle();
      assert.equal(st.jsonReads, 0);
      assert.equal(st.loading, true);
      assert.equal(st.loadFailed, false);
      assert.equal(st.notifs, null);
      assert.equal(st.inFlight, true);
      // 再呼び出ししても再取得しない
      load();
      await settle();
      assert.equal(st.fetches, 1);
    });
  }

  for (const [label, r] of [
    ["/ へのリダイレクト", { status: 200, ok: true, redirected: true, url: "https://nwa-lms.example.com/" }],
    ["/loginx へのリダイレクト（/login と誤認しない）", { status: 200, ok: true, redirected: true, url: "https://nwa-lms.example.com/loginx" }],
    ["403", { status: 403, ok: false, redirected: false, url: API }],
    ["404", { status: 404, ok: false, redirected: false, url: API }],
    ["500", { status: 500, ok: false, redirected: false, url: API, body: { error: "Internal server error" } }],
  ] as Array<[string, Partial<FakeRes> & { body?: unknown }]>) {
    it(`失敗（${label}）：JSON を読まず loadFailed、loading=false、フラグが戻る`, async () => {
      const { st, load } = harness(res(r));
      load();
      await settle();
      assert.equal(st.jsonReads, 0);
      assert.equal(st.loadFailed, true);
      assert.equal(st.loading, false);
      assert.equal(st.notifs, null);
      assert.equal(st.inFlight, false);
    });
  }

  for (const [label, body] of [
    ["オブジェクト", { error: "x" }],
    ["null", null],
    ["文字列", "[]"],
    ["数値", 0],
  ] as Array<[string, unknown]>) {
    it(`200 でも配列でない応答（${label}）は失敗`, async () => {
      const { st, load } = harness(res({ body }));
      load();
      await settle();
      assert.equal(st.jsonReads, 1);
      assert.equal(st.loadFailed, true);
      assert.equal(st.loading, false);
      assert.equal(st.inFlight, false);
    });
  }

  it("JSON の解析失敗は失敗（フラグが戻る）", async () => {
    const { st, load } = harness(res({ json: () => Promise.reject(new SyntaxError("bad json")) }));
    load();
    await settle();
    assert.equal(st.loadFailed, true);
    assert.equal(st.loading, false);
    assert.equal(st.inFlight, false);
  });

  it("fetch の例外（ネットワーク）は失敗（フラグが戻る）", async () => {
    const { st, load } = harness(() => Promise.reject(new TypeError("Failed to fetch")));
    load();
    await settle();
    assert.equal(st.loadFailed, true);
    assert.equal(st.loading, false);
    assert.equal(st.inFlight, false);
  });

  it("読み込み中の二重呼び出しでは 1 回しか取得しない", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { st, load } = harness(() => gate.then(res({ body: [ROW] })));
    load();
    load();
    load();
    assert.equal(st.fetches, 1);
    release();
    await settle();
    assert.equal(st.inFlight, false);
    assert.deepEqual(st.notifs, [ROW]);
  });

  it("再読み込み：失敗のあとに呼ぶと loading=true・loadFailed=false に戻して取得し、成功すれば表示", async () => {
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { st, load } = harness(() => {
      n++;
      return n === 1 ? res({ status: 500, ok: false })() : gate.then(res({ body: [ROW] }));
    });
    load();
    await settle();
    assert.equal(st.loadFailed, true);
    load();
    assert.equal(st.loading, true);
    assert.equal(st.loadFailed, false);
    release();
    await settle();
    assert.equal(st.fetches, 2);
    assert.deepEqual(st.notifs, [ROW]);
    assert.equal(st.loadFailed, false);
    assert.equal(st.loading, false);
  });

  it("成功後に再読み込みして失敗しても、前回の notifs は残る（表示は失敗カードが優先）", async () => {
    let n = 0;
    const { st, load } = harness(() => (++n === 1 ? res({ body: [ROW] })() : res({ status: 500, ok: false })()));
    load();
    await settle();
    load();
    await settle();
    assert.deepEqual(st.notifs, [ROW]);
    assert.equal(st.loadFailed, true);
    // 描画は loading → loadFailed → 空 → 一覧 の順に判定する
    const iLoading = notifications.indexOf("if (loading) {");
    const iFailed = notifications.indexOf("} else if (loadFailed) {");
    const iEmpty = notifications.indexOf("} else if (n.length === 0) {");
    assert.ok(iLoading >= 0 && iLoading < iFailed && iFailed < iEmpty);
  });
});

describe("Notifications：state・識別子・取り違え", () => {
  it("state は notifs(null) / loading(true) / loadFailed(false)", () => {
    const states = Array.from(notifications.matchAll(/const \[(\w+), (\w+)\] = useState\(([^)]*)\)/g), (m) => [m[1], m[2], m[3]]);
    assert.deepEqual(states, [
      ["notifs", "setNotifs", "null"],
      ["loading", "setLoading", "true"],
      ["loadFailed", "setLoadFailed", "false"],
    ]);
    assert.match(notifications, /const notifsInFlight = useRef\(false\);/);
  });

  it("初回の読み込みは useEffect の空依存で 1 回", () => {
    assert.match(notifications, /useEffect\(\(\) => \{ loadNotifications\(\); \}, \[\]\);/);
  });

  it("使っている識別子はすべて page.tsx で import か定義がある", () => {
    const defined = new Set<string>();
    for (const m of Array.from(src.matchAll(/^import\s+([\s\S]*?)\s+from\s+"[^"]+";/gm))) {
      const def = m[1].match(/^(\w+)/);
      if (def) defined.add(def[1]);
      const braces = m[1].match(/\{([\s\S]*?)\}/);
      if (braces) for (const part of braces[1].split(",")) {
        const n = part.trim().split(/\s+as\s+/).pop();
        if (n) defined.add(n);
      }
    }
    for (const m of Array.from(src.matchAll(/^(?:export\s+)?(?:const|let|var|function)\s+(\w+)/gm))) defined.add(m[1]);

    for (const n of ["useState", "useEffect", "useRef", "authFetch", "classifyAuthFailure", "toNewsItems", "glassStyle", "T", "Bell", "Button", "FadeIn", "ScrollArea"]) {
      assert.ok(defined.has(n), `${n} が未定義`);
      assert.match(notifications, new RegExp(`\\b${n}\\b`), `${n} を使っていない`);
    }
    // JSX で使うコンポーネントもすべて定義済み
    const used = Array.from(new Set(Array.from(notifications.matchAll(/<([A-Z]\w*)[\s/>]/g), (m) => m[1])));
    assert.deepEqual(used.filter((n) => !defined.has(n)), []);
  });

  it("行は toNewsItems の結果（x）の title / message / time / unread / id を使い、旧フィールドを読まない", () => {
    const list = notifications.slice(notifications.indexOf("n.map((x, i) =>"));
    for (const f of ["{x.title}", "{x.message}", "{x.time}", "x.unread", "key={x.id}"]) assert.ok(list.includes(f), f);
    for (const old of ["x.desc", "x.icon", "x.color", "x.read", "x.createdAt", "apiNotifs"]) {
      assert.ok(!notifications.includes(old), old);
    }
  });

  it("未読ドットは role=img と aria-label=未読", () => {
    assert.match(notifications, /\{x\.unread && <div role="img" aria-label="未読"/);
  });

  it("アニメーション遅延は 50ms 刻みで最大 500ms", () => {
    assert.match(notifications, /delay=\{Math\.min\(50 \* i, 500\)\}/);
    const delay = (i: number) => Math.min(50 * i, 500);
    assert.equal(delay(0), 0);
    assert.equal(delay(10), 500);
    assert.equal(delay(49), 500);
  });
});

describe("toNewsItems：id の境界", () => {
  const NOW = new Date("2026-09-29T12:00:00.000Z");
  const base = { title: "t", message: "m", read: false, createdAt: "2026-09-29T11:00:00.000Z" };
  const run = (rows: unknown[]) => toNewsItems(rows as Parameters<typeof toNewsItems>[0], NOW);

  it("数値（0 を含む）・null・undefined・オブジェクト・配列・真偽値の id は飛ばす", () => {
    const got = run([
      { ...base, id: 0 },
      { ...base, id: 1 },
      { ...base, id: null },
      { ...base, id: undefined },
      { ...base, id: { v: "x" } },
      { ...base, id: ["x"] },
      { ...base, id: true },
      { ...base, id: "ok" },
    ]);
    assert.deepEqual(got.map((x) => x.id), ["ok"]);
  });

  it("空文字の id は飛ばす（React の key が重複しないように）", () => {
    assert.deepEqual(run([{ ...base, id: "" }]), []);
  });

  it("同じ id が重複したら最初の 1 件だけ残す", () => {
    const got = run([
      { ...base, id: "a", title: "1" },
      { ...base, id: "a", title: "2" },
      { ...base, id: "b", title: "3" },
    ]);
    assert.deepEqual(got.map((x) => [x.id, x.title]), [["a", "1"], ["b", "3"]]);
  });

  it("String オブジェクトの id は飛ばす", () => {
    assert.deepEqual(run([{ ...base, id: new String("x") }]), []);
  });

  it("id が正しくても title が文字列でなければ飛ばす（両方が条件）", () => {
    assert.deepEqual(run([{ ...base, id: "a", title: 1 }, { ...base, id: "b", title: null }]), []);
  });

  it("API 応答（JSON 経由、createdAt は文字列）をそのまま渡せる・順序を保つ", () => {
    const api = JSON.parse(
      JSON.stringify([
        { id: "n2", title: "新", message: "本文", read: false, createdAt: new Date("2026-09-29T11:00:00.000Z") },
        { id: "n1", title: "旧", message: "本文", read: true, createdAt: new Date("2026-09-28T12:00:00.000Z") },
      ])
    );
    const got = toNewsItems(api, NOW);
    assert.deepEqual(got.map((x) => [x.id, x.unread]), [["n2", true], ["n1", false]]);
    assert.equal(got[0].time, "1時間前");
  });

  it("ダッシュボードのお知らせ：id の欠けた要素だけが消え、他は件数・順序そのまま", () => {
    const dashNotifications = [
      { ...base, id: "d1" },
      { ...base, title: "id なし" },
      { ...base, id: "d2" },
    ];
    assert.deepEqual(run(dashNotifications).map((x) => x.id), ["d1", "d2"]);
    // ダッシュボードの /api/dashboard は select に id を含めている（実データでは消えない）
    const route = readFileSync(join(__dirname, "..", "app", "api", "dashboard", "route.ts"), "utf8");
    const block = route.slice(route.indexOf("prisma.notification.findMany"), route.indexOf("prisma.notification.count"));
    assert.match(block, /select: \{ id: true, title: true, message: true, read: true, createdAt: true \}/);
  });
});
