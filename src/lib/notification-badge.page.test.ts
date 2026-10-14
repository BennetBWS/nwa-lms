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

// #62 PR-2 未読バッジと既読化：page.tsx（// @ts-nocheck）を検査する。
// - ソース：import・props の受け渡し・受講生だけに限る条件・太字とドットを残すこと
// - 実行：Home の loadUnreadCount / applyUnreadCount と Notifications の markShownAsRead を
//   ソースから取り出し、偽の authFetch・ref・setState と本物の lib 関数で動かす
// - 描画：Sidebar を typescript で変換し、偽の h（要素の木）で描いてバッジの props を見る
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

const sidebar = component("Sidebar");
const notifications = component("Notifications");
const rootStart = src.indexOf("export default function NWALearningPlatform");
assert.ok(rootStart >= 0, "NWALearningPlatform が見つからない");
const root = src.slice(rootStart);

type FakeRes = { status: number; ok: boolean; redirected: boolean; url: string; json: () => Promise<unknown> };
const ORIGIN = "https://nwa-lms.example.com";
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
function res(body: unknown, p: Partial<FakeRes> = {}, path = "/api/notifications/unread-count"): FakeRes {
  return { status: 200, ok: true, redirected: false, url: `${ORIGIN}${path}`, json: () => Promise.resolve(body), ...p };
}
type Req = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string }; release: (r: FakeRes) => void; fail: (e: unknown) => void };

// ═══════════════════════════════════════════
// ソース
// ═══════════════════════════════════════════
describe("page.tsx：import と受け渡し（#62）", () => {
  it("notification-read の関数を import している", () => {
    const m = src.match(/import \{([^}]*)\} from "@\/lib\/notification-read";/);
    assert.ok(m, "notification-read の import がない");
    const names = m[1].split(",").map((s) => s.trim());
    for (const n of ["formatBadgeCount", "readMarkReadResponse", "readUnreadCountResponse", "toUnreadCount", "unreadBadgeLabel", "unreadIdsToMark"]) {
      assert.ok(names.includes(n), `${n} が import されていない`);
    }
  });

  it("Sidebar は unreadCount を受け取り、受講生のときだけ件数を渡す", () => {
    assert.match(sidebar, /^const Sidebar = \(\{[^}]*\bunreadCount\b[^}]*\}\) =>/);
    assert.match(root, /<Sidebar [^>]*\bunreadCount=\{student \? unreadCount : null\}[^>]*\/>/);
  });

  it("student は authenticated かつ STUDENT（講師は含まない）", () => {
    assert.match(root, /const student = sessionView\.kind === "authenticated" && sessionView\.role === "STUDENT";/);
  });

  it("Notifications に onUnreadChange={applyUnreadCount} を渡す", () => {
    assert.match(root, /"notifications": <Notifications onUnreadChange=\{applyUnreadCount\} \/>/);
    assert.match(notifications, /^const Notifications = \(\{ onUnreadChange \}\) =>/);
  });

  it("件数の state は null で始まり、古い応答を捨てる番号は useRef(0)", () => {
    assert.match(root, /const \[unreadCount, setUnreadCount\] = useState\(null\);/);
    assert.match(root, /const unreadSeq = useRef\(0\);/);
  });

  it("件数の取得はログイン後（student が真になったとき）と画面の切り替えのたび。どちらも受講生だけ", () => {
    assert.match(root, /useEffect\(\(\) => \{\s*if \(student\) loadUnreadCount\(\);\s*\}, \[student\]\);/);
    const change = between(root, "const handlePageChange = (p, data) => {", "\n  };");
    assert.match(change, /if \(student\) loadUnreadCount\(\);/);
    // loadUnreadCount を呼ぶのはこの 2 か所だけ（ポーリング・フォーカスでは呼ばない）
    const calls = root.match(/loadUnreadCount\(\)/g) ?? [];
    assert.equal(calls.length, 2, "loadUnreadCount の呼び出しが 2 か所でない");
    assert.doesNotMatch(root, /setInterval|visibilitychange/);
  });

  it("hooks（件数の state・ref・useEffect）は認証確認の早期 return より前", () => {
    const guard = root.indexOf('if (sessionView.kind !== "authenticated")');
    assert.ok(guard >= 0, "早期 return が見つからない");
    for (const s of ["const [unreadCount, setUnreadCount] = useState(null);", "const unreadSeq = useRef(0);", "if (student) loadUnreadCount();\n  }, [student]);"]) {
      const i = root.indexOf(s);
      assert.ok(i >= 0 && i < guard, `${s} が早期 return より前にない`);
    }
  });
});

