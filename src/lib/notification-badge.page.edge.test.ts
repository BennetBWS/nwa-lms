import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { classifyAuthFailure } from "./client-session";
import { toNewsItems } from "./student-dashboard";
import { avatarInitial, displayName } from "./user-display";
import {
  MARK_READ_MAX_IDS,
  formatBadgeCount,
  readMarkReadResponse,
  readUnreadCountResponse,
  toUnreadCount,
  unreadBadgeLabel,
  unreadIdsToMark,
} from "./notification-read";

// #62 PR-2 未読バッジと既読化の追加検査（tester）。notification-badge.page.test.ts を補う。
// - Notifications の loadNotifications と既読化（useEffect [notifs]）を一緒に動かす
//   （StrictMode の二重実行・同じ一覧の再描画・読み込み失敗・失効・表示状態）
// - Home の handlePageChange・loadUnreadCount・applyUnreadCount と Notifications をつないだ競合
// - バッジの境界値の追加・モバイルのオーバーレイ・他の画面への影響・個人情報
// page.tsx（// @ts-nocheck）のソースから関数を取り出し、偽の authFetch / state で動かす。
// DOM・DB・ネットワークなし。データはすべてダミー。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  assert.ok(a >= 0, `${from} が見つからない`);
  const b = text.indexOf(to, a);
  assert.ok(b > a, `${to} が見つからない`);
  return text.slice(a, b);
}

const notifications = component("Notifications");
const rootStart = src.indexOf("export default function NWALearningPlatform");
assert.ok(rootStart >= 0, "NWALearningPlatform が見つからない");
const root = src.slice(rootStart);

const loadSrc = between(notifications, "const loadNotifications", "useEffect(() => { loadNotifications(); }, []);");
const markSrc = between(notifications, "const markShownAsRead", "useEffect(() => { if (notifs)");
const countSrc = between(root, "const loadUnreadCount", "// #62 After sign-in");
const pageChangeSrc = between(root, "const handlePageChange = (p, data) => {", "\n  };") + "\n  };";

type FakeRes = { status: number; ok: boolean; redirected: boolean; url: string; json: () => Promise<unknown> };
type Init = { method?: string; headers?: Record<string, string>; body?: string };
type Req = { url: string; init?: Init; release: (r: FakeRes) => void; fail: (e: unknown) => void };

const ORIGIN = "https://nwa-lms.example.com";
const LIST = "/api/notifications";
const READ = "/api/notifications/read";
const COUNT = "/api/notifications/unread-count";

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
function res(path: string, body: unknown, p: Partial<FakeRes> = {}): FakeRes {
  return { status: 200, ok: true, redirected: false, url: `${ORIGIN}${path}`, json: () => Promise.resolve(body), ...p };
}
const row = (id: string, read: boolean) => ({
  id,
  title: `ダミー件名 ${id}`,
  message: `ダミー本文 ${id}`,
  read,
  createdAt: "2026-10-01T00:00:00.000Z",
});

/** 偽の authFetch。要求は reqs に溜まり、テストが release / fail で応答を返す */
function fakeFetch() {
  const reqs: Req[] = [];
  const authFetch = (url: string, init?: Init) =>
    new Promise<FakeRes>((release, fail) => reqs.push({ url, init, release, fail }));
  const of = (path: string) => reqs.filter((r) => r.url === path);
  return { reqs, authFetch, of };
}

// ═══════════════════════════════════════════
// Home：件数（loadUnreadCount / applyUnreadCount / handlePageChange）
// ═══════════════════════════════════════════
function homeHarness(f: ReturnType<typeof fakeFetch>, opts: { student: boolean }) {
  const st = { count: null as number | null, sets: 0, page: "dashboard", mobileMenu: true, courseId: null as unknown };
  const seq = { current: 0 };
  const makeCount = new Function(
    "authFetch",
    "classifyAuthFailure",
    "readUnreadCountResponse",
    "toUnreadCount",
    "unreadSeq",
    "setUnreadCount",
    `${countSrc}\nreturn { loadUnreadCount, applyUnreadCount };`
  );
  const { loadUnreadCount, applyUnreadCount } = makeCount(
    f.authFetch,
    classifyAuthFailure,
    readUnreadCountResponse,
    toUnreadCount,
    seq,
    (v: number) => {
      st.sets++;
      st.count = v;
    }
  ) as { loadUnreadCount: () => void; applyUnreadCount: (v: unknown) => void };
  const makeChange = new Function(
    "setPage",
    "setMobileMenu",
    "setSelectedCourseId",
    "student",
    "loadUnreadCount",
    `${pageChangeSrc}\nreturn handlePageChange;`
  );
  const handlePageChange = makeChange(
    (p: string) => (st.page = p),
    (v: boolean) => (st.mobileMenu = v),
    (v: unknown) => (st.courseId = v),
    opts.student,
    loadUnreadCount
  ) as (p: string, data?: unknown) => void;
  return { st, seq, loadUnreadCount, applyUnreadCount, handlePageChange };
}

