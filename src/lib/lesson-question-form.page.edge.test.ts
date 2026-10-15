import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { classifyAuthFailure } from "./client-session";
import * as commentForm from "./comment-form";
import { commentLength, parseCommentContent } from "./lesson-comments";

// #46 B-2 レッスンの質問の投稿欄の補強（lesson-question-form.page.test.ts の続き）。
// 1. 描画した入力欄の判定・文字数表示・aria-invalid がサーバーの parseCommentContent と一致すること（見えない文字・絵文字・結合文字・境界）
// 2. 応答の組み合わせ（知らない reason・JSON でない本文・retryAfterSeconds の不正値と境界）と、送る内容（本文以外を送らない・ログに出さない）
// 3. 本物の loadComments と reloadCommentsAfterPost を一緒に動かし、投稿前に始まった読み込みの応答を捨てること・レッスン切り替えを確かめる
// 4. 受講生だけに出す式（student・canAskQuestion）を実際に評価する
// DOM・DB・ネットワークなし。データはすべてダミー。見えない文字は \u エスケープで書く。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* = |\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const formSrc = component("LessonQuestionForm");
const lessonView = component("LessonView");

const JSX_OPTIONS: ts.TranspileOptions = {
  reportDiagnostics: true,
  compilerOptions: {
    jsx: ts.JsxEmit.React,
    jsxFactory: "h",
    jsxFragmentFactory: "Frag",
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
  },
};
const transpiled = ts.transpileModule(formSrc, { ...JSX_OPTIONS, fileName: "LessonQuestionForm.jsx" });
assert.deepEqual(transpiled.diagnostics ?? [], [], "LessonQuestionForm の変換で診断が出た");
const compiled = transpiled.outputText;

// ───────────── 偽の React（lesson-question-form.page.test.ts と同じ器） ─────────────

type El = { type: unknown; props: Record<string, unknown>; children: Node[] };
type Node = El | string | number;

const Button = (() => null) as unknown;
function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
  const flat = (children.flat(Infinity) as unknown[]).filter(
    (c) => c !== null && c !== undefined && c !== false && c !== true && c !== ""
  ) as Node[];
  return { type, props: props ?? {}, children: flat };
}

type FakeRes = { status: number; ok: boolean; redirected: boolean; url: string; json: () => Promise<unknown>; headers?: unknown };
const ORIGIN = "https://nwa-lms.example.com";
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
function res(status: number, body: unknown, p: Partial<FakeRes> = {}): FakeRes {
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected: false,
    url: `${ORIGIN}/api/comments`,
    json: () => (body === undefined ? Promise.reject(new SyntaxError("not json")) : Promise.resolve(body)),
    ...p,
  };
}

type Req = { url: string; init?: RequestInit; release: (r: FakeRes) => void; fail: (e: unknown) => void };