describe("Notifications：既読化の配線（ソース）", () => {
  it("既読化は notifs が変わったとき（読み込みに成功したとき）に呼ぶ", () => {
    assert.match(notifications, /useEffect\(\(\) => \{ if \(notifs\) markShownAsRead\(notifs\); \}, \[notifs\]\);/);
  });

  it("表示する行（toNewsItems）から unreadIdsToMark で id を集め、POST /api/notifications/read に ids を送る", () => {
    const mark = between(notifications, "const markShownAsRead", "useEffect(() => { if (notifs)");
    assert.match(mark, /unreadIdsToMark\(toNewsItems\(rows, new Date\(\)\)\)/);
    assert.match(mark, /authFetch\("\/api\/notifications\/read", \{ method: "POST", headers: \{ "Content-Type": "application\/json" \}, body: JSON\.stringify\(\{ ids \}\) \}\)/);
  });

  it("太字とドットはページを離れるまで残す：既読化の後で notifs を書き換えない", () => {
    const setNotifsCalls = notifications.match(/setNotifs\(/g) ?? [];
    assert.equal(setNotifsCalls.length, 1, "setNotifs の呼び出しが読み込み以外にある");
    const mark = between(notifications, "const markShownAsRead", "useEffect(() => { if (notifs)");
    assert.doesNotMatch(mark, /setNotifs|setLoadFailed|setLoading/);
  });

  it("既読化に失敗しても表示しない（role=alert は読み込み失敗の 1 か所だけ）", () => {
    assert.equal((notifications.match(/role="alert"/g) ?? []).length, 1);
  });
});

// ═══════════════════════════════════════════
// 実行：Notifications の markShownAsRead
// ═══════════════════════════════════════════
const markSrc = between(notifications, "const markShownAsRead", "useEffect(() => { if (notifs)");

function markHarness(opts: { withCallback?: boolean } = {}) {
  const reqs: Req[] = [];
  const changes: number[] = [];
  const st = { inFlight: false, jsonReads: 0 };
  const ref = {
    get current() {
      return st.inFlight;
    },
    set current(v: boolean) {
      st.inFlight = v;
    },
  };
  const authFetch = (url: string, init?: Req["init"]) =>
    new Promise<FakeRes>((release, fail) => reqs.push({ url, init, release, fail })).then((r) => ({
      ...r,
      json: () => {
        st.jsonReads++;
        return r.json();
      },
    }));
  const make = new Function(
    "authFetch",
    "classifyAuthFailure",
    "toNewsItems",
    "unreadIdsToMark",
    "readMarkReadResponse",
    "markReadInFlight",
    "onUnreadChange",
    `${markSrc}\nreturn markShownAsRead;`
  );
  const mark = make(
    authFetch,
    classifyAuthFailure,
    toNewsItems,
    unreadIdsToMark,
    readMarkReadResponse,
    ref,
    opts.withCallback === false ? undefined : (n: number) => changes.push(n)
  ) as (rows: unknown) => void;
  return { mark, reqs, changes, st };
}

const row = (id: string, read: boolean) => ({ id, title: `ダミー ${id}`, message: "本文", read, createdAt: "2026-10-01T00:00:00.000Z" });
const READ_PATH = "/api/notifications/read";

describe("Notifications：markShownAsRead（実行）", () => {
  it("成功：未読の id だけを送り、応答の unreadCount で onUnreadChange を呼ぶ・フラグが戻る", async () => {
    const { mark, reqs, changes, st } = markHarness();
    mark([row("n1", false), row("n2", true), row("n3", false)]);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].url, READ_PATH);
    assert.equal(reqs[0].init?.method, "POST");
    assert.equal(reqs[0].init?.headers?.["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(reqs[0].init?.body ?? "null"), { ids: ["n1", "n3"] });
    assert.equal(st.inFlight, true);
    reqs[0].release(res({ updated: 2, unreadCount: 0 }, {}, READ_PATH));
    await settle();
    assert.deepEqual(changes, [0]);
    assert.equal(st.inFlight, false);
  });

  it("未読がない・空・null なら API を呼ばない", async () => {
    const { mark, reqs, changes } = markHarness();
    mark([row("n1", true)]);
    mark([]);
    mark(null);
    await settle();
    assert.equal(reqs.length, 0);
    assert.deepEqual(changes, []);
  });

  it("表示しない行（id が空・重複・title がない）は送らない", () => {
    const { mark, reqs } = markHarness();
    mark([row("", false), row("a", false), { ...row("a", false), title: "重複" }, { id: "b", read: false }]);
    assert.deepEqual(JSON.parse(reqs[0].init?.body ?? "null"), { ids: ["a"] });
  });

  it(`未読が ${MARK_READ_MAX_IDS} 件を超えても送るのは先頭 ${MARK_READ_MAX_IDS} 件`, () => {
    const { mark, reqs } = markHarness();
    mark(Array.from({ length: MARK_READ_MAX_IDS + 3 }, (_, i) => row(`n${i}`, false)));
    const ids = JSON.parse(reqs[0].init?.body ?? "null").ids as string[];
    assert.equal(ids.length, MARK_READ_MAX_IDS);
    assert.equal(ids[0], "n0");
  });

  it("送信中の二重呼び出し（StrictMode の 2 回目など）では 1 回しか送らない", async () => {
    const { mark, reqs, changes } = markHarness();
    mark([row("n1", false)]);
    mark([row("n1", false)]);
    assert.equal(reqs.length, 1);
    reqs[0].release(res({ updated: 1, unreadCount: 4 }, {}, READ_PATH));
    await settle();
    assert.deepEqual(changes, [4]);
  });

  for (const [label, r] of [
    ["500", { status: 500, ok: false }],
    ["400", { status: 400, ok: false }],
    ["403", { status: 403, ok: false }],
    ["/ へのリダイレクト", { redirected: true, url: `${ORIGIN}/` }],
  ] as Array<[string, Partial<FakeRes>]>) {
    it(`失敗（${label}）：JSON を読まず onUnreadChange を呼ばない・フラグが戻り、次は再試行する`, async () => {
      const { mark, reqs, changes, st } = markHarness();
      mark([row("n1", false)]);
      reqs[0].release(res({ updated: 1, unreadCount: 0 }, r, READ_PATH));
      await settle();
      assert.equal(st.jsonReads, 0);
      assert.deepEqual(changes, []);
      assert.equal(st.inFlight, false);
      mark([row("n1", false)]);
      assert.equal(reqs.length, 2, "失敗のあとに再試行しない");
    });
  }

  for (const [label, body] of [
    ["unreadCount がない", { updated: 1 }],
    ["unreadCount が文字列", { updated: 1, unreadCount: "0" }],
    ["配列", []],
    ["null", null],
  ] as Array<[string, unknown]>) {
    it(`200 でも形が違う応答（${label}）は onUnreadChange を呼ばない`, async () => {
      const { mark, reqs, changes, st } = markHarness();
      mark([row("n1", false)]);
      reqs[0].release(res(body, {}, READ_PATH));
      await settle();
      assert.deepEqual(changes, []);
      assert.equal(st.inFlight, false);
    });
  }

  it("ネットワークの例外・JSON の解析失敗は何もしない（フラグが戻る）", async () => {
    const { mark, reqs, changes, st } = markHarness();
    mark([row("n1", false)]);
    reqs[0].fail(new TypeError("Failed to fetch"));
    await settle();
    assert.equal(st.inFlight, false);
    mark([row("n1", false)]);
    reqs[1].release(res(null, { json: () => Promise.reject(new SyntaxError("bad json")) }, READ_PATH));
    await settle();
    assert.deepEqual(changes, []);
    assert.equal(st.inFlight, false);
  });

  for (const [label, r] of [
    ["401", { status: 401, ok: false }],
    ["/login へのリダイレクト", { redirected: true, url: `${ORIGIN}/login?callbackUrl=%2F` }],
  ] as Array<[string, Partial<FakeRes>]>) {
    it(`失効（${label}）：JSON を読まず、フラグを戻さない（もう送らない）`, async () => {
      const { mark, reqs, changes, st } = markHarness();
      mark([row("n1", false)]);
      reqs[0].release(res({ updated: 1, unreadCount: 0 }, r, READ_PATH));
      await settle();
      assert.equal(st.jsonReads, 0);
      assert.deepEqual(changes, []);
      assert.equal(st.inFlight, true);
      mark([row("n1", false)]);
      assert.equal(reqs.length, 1);
    });
  }

  it("onUnreadChange が渡されていなくても例外にならない", async () => {
    const { mark, reqs, st } = markHarness({ withCallback: false });
    mark([row("n1", false)]);
    reqs[0].release(res({ updated: 1, unreadCount: 0 }, {}, READ_PATH));
    await settle();
    assert.equal(st.inFlight, false);
  });
});

// ═══════════════════════════════════════════
// 実行：Home の loadUnreadCount / applyUnreadCount
// ═══════════════════════════════════════════
const countSrc = between(root, "const loadUnreadCount", "// #62 After sign-in");

function countHarness() {
  const reqs: Req[] = [];
  const st = { count: null as number | null, sets: 0, jsonReads: 0 };
  const seq = { current: 0 };
  const authFetch = (url: string) =>
    new Promise<FakeRes>((release, fail) => reqs.push({ url, release, fail })).then((r) => ({
      ...r,
      json: () => {
        st.jsonReads++;
        return r.json();
      },
    }));
  const make = new Function(
    "authFetch",
    "classifyAuthFailure",
    "readUnreadCountResponse",
    "toUnreadCount",
    "unreadSeq",
    "setUnreadCount",
    `${countSrc}\nreturn { loadUnreadCount, applyUnreadCount };`
  );
  const fns = make(authFetch, classifyAuthFailure, readUnreadCountResponse, toUnreadCount, seq, (v: number) => {
    st.sets++;
    st.count = v;
  }) as { loadUnreadCount: () => void; applyUnreadCount: (v: unknown) => void };
  return { ...fns, reqs, st };
}

describe("Home：loadUnreadCount / applyUnreadCount（実行）", () => {
  it("成功：GET /api/notifications/unread-count の count を設定する（0 も設定する）", async () => {
    const { loadUnreadCount, reqs, st } = countHarness();
    loadUnreadCount();
    assert.equal(reqs[0].url, "/api/notifications/unread-count");
    reqs[0].release(res({ count: 12 }));
    await settle();
    assert.equal(st.count, 12);
    loadUnreadCount();
    reqs[1].release(res({ count: 0 }));
    await settle();
    assert.equal(st.count, 0);
  });

  for (const [label, r, body] of [
    ["500", { status: 500, ok: false }, { error: "Internal server error" }],
    ["403", { status: 403, ok: false }, {}],
    ["/ へのリダイレクト", { redirected: true, url: `${ORIGIN}/` }, { count: 1 }],
    ["401（失効は authFetch 任せ）", { status: 401, ok: false }, { count: 1 }],
    ["/login へのリダイレクト", { redirected: true, url: `${ORIGIN}/login` }, { count: 1 }],
    ["形が違う（count が文字列）", {}, { count: "3" }],
    ["形が違う（配列）", {}, [3]],
  ] as Array<[string, Partial<FakeRes>, unknown]>) {
    it(`失敗（${label}）：前の値のまま・エラーにしない`, async () => {
      const { loadUnreadCount, reqs, st } = countHarness();
      loadUnreadCount();
      reqs[0].release(res({ count: 2 }));
      await settle();
      assert.equal(st.count, 2);
      loadUnreadCount();
      reqs[1].release(res(body, r));
      await settle();
      assert.equal(st.count, 2, "失敗で値が変わった");
      assert.equal(st.sets, 1);
    });
  }

  it("初回の失敗では設定しない（バッジは出ないまま）", async () => {
    const { loadUnreadCount, reqs, st } = countHarness();
    loadUnreadCount();
    reqs[0].fail(new TypeError("Failed to fetch"));
    await settle();
    assert.equal(st.count, null);
    assert.equal(st.sets, 0);
  });

  it("古い応答は捨てる：先に出した要求が後から返っても、新しい値を上書きしない", async () => {
    const { loadUnreadCount, reqs, st } = countHarness();
    loadUnreadCount();
    loadUnreadCount();
    reqs[1].release(res({ count: 1 }));
    await settle();
    reqs[0].release(res({ count: 5 }));
    await settle();
    assert.equal(st.count, 1);
    assert.equal(st.sets, 1);
  });

  it("applyUnreadCount：既読化の応答の件数をすぐ設定し、送信中の件数の要求を古いものにする", async () => {
    const { loadUnreadCount, applyUnreadCount, reqs, st } = countHarness();
    loadUnreadCount();
    applyUnreadCount(0);
    assert.equal(st.count, 0);
    reqs[0].release(res({ count: 3 }));
    await settle();
    assert.equal(st.count, 0, "既読化より古い件数で上書きした");
    // その後の要求は反映する
    loadUnreadCount();
    reqs[1].release(res({ count: 1 }));
    await settle();
    assert.equal(st.count, 1);
  });

  it("applyUnreadCount：不正な値は無視する（送信中の要求も古いものにしない）", async () => {
    const { loadUnreadCount, applyUnreadCount, reqs, st } = countHarness();
    loadUnreadCount();
    for (const v of [-1, 1.5, NaN, "0", null, undefined]) applyUnreadCount(v);
    assert.equal(st.sets, 0);
    reqs[0].release(res({ count: 4 }));
    await settle();
    assert.equal(st.count, 4);
  });
});

// ═══════════════════════════════════════════
// 描画：Sidebar のバッジ
// ═══════════════════════════════════════════
type El = { type: unknown; props: Record<string, unknown>; children: Node[] };
type Node = El | string | number;

function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
  const flat = (children.flat(Infinity) as unknown[]).filter(
    (c) => c !== null && c !== undefined && c !== false && c !== true && c !== ""
  ) as Node[];
  return { type, props: props ?? {}, children: flat };
}