describe("Home：handlePageChange と件数の取得（実行）", () => {
  it("受講生：画面を切り替えるたびに件数を 1 回ずつ取得し、既存の処理（ページ・メニュー・courseId）も行う", () => {
    const f = fakeFetch();
    const h = homeHarness(f, { student: true });
    h.handlePageChange("courses");
    h.handlePageChange("lesson", { courseId: "c-dummy" });
    h.handlePageChange("notifications");
    assert.equal(f.of(COUNT).length, 3, "画面の切り替えごとに 1 回取得していない");
    assert.equal(f.reqs.length, 3, "件数以外の要求を送っている");
    assert.equal(h.st.page, "notifications");
    assert.equal(h.st.mobileMenu, false, "モバイルのメニューを閉じていない");
    assert.equal(h.st.courseId, "c-dummy", "courseId を設定していない");
  });

  it("講師・失効後（student が偽）：画面を切り替えても件数を取得しない", () => {
    const f = fakeFetch();
    const h = homeHarness(f, { student: false });
    h.handlePageChange("admin-dashboard");
    h.handlePageChange("admin-students");
    assert.equal(f.reqs.length, 0, "受講生でないのに件数を取得した");
    assert.equal(h.st.page, "admin-students");
  });

  it("連続した画面切り替え：応答が逆順・ばらばらに返っても最後の要求の値だけを使う", async () => {
    const f = fakeFetch();
    const h = homeHarness(f, { student: true });
    h.handlePageChange("courses");
    h.handlePageChange("lesson");
    h.handlePageChange("quiz");
    const [a, b, c] = f.of(COUNT);
    b.release(res(COUNT, { count: 7 }));
    await settle();
    c.release(res(COUNT, { count: 3 }));
    await settle();
    a.release(res(COUNT, { count: 9 }));
    await settle();
    assert.equal(h.st.count, 3, "古い応答で上書きした");
    assert.equal(h.st.sets, 1, "最後の要求以外の応答を反映した");
  });

  it("連続した画面切り替えで最後の要求が失敗したら、前の値のまま（古い応答も使わない）", async () => {
    const f = fakeFetch();
    const h = homeHarness(f, { student: true });
    h.loadUnreadCount();
    f.of(COUNT)[0].release(res(COUNT, { count: 2 }));
    await settle();
    h.handlePageChange("courses");
    h.handlePageChange("lesson");
    const [, older, latest] = f.of(COUNT);
    older.release(res(COUNT, { count: 8 }));
    latest.release(res(COUNT, { error: "Internal server error" }, { status: 500, ok: false }));
    await settle();
    assert.equal(h.st.count, 2, "失敗または古い応答で値が変わった");
  });

  it("403（authFetch が失効と判断した場合も含む）は前の値のまま・JSON を読まない", async () => {
    const f = fakeFetch();
    const h = homeHarness(f, { student: true });
    h.loadUnreadCount();
    f.of(COUNT)[0].release(res(COUNT, { count: 4 }));
    await settle();
    h.loadUnreadCount();
    let jsonRead = false;
    f.of(COUNT)[1].release(res(COUNT, { count: 99 }, { status: 403, ok: false, json: () => ((jsonRead = true), Promise.resolve({ count: 99 })) }));
    await settle();
    assert.equal(h.st.count, 4, "403 の応答で値が変わった");
    assert.equal(jsonRead, false, "403 の本文を読んだ");
  });

  for (const v of [NaN, Infinity, -0.5, 2 ** 53, true, "1", { n: 1 }]) {
    it(`件数の応答 count=${String(typeof v === "object" ? JSON.stringify(v) : v)} は使わない（前の値のまま）`, async () => {
      const f = fakeFetch();
      const h = homeHarness(f, { student: true });
      h.loadUnreadCount();
      f.of(COUNT)[0].release(res(COUNT, { count: 1 }));
      await settle();
      h.loadUnreadCount();
      f.of(COUNT)[1].release(res(COUNT, { count: v }));
      await settle();
      assert.equal(h.st.count, 1, "不正な件数で値が変わった");
    });
  }
});