function mount(lessonId = "l1") {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  let si = 0;
  let ri = 0;
  const reqs: Req[] = [];
  const reloads: string[] = [];
  const logs: unknown[][] = [];
  const useState = (init: unknown) => {
    const i = si++;
    if (!(i in states)) states[i] = init;
    return [states[i], (v: unknown) => (states[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(states[i]) : v)];
  };
  const useRef = (init: unknown) => {
    const i = ri++;
    if (!(i in refs)) refs[i] = { current: init };
    return refs[i];
  };
  const authFetch = (url: string, init?: RequestInit) => new Promise<FakeRes>((release, fail) => reqs.push({ url, init, release, fail }));
  // ログに出していないことを確かめるため、console を偽物に差し替えて渡す
  const fakeConsole = new Proxy({}, { get: () => (...args: unknown[]) => logs.push(args) });
  const scope: Record<string, unknown> = {
    h,
    Frag: "Frag",
    useState,
    useRef,
    useEffect: () => {
      throw new Error("useEffect は使わない想定");
    },
    authFetch,
    classifyAuthFailure,
    ...commentForm,
    T: new Proxy({}, { get: () => "#000000" }),
    glassStyle: () => ({}),
    Button,
    console: fakeConsole,
  };
  const names = Object.keys(scope);
  const Form = new Function(...names, `${compiled}\nreturn LessonQuestionForm;`)(...names.map((n) => scope[n])) as (p: {
    lessonId: string;
    onReload: (id: string) => void;
  }) => El;
  const render = (): El => {
    si = 0;
    ri = 0;
    return Form({ lessonId, onReload: (id) => reloads.push(id) });
  };
  return { render, reqs, reloads, logs };
}

function text(n: Node | undefined): string {
  if (n === undefined) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  return n.children.map(text).join("");
}
function findAll(n: Node, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (typeof n === "object") {
    if (pred(n)) out.push(n);
    for (const c of n.children) findAll(c, pred, out);
  }
  return out;
}
const textarea = (t: El) => {
  const hit = findAll(t, (e) => e.type === "textarea");
  assert.equal(hit.length, 1, "入力欄が 1 つでない");
  return hit[0];
};
const sendButton = (t: El) => {
  const hit = findAll(t, (e) => e.type === Button);
  assert.equal(hit.length, 1, "ボタンが 1 つでない");
  return hit[0];
};
const click = (b: El) => (b.props.onClick as (e?: unknown) => void)({ preventDefault() {} });
const change = (el: El, value: string) => (el.props.onChange as (e: unknown) => void)({ target: { value } });
const alerts = (t: El) => findAll(t, (e) => e.props.role === "alert").map(text);
const statuses = (t: El) => findAll(t, (e) => e.props.role === "status").map(text);
const counter = (t: El) => {
  const id = textarea(t).props["aria-describedby"];
  const hit = findAll(t, (e) => e.props.id === id);
  assert.equal(hit.length, 1, "文字数の表示が 1 つでない");
  return text(hit[0]);
};

async function respond(r: FakeRes | Error, value = "ダミーの質問です") {
  const m = mount();
  change(textarea(m.render()), value);
  click(sendButton(m.render()));
  assert.equal(m.reqs.length, 1, "送信が 1 本でない");
  if (r instanceof Error) m.reqs[0].fail(r);
  else m.reqs[0].release(r);
  await settle();
  return { m, tree: m.render() };
}

// ───────────── 1. 入力の判定がサーバーと一致する ─────────────

describe("LessonQuestionForm 入力：描画した判定・文字数・aria-invalid がサーバーの parseCommentContent と一致", () => {
  const corpus: Array<[string, string]> = [
    ["空", ""],
    ["半角空白", "   "],
    ["タブと改行", "\t\n\r\n"],
    ["全角空白", "\u3000\u3000"],
    ["ゼロ幅空白", "\u200B"],
    ["ゼロ幅空白＋全角空白", "\u200B\u3000"],
    ["BOM", "\uFEFF"],
    ["ノーブレークスペース", "\u00A0"],
    ["WORD JOINER", "\u2060"],
    ["ゼロ幅接合子だけ", "\u200D\u200C"],
    ["結合文字だけ", "\u0301"],
    ["双方向制御文字だけ", "\u202E\u202C"],
    ["1 文字", "あ"],
    ["前後に空白", "  質問  \n"],
    ["見えない文字に挟まれた 1 文字", "\u200Ba\u200B"],
    ["2000 字", "あ".repeat(2000)],
    ["2001 字", "あ".repeat(2001)],
    ["2000 字＋前後の空白（trim 後 2000）", `  \n${"あ".repeat(2000)}\n\t `],
    ["2000 字＋前後の全角空白（trim 後 2000）", `\u3000${"あ".repeat(2000)}\u3000`],
    ["1999 字＋ゼロ幅空白（2000）", `${"あ".repeat(1999)}\u200B`],
    ["2000 字＋ゼロ幅空白（2001）", `${"あ".repeat(2000)}\u200B`],
    ["絵文字 2000（サロゲートペア）", "\u{1F600}".repeat(2000)],
    ["絵文字 2001", "\u{1F600}".repeat(2001)],
    ["結合文字（e + U+0301）× 1000", "e\u0301".repeat(1000)],
    ["結合文字（e + U+0301）× 1000 + 1", `${"e\u0301".repeat(1000)}a`],
    ["ZWJ の家族絵文字", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"],
    ["国旗（地域指示記号）× 1000", "\u{1F1EF}\u{1F1F5}".repeat(1000)],
    ["国旗（地域指示記号）× 1000 + 1", `${"\u{1F1EF}\u{1F1F5}".repeat(1000)}a`],
    ["改行だけを挟む", "a\n\n\nb"],
  ];

  for (const [label, v] of corpus) {
    it(label, () => {
      const m = mount();
      change(textarea(m.render()), v);
      const tree = m.render();
      const server = parseCommentContent(v);
      // tsconfig が strict でないため ok での絞り込みが効かない。in で reason を取り出す
      const reason = "reason" in server ? server.reason : null;
      const length = commentLength(v.trim());
      assert.equal(sendButton(tree).props.disabled, !server.ok, `送れる判定がサーバーと違う（server: ${JSON.stringify(reason ?? "ok")}）`);
      const shown = counter(tree);
      assert.ok(shown.startsWith(`${length} / 2000`), `文字数の表示がサーバーの数え方と違う：${shown}（期待 ${length}）`);
      const tooLong = reason === "too_long";
      assert.equal(textarea(tree).props["aria-invalid"], tooLong ? true : undefined, "aria-invalid が上限超えのときだけでない");
      assert.equal(shown.includes("オーバー"), tooLong, "超過の表示が上限超えのときだけでない");
      if (tooLong) assert.ok(shown.endsWith(`（${length - 2000} 文字オーバー）`), `超過数が違う：${shown}`);
      // 送れない値は onClick を呼んでも送らない。送れる値は 1 本だけ送り、そのままの本文を送る（trim はサーバー）
      click(sendButton(tree));
      assert.equal(m.reqs.length, server.ok ? 1 : 0, "送信の本数が判定と違う");
      if (server.ok) assert.equal(JSON.parse(String(m.reqs[0].init?.body)).content, v, "本文を加工して送った");
    });
  }
});

// ───────────── 2. 送る内容・ログ ─────────────

describe("LessonQuestionForm 送信：本文以外を送らない・ログに出さない", () => {
  it("リクエストは method・headers・body だけで、headers は Content-Type だけ、body は lessonId と content だけ", () => {
    const m = mount("lesson-abc");
    change(textarea(m.render()), "ダミーの質問です");
    click(sendButton(m.render()));
    const init = m.reqs[0].init as Record<string, unknown>;
    assert.deepEqual(Object.keys(init).sort(), ["body", "headers", "method"]);
    assert.deepEqual(init.headers, { "Content-Type": "application/json" });
    assert.deepEqual(Object.keys(JSON.parse(String(init.body))).sort(), ["content", "lessonId"]);
    assert.equal(JSON.parse(String(init.body)).lessonId, "lesson-abc", "props の lessonId を送っていない");
    assert.equal(m.reqs[0].url, "/api/comments", "URL にクエリなどを足している");
  });

  it("ソースでセッション・ユーザーの情報（名前・メール・ロール・userId）を参照しない（role=\"alert\" などの属性は除く）", () => {
    assert.doesNotMatch(formSrc, /sessionView|userName|\bemail\b|\buserId\b|\brole\b(?!=")|localStorage|sessionStorage|document\.cookie/);
  });

  it("どの応答でも console に何も出さない（本文・応答をログに出さない）", async () => {
    const cases: Array<FakeRes | Error> = [
      res(201, { id: "c1" }),
      res(400, { reason: "too_long" }),
      res(401, { error: "Unauthorized" }),
      res(403, { reason: "forbidden_role" }),
      res(409, { reason: "duplicate" }),
      res(429, { reason: "rate_limited", retryAfterSeconds: 30 }),
      res(500, undefined),
      res(502, undefined),
      new TypeError("Failed to fetch"),
    ];
    for (const r of cases) {
      const { m } = await respond(r, "個人情報を含むかもしれないダミーの本文 dummy@example.com");
      assert.deepEqual(m.logs, [], `ログに出した：${r instanceof Error ? r.message : r.status}`);
    }
    assert.doesNotMatch(formSrc, /console\./, "console を使っている");
  });
});

// ───────────── 3. 応答の組み合わせ ─────────────

describe("LessonQuestionForm 応答：知らない reason・JSON でない本文", () => {
  const RATE = commentForm.QUESTION_RATE_LIMITED_MESSAGE;
  const SERVER = commentForm.COMMENT_SERVER_ERROR_MESSAGE;
  const cases: Array<[string, FakeRes, string | RegExp, boolean]> = [
    ["403 の知らない reason", res(403, { reason: "something_new" }), "この操作を行う権限がありません。", false],
    ["403 の本文が JSON でない", res(403, undefined), "この操作を行う権限がありません。", false],
    ["403 の本文が配列", res(403, ["course_locked"]), "この操作を行う権限がありません。", false],
    ["400 invalid_lesson_id", res(400, { reason: "invalid_lesson_id" }), /再読み込み/, false],
    ["400 reason なし（Invalid JSON）", res(400, { error: "Invalid JSON" }), /送信内容を読み取れませんでした/, false],
    ["400 empty", res(400, { reason: "empty" }), "本文を入力してください。", false],
    ["409 の知らない reason（読み直さない）", res(409, { reason: "conflict" }), SERVER, false],
    ["409 の本文が JSON でない（読み直さない）", res(409, undefined), SERVER, false],
    ["429 の本文が JSON でない（目安なし）", res(429, undefined), RATE, false],
    ["429 の reason なし（目安あり）", res(429, { retryAfterSeconds: 5 }), `${RATE}（目安：約 5 秒後）`, false],
    ["429 の Retry-After ヘッダーだけ（本文の目安なし）", res(429, { reason: "rate_limited" }, { headers: { "Retry-After": "30" } }), RATE, false],
    ["200（201 以外の 2xx）は成功", res(200, null), "", true],
    ["204 は成功", res(204, undefined), "", true],
  ];
  for (const [label, r, expected, reload] of cases) {
    it(label, async () => {
      const { m, tree } = await respond(r);
      const a = alerts(tree);
      if (expected === "") {
        assert.deepEqual(a, [], "成功なのにエラーが出た");
        assert.deepEqual(statuses(tree), [commentForm.QUESTION_POSTED_MESSAGE]);
        assert.equal(textarea(tree).props.value, "", "成功なのに入力が残る");
      } else {
        assert.equal(a.length, 1, `エラーが 1 つでない：${a.join(" / ")}`);
        if (typeof expected === "string") assert.equal(a[0], expected);
        else assert.match(a[0], expected);
        assert.equal(textarea(tree).props.value, "ダミーの質問です", "失敗なのに入力が消えた");
      }
      assert.deepEqual(m.reloads, reload ? ["l1"] : [], "読み直しの有無が想定と違う");
    });
  }

  it("失敗の応答の本文の読み取りが終わらない間は送信中のまま（もう一本送らない）", async () => {
    const m = mount();
    change(textarea(m.render()), "ダミーの質問です");
    click(sendButton(m.render()));
    m.reqs[0].release(res(500, null, { json: () => new Promise(() => {}) }));
    await settle();
    const tree = m.render();
    assert.equal(sendButton(tree).props.disabled, true, "本文の読み取り中に押せる");
    click(sendButton(tree));
    assert.equal(m.reqs.length, 1, "本文の読み取り中に再送した");
  });
});

describe("LessonQuestionForm 応答：429 の目安（retryAfterSeconds）", () => {
  const RATE = commentForm.QUESTION_RATE_LIMITED_MESSAGE;
  const cases: Array<[unknown, string]> = [
    [0, ""],
    [-1, ""],
    [null, ""],
    ["30", ""],
    [true, ""],
    [{}, ""],
    [0.2, "（目安：約 1 秒後）"],
    [30, "（目安：約 30 秒後）"], // サーバーの間隔の上限
    [59, "（目安：約 59 秒後）"],
    [59.5, "（目安：約 1 分後）"],
    [60, "（目安：約 1 分後）"],
    [61, "（目安：約 2 分後）"],
    [3540, "（目安：約 59 分後）"],
    [3541, "（目安：約 60 分後）"],
    [3600, "（目安：約 1 時間後）"],
    [3601, "（目安：約 2 時間後）"],
    [86400, "（目安：約 24 時間後）"], // サーバーの 1 日の上限（toRetrySeconds で 86400 秒に収める）
  ];
  for (const [v, hint] of cases) {
    it(`retryAfterSeconds=${JSON.stringify(v)} → ${hint || "目安なし"}`, async () => {
      const { m, tree } = await respond(res(429, { reason: "rate_limited", retryAfterSeconds: v }));
      assert.deepEqual(alerts(tree), [RATE + hint]);
      assert.deepEqual(m.reloads, [], "429 で読み直した");
      assert.equal(textarea(tree).props.value, "ダミーの質問です", "429 で入力が消えた");
      // 待ち時間を言い切らない（「○秒後にもう一度」のように断定しない）
      assert.doesNotMatch(alerts(tree)[0], /\d+ ?(秒|分|時間)後に/);
    });
  }

  it("24 時間（86400 秒）を超える値は目安を出さない（サーバーは 86400 秒までしか返さない。表示が崩れないように）", async () => {
    for (const v of [86400.5, 1e9, Number.MAX_SAFE_INTEGER, 1e308]) {
      const { tree } = await respond(res(429, { reason: "rate_limited", retryAfterSeconds: v }));
      const a = alerts(tree);
      assert.equal(a.length, 1, `エラーが 1 つでない：${v}`);
      assert.ok(a[0].startsWith(RATE), `429 の文言でない：${a[0]}`);
      assert.doesNotMatch(a[0], /（目安：/, `目安が出ている：${a[0]}`);
    }
  });
});

describe("LessonQuestionForm 応答：期限切れの後はもう送らない", () => {
  it("401 の後に入力を変えても送らない。結果不明（通信エラー）の後は送り直せる", async () => {
    const { m, tree } = await respond(res(401, { error: "Unauthorized" }));
    change(textarea(tree), "別の質問");
    click(sendButton(m.render()));
    assert.equal(m.reqs.length, 1, "期限切れの後に送った");

    const n = await respond(new TypeError("Failed to fetch"));
    click(sendButton(n.tree));
    assert.equal(n.m.reqs.length, 2, "結果不明の後に送り直せない（409 に任せる設計）");
    assert.equal(JSON.parse(String(n.m.reqs[1].init?.body)).content, "ダミーの質問です", "送り直しの本文が違う");
  });
});

// ───────────── 4. loadComments と reloadCommentsAfterPost を一緒に動かす ─────────────

const loadSrc = lessonView.slice(lessonView.indexOf("const loadComments"), lessonView.indexOf("useEffect(() => { loadComments("));
const reloadStart = lessonView.indexOf("const activeLessonIdRef = useRef(null);");
const reloadEnd = lessonView.indexOf("\n  };", lessonView.indexOf("const reloadCommentsAfterPost"));
assert.ok(loadSrc.startsWith("const loadComments"), "loadComments が見つからない");
assert.ok(reloadStart >= 0 && reloadEnd > reloadStart, "reloadCommentsAfterPost が見つからない");
const reloadSrc = lessonView.slice(reloadStart, reloadEnd + "\n  };".length);

const ROW = (id: string) => ({ id, content: "ダミー", createdAt: "2026-10-06T12:00:00.000Z", author: { name: "ダミー", isInstructor: false }, mine: true, replies: [] });
const okRes = (rows: unknown): FakeRes => ({ status: 200, ok: true, redirected: false, url: `${ORIGIN}/api/comments/x`, json: () => Promise.resolve(rows) });

/**
 * LessonView の 1 回の描画を模す：render(activeId) ごとに loadComments と reloadCommentsAfterPost を作り直す
 * （ref と state は描画をまたいで共有）。effect は effect(id) で明示的に呼ぶ。
 */
function lessonHarness() {
  const st = { comments: null as null | { lessonId: string; rows: Array<{ id: string }> }, loading: true, failed: null as string | null };
  const commentsInFlight: { current: unknown } = { current: null };
  const activeLessonIdRef: { current: unknown } = { current: null };
  const gets: Array<{ url: string; release: (r: FakeRes) => void; fail: (e: unknown) => void }> = [];
  const authFetch = (url: string) => new Promise<FakeRes>((release, fail) => gets.push({ url, release, fail }));
  const make = new Function(
    "authFetch",
    "classifyAuthFailure",
    "commentsInFlight",
    "setComments",
    "setCommentsLoading",
    "setCommentsFailedLessonId",
    "useRef",
    "activeLesson",
    `${loadSrc}\n${reloadSrc}\nreturn { loadComments, reloadCommentsAfterPost };`
  );
  const render = (activeId: string | null) =>
    make(
      authFetch,
      classifyAuthFailure,
      commentsInFlight,
      (v: typeof st.comments) => (st.comments = v),
      (v: boolean) => (st.loading = v),
      (v: string | null) => (st.failed = v),
      // useRef は描画をまたいで同じ ref を返す（activeLessonIdRef は 1 つだけ）
      () => activeLessonIdRef,
      activeId === null ? null : { id: activeId }
    ) as { loadComments: (id?: string) => void; reloadCommentsAfterPost: (id?: string) => void };
  const shown = () => (st.comments ? `${st.comments.lessonId}:${st.comments.rows.map((r) => r.id).join(",")}` : null);
  return { st, gets, render, shown, commentsInFlight };
}

describe("LessonView：投稿の後の読み直し（本物の loadComments と一緒に実行）", () => {
  it("投稿前に始まった読み込み（l1）の応答は、読み直しの後に届いても捨てる（先に届いた場合も後に届いた場合も）", async () => {
    for (const order of ["old-first", "new-first"] as const) {
      const lv = lessonHarness();
      const r1 = lv.render("l1");
      r1.loadComments("l1"); // effect
      assert.equal(lv.gets.length, 1);
      r1.reloadCommentsAfterPost("l1");
      assert.equal(lv.gets.length, 2, `${order}：読み直しの GET がない`);
      assert.deepEqual(lv.gets.map((g) => g.url), ["/api/comments/l1", "/api/comments/l1"]);
      assert.equal(lv.st.loading, true, `${order}：読み直しの間に読み込み中の印がない`);
      if (order === "old-first") {
        lv.gets[0].release(okRes([]));
        await settle();
        assert.equal(lv.shown(), null, "投稿前の読み込みの応答（自分の質問がない一覧）を表示した");
        assert.equal(lv.st.loading, true, "投稿前の読み込みの終わりで読み込み中の印を外した");
        lv.gets[1].release(okRes([ROW("mine")]));
        await settle();
      } else {
        lv.gets[1].release(okRes([ROW("mine")]));
        await settle();
        lv.gets[0].release(okRes([]));
        await settle();
      }
      assert.equal(lv.shown(), "l1:mine", `${order}：読み直しの一覧が表示されていない`);
      assert.equal(lv.st.loading, false, `${order}：読み込み中のまま`);
      assert.equal(lv.commentsInFlight.current, null, `${order}：読み込み中の印が残る`);
    }
  });

  it("投稿前の読み込みの失敗も捨てる（読み直しが成功すれば失敗を出さない）", async () => {
    const lv = lessonHarness();
    const r1 = lv.render("l1");
    r1.loadComments("l1");
    r1.reloadCommentsAfterPost("l1");
    lv.gets[0].fail(new TypeError("Failed to fetch"));
    await settle();
    assert.equal(lv.st.failed, null, "投稿前の読み込みの失敗を出した");
    lv.gets[1].release(okRes([ROW("mine")]));
    await settle();
    assert.equal(lv.shown(), "l1:mine");
    assert.equal(lv.st.failed, null);
  });

  it("読み込みが終わった後の読み直しは GET 1 本だけ（二重に読まない）。読み直しの失敗は失敗として出す", async () => {
    const lv = lessonHarness();
    const r1 = lv.render("l1");
    r1.loadComments("l1");
    lv.gets[0].release(okRes([ROW("a")]));
    await settle();
    assert.equal(lv.st.loading, false);
    r1.reloadCommentsAfterPost("l1");
    assert.equal(lv.gets.length, 2, "読み直しの GET が 1 本でない");
    // 読み直しの最中に「再読み込み」ボタン相当（loadComments）を呼んでも GET は増えない
    r1.loadComments("l1");
    assert.equal(lv.gets.length, 2, "読み直しの最中に二重に読んだ");
    lv.gets[1].release(res(500, {}));
    await settle();
    assert.equal(lv.st.failed, "l1", "読み直しの失敗を出していない");
    assert.equal(lv.st.loading, false);
  });

  it("送信中に別のレッスン（l2）へ移ったら、古い描画の onReload('l1') は何もしない（l2 の読み込みを横取りしない）", async () => {
    const lv = lessonHarness();
    const r1 = lv.render("l1");
    r1.loadComments("l1");
    lv.gets[0].release(okRes([ROW("a")]));
    await settle();
    // 投稿の送信中にレッスンを切り替える：再描画 → effect で l2 を読む
    const r2 = lv.render("l2");
    r2.loadComments("l2");
    assert.equal(lv.gets.length, 2);
    const l2Request = lv.commentsInFlight.current;
    // 投稿の応答が届き、l1 の描画のときに渡された onReload が呼ばれる
    r1.reloadCommentsAfterPost("l1");
    assert.equal(lv.gets.length, 2, "別のレッスンに移った後に l1 を読み直した");
    assert.equal(lv.commentsInFlight.current, l2Request, "l2 の読み込みを止めた");
    lv.gets[1].release(okRes([ROW("b")]));
    await settle();
    assert.equal(lv.shown(), "l2:b", "l2 の一覧が表示されていない");
  });

  it("l1 → l2 → l1 と戻った後に l1 の投稿の応答が届いたら、l1 を読み直す（戻った後の読み込みは捨てる）", async () => {
    const lv = lessonHarness();
    lv.render("l1").loadComments("l1");
    lv.render("l2").loadComments("l2");
    const back = lv.render("l1");
    back.loadComments("l1");
    assert.equal(lv.gets.length, 3);
    back.reloadCommentsAfterPost("l1");
    assert.equal(lv.gets.length, 4, "戻った後に読み直していない");
    for (let i = 0; i < 3; i++) lv.gets[i].release(okRes([ROW(`old${i}`)]));
    await settle();
    assert.equal(lv.shown(), null, "古い読み込みの応答を表示した");
    lv.gets[3].release(okRes([ROW("mine")]));
    await settle();
    assert.equal(lv.shown(), "l1:mine");
  });

  it("続けて 2 回読み直しても、表示されるのは最後の読み直しの応答だけ", async () => {
    const lv = lessonHarness();
    const r1 = lv.render("l1");
    r1.loadComments("l1");
    r1.reloadCommentsAfterPost("l1");
    r1.reloadCommentsAfterPost("l1");
    assert.equal(lv.gets.length, 3);
    lv.gets[2].release(okRes([ROW("last")]));
    await settle();
    lv.gets[1].release(okRes([ROW("middle")]));
    lv.gets[0].release(okRes([]));
    await settle();
    assert.equal(lv.shown(), "l1:last", "最後の読み直し以外の応答を表示した");
    assert.equal(lv.st.loading, false);
  });
});

// ───────────── 5. 受講生だけに出す ─────────────

describe("受講生だけに投稿欄を出す（式の評価）", () => {
  const studentLine = src.match(/const student = (sessionView\.kind === "authenticated" && sessionView\.role === "STUDENT");/);
  assert.ok(studentLine, "student の定義が見つからない");
  const isStudent = new Function("sessionView", `return ${studentLine[1]};`) as (v: unknown) => boolean;

  const views: Array<[string, unknown, boolean]> = [
    ["受講生", { kind: "authenticated", role: "STUDENT" }, true],
    ["講師", { kind: "authenticated", role: "INSTRUCTOR" }, false],
    ["小文字の student", { kind: "authenticated", role: "student" }, false],
    ["前後に空白", { kind: "authenticated", role: " STUDENT" }, false],
    ["role なし", { kind: "authenticated" }, false],
    ["role が null", { kind: "authenticated", role: null }, false],
    ["期限切れ（role は STUDENT）", { kind: "expired", role: "STUDENT" }, false],
    ["読み込み中", { kind: "loading" }, false],
  ];
  for (const [label, view, expected] of views) {
    it(`${label} → ${expected ? "出す" : "出さない"}`, () => {
      assert.equal(isStudent(view), expected);
    });
  }

  const slot = lessonView.match(/\{(canAskQuestion && activeLesson\?\.id && <LessonQuestionForm [^}]*\}[^}]*\}[^}]*\} \/>)\}/);
  assert.ok(slot, "投稿欄を置く式が見つからない");
  const slotJs = ts.transpileModule(`const f = (canAskQuestion, activeLesson, reloadCommentsAfterPost) => (${slot[1]});`, {
    ...JSX_OPTIONS,
    fileName: "slot.jsx",
  }).outputText;
  const LessonQuestionForm = () => null;
  const evalSlot = new Function("h", "LessonQuestionForm", `${slotJs}\nreturn f;`)(
    (type: unknown, props: Record<string, unknown> | null) => ({ type, props: props ?? {} }),
    LessonQuestionForm
  ) as (can: unknown, lesson: unknown, reload: unknown) => unknown;

  it("canAskQuestion が true でレッスンがあるときだけ部品を返し、key と lessonId はレッスンの id", () => {
    const reload = () => {};
    const el = evalSlot(true, { id: "l1" }, reload) as { type: unknown; props: Record<string, unknown> };
    assert.equal(el.type, LessonQuestionForm);
    assert.equal(el.props.key, "l1");
    assert.equal(el.props.lessonId, "l1");
    assert.equal(el.props.onReload, reload);
  });

  it("講師（false）・未指定（undefined）・レッスンなし・id が空では部品を返さない（描画される値も出さない）", () => {
    for (const [can, lesson] of [
      [false, { id: "l1" }],
      [undefined, { id: "l1" }],
      [true, null],
      [true, { id: "" }],
      [true, {}],
    ] as Array<[unknown, unknown]>) {
      const v = evalSlot(can, lesson, () => {});
      // React は false / undefined / null / "" を何も描画しない。0 や "文字列" が残ると画面に出る
      assert.ok(v === false || v === undefined || v === null || v === "", `部品か描画される値を返した：${JSON.stringify(v)}（${String(can)} / ${JSON.stringify(lesson)}）`);
    }
  });

  it("LessonView を描画する場所はすべて canAskQuestion={student} を渡す（講師の画面からは渡さない）", () => {
    const uses = Array.from(src.matchAll(/<LessonView\b[^>]*\/>/g)).map((m) => m[0]);
    assert.ok(uses.length >= 1, "LessonView の描画が見つからない");
    for (const u of uses) assert.match(u, /canAskQuestion=\{student\}/, u);
  });
});