const sidebarJs = ts.transpileModule(sidebar, {
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

/** nav のボタンごとに [ラベル, バッジの span（なければ undefined）] */
function navButtons(tree: El): Array<{ label: string; badge: El | undefined }> {
  const nav = walk(tree).find((e) => e.type === "nav");
  assert.ok(nav, "nav が見つからない");
  return nav.children.filter((c): c is El => typeof c === "object" && c.type === "button").map((b) => {
    const spans = b.children.filter((c): c is El => typeof c === "object" && c.type === "span");
    return { label: text(spans[0]), badge: spans[1] };
  });
}

describe("Sidebar：未読バッジ（描画）", () => {
  for (const [count, shown, label] of [
    [1, "1", "未読 1 件"],
    [9, "9", "未読 9 件"],
    [10, "9+", "未読 10 件"],
    [123, "9+", "未読 123 件"],
  ] as Array<[number, string, string]>) {
    it(`受講生・${count} 件：通知の行に「${shown}」、aria-label は「${label}」`, () => {
      const rows = navButtons(renderSidebar({ isAdmin: false, unreadCount: count }));
      const notif = rows.find((r) => r.label === "通知");
      assert.ok(notif, "通知の行がない");
      assert.ok(notif.badge, "バッジがない");
      assert.equal(text(notif.badge), shown);
      assert.equal(notif.badge.props.role, "img");
      assert.equal(notif.badge.props["aria-label"], label);
      // 他の行にはバッジがない
      assert.deepEqual(rows.filter((r) => r.badge).map((r) => r.label), ["通知"]);
    });
  }

  for (const v of [0, null, undefined, -1, 1.5, "3"]) {
    it(`受講生・件数 ${String(v)}：バッジを出さない`, () => {
      const rows = navButtons(renderSidebar({ isAdmin: false, unreadCount: v }));
      assert.ok(rows.some((r) => r.label === "通知"), "通知の行がない");
      assert.deepEqual(rows.filter((r) => r.badge), []);
    });
  }

  it("講師：件数があってもバッジを出さない（通知の項目もない）", () => {
    const rows = navButtons(renderSidebar({ isAdmin: true, unreadCount: 5 }));
    assert.ok(!rows.some((r) => r.label === "通知"), "講師のサイドバーに通知がある");
    assert.deepEqual(rows.filter((r) => r.badge), []);
  });
});