// ═══════════════════════════════════════════
// Notifications：読み込みと既読化を一緒に動かす
// ═══════════════════════════════════════════
/**
 * loadNotifications と markShownAsRead を取り出し、React の代わりに
 * 「setNotifs で値（参照）が変わったら useEffect [notifs] を走らせる」小さな実行環境で動かす。
 */
function pageHarness(f: ReturnType<typeof fakeFetch>, onUnreadChange?: (n: unknown) => void) {
  const st = { notifs: null as unknown, loading: true, loadFailed: false, renders: 0 };
  const loadRef = { current: false };
  const markRef = { current: false };
  let markShownAsRead: (rows: unknown) => void = () => {};
  /** useEffect(() => { if (notifs) markShownAsRead(notifs); }, [notifs]) */
  let lastDep: unknown = Symbol("初回");
  const runMarkEffect = () => {
    if (Object.is(lastDep, st.notifs)) return;
    lastDep = st.notifs;
    if (st.notifs) markShownAsRead(st.notifs);
  };
  /** StrictMode：同じ依存でも mount 時は 2 回走る */
  const runMarkEffectForced = () => {
    lastDep = st.notifs;
    if (st.notifs) markShownAsRead(st.notifs);
  };
  const setNotifs = (v: unknown) => {
    st.notifs = v;
    st.renders++;
    runMarkEffect();
  };
  const makeLoad = new Function(
    "authFetch",
    "classifyAuthFailure",
    "notifsInFlight",
    "setNotifs",
    "setLoading",
    "setLoadFailed",
    `${loadSrc}\nreturn loadNotifications;`
  );
  const load = makeLoad(
    f.authFetch,
    classifyAuthFailure,
    loadRef,
    setNotifs,
    (v: boolean) => (st.loading = v),
    (v: boolean) => (st.loadFailed = v)
  ) as () => void;
  const makeMark = new Function(
    "authFetch",
    "classifyAuthFailure",
    "toNewsItems",
    "unreadIdsToMark",
    "readMarkReadResponse",
    "markReadInFlight",
    "onUnreadChange",
    "setNotifs",
    "setLoading",
    "setLoadFailed",
    `${markSrc}\nreturn markShownAsRead;`
  );
  // 既読化が表示の state を書き換えたら検出できるように、本物と同じ setter を渡す
  markShownAsRead = makeMark(
    f.authFetch,
    classifyAuthFailure,
    toNewsItems,
    unreadIdsToMark,
    readMarkReadResponse,
    markRef,
    onUnreadChange,
    setNotifs,
    (v: boolean) => (st.loading = v),
    (v: boolean) => (st.loadFailed = v)
  ) as (rows: unknown) => void;
  /** mount：StrictMode なら effect を 2 回ずつ走らせる */
  const mount = (strict: boolean) => {
    load();
    runMarkEffectForced();
    if (strict) {
      load();
      runMarkEffectForced();
    }
  };
  /** 同じ notifs での再描画（親の件数が変わったときなど） */
  const rerender = () => {
    st.renders++;
    runMarkEffect();
  };
  /** 表示される行（Notifications 本体と同じ変換） */
  const shown = () => toNewsItems(st.notifs as never, new Date());
  return { st, load, mount, rerender, shown, markRef };
}

describe("Notifications：読み込み→既読化（実行）", () => {
  it("StrictMode の mount（effect 2 回）でも、一覧の取得 1 回・既読化 1 回", async () => {
    const f = fakeFetch();
    const changes: unknown[] = [];
    const p = pageHarness(f, (n) => changes.push(n));
    p.mount(true);
    assert.equal(f.of(LIST).length, 1, "一覧を 2 回取得した");
    assert.equal(f.of(READ).length, 0, "一覧の取得前に既読化した");
    f.of(LIST)[0].release(res(LIST, [row("n1", false), row("n2", true), row("n3", false)]));
    await settle();
    assert.equal(f.of(READ).length, 1, "既読化が 1 回でない");
    assert.deepEqual(JSON.parse(f.of(READ)[0].init?.body ?? "null"), { ids: ["n1", "n3"] });
    f.of(READ)[0].release(res(READ, { updated: 2, unreadCount: 0 }));
    await settle();
    assert.deepEqual(changes, [0]);
  });

  it("同じ一覧の再描画（バッジの更新などで親が描き直す）では既読化を送り直さない", async () => {
    const f = fakeFetch();
    const p = pageHarness(f, () => {});
    p.mount(false);
    f.of(LIST)[0].release(res(LIST, [row("n1", false)]));
    await settle();
    p.rerender();
    p.rerender();
    assert.equal(f.of(READ).length, 1, "送信中の再描画で送り直した");
    f.of(READ)[0].release(res(READ, { updated: 1, unreadCount: 0 }));
    await settle();
    p.rerender();
    assert.equal(f.of(READ).length, 1, "成功後の再描画で送り直した");
  });

  it("既読化に成功しても notifs は書き換えない：太字・ドット（unread）は残り、読み込み状態も変わらない", async () => {
    const f = fakeFetch();
    const p = pageHarness(f, () => {});
    p.mount(false);
    const rows = [row("n1", false), row("n2", true)];
    f.of(LIST)[0].release(res(LIST, rows));
    await settle();
    const before = p.st.notifs;
    const renders = p.st.renders;
    f.of(READ)[0].release(res(READ, { updated: 1, unreadCount: 0 }));
    await settle();
    assert.equal(p.st.notifs, before, "notifs を差し替えた");
    assert.equal(p.st.renders, renders, "既読化で notifs を設定し直した");
    assert.deepEqual(
      p.shown().map((x) => [x.id, x.unread]),
      [
        ["n1", true],
        ["n2", false],
      ],
      "未読の表示が消えた"
    );
    assert.equal(p.st.loading, false);
    assert.equal(p.st.loadFailed, false, "既読化の後に失敗表示になった");
  });

  for (const [label, r] of [
    ["500", { status: 500, ok: false }],
    ["403", { status: 403, ok: false }],
    ["例外", null],
  ] as Array<[string, Partial<FakeRes> | null]>) {
    it(`既読化の失敗（${label}）：表示は一覧のまま（失敗カードを出さない）・件数は変えない`, async () => {
      const f = fakeFetch();
      const changes: unknown[] = [];
      const p = pageHarness(f, (n) => changes.push(n));
      p.mount(false);
      f.of(LIST)[0].release(res(LIST, [row("n1", false)]));
      await settle();
      if (r === null) f.of(READ)[0].fail(new TypeError("Failed to fetch"));
      else f.of(READ)[0].release(res(READ, { error: "x" }, r));
      await settle();
      assert.equal(p.st.loadFailed, false, "既読化の失敗で失敗表示になった");
      assert.equal(p.st.loading, false);
      assert.equal(p.shown().length, 1, "一覧が消えた");
      assert.deepEqual(changes, [], "失敗なのに件数を変えた");
      assert.equal(p.markRef.current, false, "フラグが戻らず次回に再試行できない");
    });
  }

  it("既読化に失敗したあと、ページを開き直す（新しい mount）と再試行する", async () => {
    const f = fakeFetch();
    const p1 = pageHarness(f, () => {});
    p1.mount(false);
    f.of(LIST)[0].release(res(LIST, [row("n1", false)]));
    await settle();
    f.of(READ)[0].release(res(READ, {}, { status: 500, ok: false }));
    await settle();
    const p2 = pageHarness(f, () => {});
    p2.mount(false);
    f.of(LIST)[1].release(res(LIST, [row("n1", false)]));
    await settle();
    assert.equal(f.of(READ).length, 2, "開き直しても再試行しない");
  });

  for (const [label, r, body] of [
    ["401", { status: 401, ok: false }, { error: "Unauthorized" }],
    ["/login へのリダイレクト", { redirected: true, url: `${ORIGIN}/login?callbackUrl=%2F` }, "<html>"],
    ["500", { status: 500, ok: false }, { error: "Internal server error" }],
    ["配列でない 200", {}, { error: "x" }],
  ] as Array<[string, Partial<FakeRes>, unknown]>) {
    it(`一覧の取得が成功しなければ（${label}）既読化を送らない`, async () => {
      const f = fakeFetch();
      const p = pageHarness(f, () => {});
      p.mount(true);
      f.of(LIST)[0].release(res(LIST, body, r));
      await settle();
      assert.equal(f.of(READ).length, 0, "一覧が取れていないのに既読化した");
    });
  }

  it("一覧の取得失敗→再読み込みで成功したら、そのとき 1 回だけ既読化する", async () => {
    const f = fakeFetch();
    const p = pageHarness(f, () => {});
    p.mount(false);
    f.of(LIST)[0].release(res(LIST, null, { status: 500, ok: false }));
    await settle();
    assert.equal(p.st.loadFailed, true);
    p.load();
    f.of(LIST)[1].release(res(LIST, [row("n1", false)]));
    await settle();
    assert.equal(p.st.loadFailed, false);
    assert.equal(f.of(READ).length, 1);
  });

  it("空の一覧・すべて既読：既読化を送らず、空の表示／一覧の表示はそのまま", async () => {
    for (const rows of [[], [row("n1", true), row("n2", true)]]) {
      const f = fakeFetch();
      const changes: unknown[] = [];
      const p = pageHarness(f, (n) => changes.push(n));
      p.mount(true);
      f.of(LIST)[0].release(res(LIST, rows));
      await settle();
      assert.equal(f.of(READ).length, 0, `未読 0 件（${rows.length} 行）で既読化した`);
      assert.deepEqual(changes, []);
      assert.equal(p.st.loadFailed, false);
      assert.equal(p.shown().length, rows.length);
    }
  });

  it(`未読 ${MARK_READ_MAX_IDS + 10} 件を表示しても送るのは表示順の先頭 ${MARK_READ_MAX_IDS} 件・応答の件数でバッジを更新`, async () => {
    const f = fakeFetch();
    const changes: unknown[] = [];
    const p = pageHarness(f, (n) => changes.push(n));
    p.mount(false);
    const rows = Array.from({ length: MARK_READ_MAX_IDS + 10 }, (_, i) => row(`n${i}`, false));
    f.of(LIST)[0].release(res(LIST, rows));
    await settle();
    const ids = JSON.parse(f.of(READ)[0].init?.body ?? "null").ids as string[];
    assert.equal(ids.length, MARK_READ_MAX_IDS);
    assert.deepEqual(ids, rows.slice(0, MARK_READ_MAX_IDS).map((r) => r.id));
    f.of(READ)[0].release(res(READ, { updated: MARK_READ_MAX_IDS, unreadCount: 10 }));
    await settle();
    assert.deepEqual(changes, [10], "残りの未読件数でバッジを更新していない");
  });

  it("既読化の応答が不正（unreadCount が負数・小数・文字列・null）なら件数を変えない", async () => {
    for (const unreadCount of [-1, 0.5, "0", null, NaN]) {
      const f = fakeFetch();
      const changes: unknown[] = [];
      const p = pageHarness(f, (n) => changes.push(n));
      p.mount(false);
      f.of(LIST)[0].release(res(LIST, [row("n1", false)]));
      await settle();
      f.of(READ)[0].release(res(READ, { updated: 1, unreadCount }));
      await settle();
      assert.deepEqual(changes, [], `unreadCount=${String(unreadCount)} で件数を変えた`);
    }
  });
});

// ═══════════════════════════════════════════
// Home と Notifications をつないだ競合
// ═══════════════════════════════════════════
describe("Home × Notifications：件数の取得と既読化の競合（実行）", () => {
  it("通知ページへ切り替え：件数の取得が既読化の応答より後に返っても、既読化後の件数を上書きしない", async () => {
    const f = fakeFetch();
    const home = homeHarness(f, { student: true });
    home.loadUnreadCount();
    f.of(COUNT)[0].release(res(COUNT, { count: 2 }));
    await settle();
    assert.equal(home.st.count, 2);
    // 通知ページへ（件数の取得と一覧の取得が同時に走る）
    home.handlePageChange("notifications");
    const page = pageHarness(f, home.applyUnreadCount);
    page.mount(true);
    f.of(LIST)[0].release(res(LIST, [row("n1", false), row("n2", false)]));
    await settle();
    f.of(READ)[0].release(res(READ, { updated: 2, unreadCount: 0 }));
    await settle();
    assert.equal(home.st.count, 0, "既読化の件数でバッジが減っていない");
    // 既読化より前に出した件数の要求（既読化前の 2 件）が遅れて返る
    f.of(COUNT)[1].release(res(COUNT, { count: 2 }));
    await settle();
    assert.equal(home.st.count, 0, "既読化前の古い件数でバッジが戻った");
  });

  it("件数の取得が先に返った場合も、最後は既読化の件数になる", async () => {
    const f = fakeFetch();
    const home = homeHarness(f, { student: true });
    home.handlePageChange("notifications");
    const page = pageHarness(f, home.applyUnreadCount);
    page.mount(false);
    f.of(COUNT)[0].release(res(COUNT, { count: 3 }));
    await settle();
    assert.equal(home.st.count, 3);
    f.of(LIST)[0].release(res(LIST, [row("n1", false), row("n2", false), row("n3", false)]));
    await settle();
    f.of(READ)[0].release(res(READ, { updated: 3, unreadCount: 0 }));
    await settle();
    assert.equal(home.st.count, 0);
  });

  it("既読化の送信中に別の画面へ移り、その後に既読化の応答が返っても反映する（次の画面切り替えの取得は反映）", async () => {
    const f = fakeFetch();
    const home = homeHarness(f, { student: true });
    home.handlePageChange("notifications");
    f.of(COUNT)[0].release(res(COUNT, { count: 1 }));
    await settle();
    const page = pageHarness(f, home.applyUnreadCount);
    page.mount(false);
    f.of(LIST)[0].release(res(LIST, [row("n1", false)]));
    await settle();
    home.handlePageChange("courses"); // 既読化の応答待ちのまま移動
    f.of(READ)[0].release(res(READ, { updated: 1, unreadCount: 0 }));
    await settle();
    assert.equal(home.st.count, 0);
    // 移動時に出した件数の要求は既読化より古いので捨てる
    f.of(COUNT)[1].release(res(COUNT, { count: 1 }));
    await settle();
    assert.equal(home.st.count, 0, "既読化より前に出した要求の古い件数で上書きした");
    // 次の画面切り替えの取得は反映する（講師が新しく回答した、など）
    home.handlePageChange("dashboard");
    f.of(COUNT)[2].release(res(COUNT, { count: 1 }));
    await settle();
    assert.equal(home.st.count, 1, "既読化の後の取得を反映しない");
  });
});

// ═══════════════════════════════════════════
// 個人情報：既読化に送るのは id だけ
// ═══════════════════════════════════════════
describe("個人情報：既読化には id だけを送り、ログに出さない", () => {
  it("既読化の本文は { ids } だけで、件名・本文・日時を含まない。URL にも id を載せない", async () => {
    const f = fakeFetch();
    const p = pageHarness(f, () => {});
    p.mount(false);
    const secretTitle = "ダミー件名　秘密";
    const secretMessage = "ダミー本文 dummy@example.com";
    f.of(LIST)[0].release(res(LIST, [{ id: "n1", title: secretTitle, message: secretMessage, read: false, createdAt: "2026-10-01T00:00:00.000Z" }]));
    await settle();
    const req = f.of(READ)[0];
    assert.ok(req, "既読化を送っていない");
    assert.equal(req.url, READ, "URL にクエリなどを付けた");
    const body = req.init?.body ?? "";
    assert.deepEqual(Object.keys(JSON.parse(body)), ["ids"], "ids 以外の項目を送った");
    assert.ok(!body.includes(secretTitle) && !body.includes(secretMessage) && !body.includes("2026-10-01"), "件名・本文・日時を送った");
    assert.deepEqual(Object.keys(req.init?.headers ?? {}), ["Content-Type"], "余計なヘッダーを送った");
  });

  it("件数の取得は本文なし・GET（authFetch に init を渡さない）", () => {
    const f = fakeFetch();
    homeHarness(f, { student: true }).loadUnreadCount();
    assert.equal(f.reqs[0].url, COUNT);
    assert.equal(f.reqs[0].init, undefined, "件数の取得に本文やメソッドを付けた");
  });

  it("#62 で足した処理に console 出力がない", () => {
    for (const [name, s] of [
      ["markShownAsRead", markSrc],
      ["loadUnreadCount / applyUnreadCount", countSrc],
      ["handlePageChange", pageChangeSrc],
    ] as Array<[string, string]>) {
      assert.doesNotMatch(s, /console\./, `${name} に console 出力がある`);
    }
  });

  it("onUnreadChange には数値（件数）だけを渡す", () => {
    assert.match(markSrc, /onUnreadChange\(count\)/);
    assert.equal((markSrc.match(/onUnreadChange\(/g) ?? []).length, 1, "onUnreadChange の呼び出しが 1 か所でない");
  });
});

// ═══════════════════════════════════════════
// 他の画面への影響
// ═══════════════════════════════════════════
describe("他の画面への影響", () => {
  it("既読化の API を呼ぶのは Notifications だけ、件数の API を呼ぶのは Home だけ", () => {
    // コメント中の記述は数えない（呼び出しの形だけ）
    const calls = (text: string, path: string) => text.split(`authFetch("${path}"`).length - 1;
    assert.equal(calls(src, READ), 1, "既読化の API の呼び出しが 1 か所でない");
    assert.equal(calls(notifications, READ), 1, "既読化の API を Notifications 以外で呼んでいる");
    assert.equal(calls(src, COUNT), 1, "件数の API の呼び出しが 1 か所でない");
    assert.equal(calls(root, COUNT), 1, "件数の API を Home 以外で呼んでいる");
    // fetch を直接使って（authFetch を通さずに）呼んでいない
    assert.doesNotMatch(src, /\bfetch\("\/api\/notifications/, "authFetch を通さずに通知の API を呼んでいる");
  });

  it("ダッシュボードのお知らせは既読化しない（StudentDashboard は toNewsItems だけを使う）", () => {
    const dash = component("StudentDashboard");
    assert.match(dash, /toNewsItems\(/, "ダッシュボードが toNewsItems を使っていない");
    for (const n of ["markShownAsRead", "unreadIdsToMark", "onUnreadChange", "applyUnreadCount", "loadUnreadCount", "/api/notifications/read"]) {
      assert.ok(!dash.includes(n), `ダッシュボードに ${n} がある`);
    }
  });

  it("Notifications の読み込み中・失敗・空の分岐と再読み込みボタンは残っている", () => {
    assert.match(notifications, /if \(loading\) \{/);
    assert.match(notifications, /\} else if \(loadFailed\) \{/);
    assert.match(notifications, /\} else if \(n\.length === 0\) \{/);
    assert.match(notifications, /通知を読み込めませんでした/);
    assert.match(notifications, /通知はありません/);
    assert.match(notifications, /onClick=\{loadNotifications\}/);
  });

  it("一覧の読み込みの effect は空依存のまま（既読化の effect とは別）", () => {
    assert.equal((notifications.match(/useEffect\(\(\) => \{ loadNotifications\(\); \}, \[\]\);/g) ?? []).length, 1);
    assert.equal((notifications.match(/useEffect\(/g) ?? []).length, 2, "Notifications の useEffect が 2 つでない");
  });

  it("件数の取得と既読化は、失効を classifyAuthFailure で判定し、失効なら JSON を読まない", () => {
    for (const s of [markSrc, countSrc]) {
      assert.match(s, /classifyAuthFailure\(\{ status: res\.status, redirected: res\.redirected, url: res\.url \}\) === "expired"\) \{?[^\n]*return null;/);
    }
  });
});

// ═══════════════════════════════════════════
// バッジ：境界値の追加・モバイル
// ═══════════════════════════════════════════
type El = { type: unknown; props: Record<string, unknown>; children: Node[] };
type Node = El | string | number;

function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
  const flat = (children.flat(Infinity) as unknown[]).filter(
    (c) => c !== null && c !== undefined && c !== false && c !== true && c !== ""
  ) as Node[];
  return { type, props: props ?? {}, children: flat };
}

const sidebarJs = ts.transpileModule(component("Sidebar"), {
  fileName: "Sidebar.jsx",
  compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: "h", jsxFragmentFactory: "Frag", module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, allowJs: true },
}).outputText;

const STUBS = ["Separator", "Avatar", "AvatarFallback", "User", "LogOut", "Home", "BookOpen", "Play", "HelpCircle", "Bell", "MessageSquare", "Settings", "BarChart3", "Users"];

function renderSidebar(props: Record<string, unknown>): El {
  const scope: Record<string, unknown> = {
    h,
    Frag: "Frag",
    T: new Proxy({}, { get: () => "#000000" }),
    displayName,
    avatarInitial,
    formatBadgeCount,
    unreadBadgeLabel,
    ...Object.fromEntries(STUBS.map((n) => [n, () => null])),
  };
  const names = Object.keys(scope);
  const Sidebar = new Function(...names, `${sidebarJs}\nreturn Sidebar;`)(...names.map((n) => scope[n])) as (p: Record<string, unknown>) => El;
  return Sidebar({ currentPage: "dashboard", setCurrentPage: () => {}, onLogout: () => {}, userName: "ダミー 受講生", ...props });
}

function walk(n: Node, out: El[] = []): El[] {
  if (typeof n === "string" || typeof n === "number") return out;
  out.push(n);
  for (const c of n.children) walk(c, out);
  return out;
}
function text(n: Node): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  return n.children.map(text).join("");
}
function badges(tree: El): El[] {
  return walk(tree).filter((e) => e.type === "span" && e.props["aria-label"] !== undefined && String(e.props["aria-label"]).startsWith("未読"));
}
function navBadgeSpans(tree: El): El[] {
  const nav = walk(tree).find((e) => e.type === "nav");
  assert.ok(nav, "nav が見つからない");
  return nav.children
    .filter((c): c is El => typeof c === "object" && c.type === "button")
    .map((b) => b.children.filter((c): c is El => typeof c === "object" && c.type === "span")[1])
    .filter((x): x is El => x !== undefined);
}

describe("Sidebar：バッジの境界値（追加）", () => {
  for (const v of [NaN, Infinity, -Infinity, -0, true, "9+", "", {}, [], [3]]) {
    it(`件数 ${typeof v === "object" ? JSON.stringify(v) : String(v)}（${typeof v}）：バッジを出さない`, () => {
      const tree = renderSidebar({ isAdmin: false, unreadCount: v });
      assert.deepEqual(navBadgeSpans(tree), [], "不正な件数でバッジを出した");
      assert.deepEqual(badges(tree), []);
    });
  }

  for (const [count, shown] of [
    [2, "2"],
    [8, "8"],
    [11, "9+"],
    [50, "9+"],
    [51, "9+"],
  ] as Array<[number, string]>) {
    it(`件数 ${count}：表示は「${shown}」、読み上げは実際の件数`, () => {
      const [b] = navBadgeSpans(renderSidebar({ isAdmin: false, unreadCount: count }));
      assert.ok(b, "バッジがない");
      assert.equal(text(b), shown);
      assert.equal(b.props.role, "img");
      assert.equal(b.props["aria-label"], `未読 ${count} 件`);
    });
  }

  it("講師：件数が渡ってきても（null 以外）バッジ・読み上げラベルを出さない", () => {
    for (const v of [1, 10, 0]) {
      const tree = renderSidebar({ isAdmin: true, unreadCount: v });
      assert.deepEqual(navBadgeSpans(tree), []);
      assert.deepEqual(badges(tree), [], "講師のサイドバーに未読の読み上げがある");
    }
  });

  it("バッジのない項目の span には role / aria-label を付けない", () => {
    const tree = renderSidebar({ isAdmin: false, unreadCount: 3 });
    const withRole = walk(tree).filter((e) => e.type === "span" && e.props.role === "img");
    assert.equal(withRole.length, 1, "role=img の span が通知のバッジ以外にもある");
  });
});

describe("モバイル：オーバーレイのサイドバーでもバッジが出る", () => {
  it("Sidebar の描画は 1 か所だけで、モバイルのオーバーレイ（.nwa-sidebar）の中にある", () => {
    const uses = src.match(/<Sidebar\b/g) ?? [];
    assert.equal(uses.length, 1, "Sidebar の描画が 1 か所でない");
    const wrap = between(root, '<div className={`nwa-sidebar ${mobileMenu ? "open" : ""}`}>', "</div>");
    assert.match(wrap, /<Sidebar [^>]*unreadCount=\{student \? unreadCount : null\}/, "オーバーレイの Sidebar に件数を渡していない");
  });

  it("モバイル用の CSS でバッジ（サイドバー内の span）を隠していない", () => {
    const styles = src.match(/\.nwa-sidebar[^{]*\{[^}]*\}/g) ?? [];
    assert.ok(styles.length > 0, ".nwa-sidebar の CSS が見つからない");
    for (const s of styles) {
      assert.doesNotMatch(s, /\.nwa-sidebar[^{]*\bspan\b/, `サイドバー内の span を対象にした CSS がある：${s}`);
    }
  });
});
