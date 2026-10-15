import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import ts from "typescript";
import { classifyAuthFailure } from "./client-session";
import * as commentForm from "./comment-form";

// #46 B-2 レッスンの質問タブの投稿欄：page.tsx（// @ts-nocheck）の LessonQuestionForm と LessonView の配線を
// 1. ソースで検査する（受講生だけに出す、Enter で送信しない、authFetch、二重送信の防止の順序、返信を送らない）
// 2. typescript の transpileModule で JSX から変換し、偽の React で「描画」して表示・状態遷移・リクエストを確かめる
//    （admin-questions.page.test.ts と同じ器）
// 3. LessonView の reloadCommentsAfterPost を取り出して動かす
// DOM・DB・ネットワークなし。データはすべてダミー。
//
// 検証しないこと：setState による再描画（テストが render() を呼んだときだけ描画）、CSS の見た目、
// 実際のブラウザでの IME の挙動（Enter の扱いは「keydown を扱わない・form にしない」ことをソースと木で確かめる）、
// key によるレッスン切り替え時の作り直し（React の動き。key を渡していることだけをソースで確かめる）。

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
const commentsTab = lessonView.slice(lessonView.indexOf('<TabsContent value="comments"'), lessonView.indexOf("</Tabs>"));

// ───────────── ソースの検査 ─────────────

describe("LessonQuestionForm：配線（ソース）", () => {
  it("comment-form から受講生の投稿用の関数を import する", () => {
    const imports = Array.from(src.matchAll(/import \{([^}]*)\} from "@\/lib\/comment-form";/g)).flatMap((m) =>
      m[1].split(",").map((s) => s.trim()).filter(Boolean)
    );
    for (const n of ["commentFormState", "QUESTION_POST_URL", "QUESTION_POSTED_MESSAGE", "interpretQuestionPostResponse", "questionPostBody"]) {
      assert.ok(imports.includes(n), `${n} を import していない`);
    }
  });

  it("受講生のときだけ出す：pages は canAskQuestion={student}、student は STUDENT のロール", () => {
    assert.match(src, /"lesson": <LessonView [^>]*canAskQuestion=\{student\} \/>,/);
    assert.match(src, /const student = sessionView\.kind === "authenticated" && sessionView\.role === "STUDENT";/);
    assert.match(lessonView, /^const LessonView = \(\{[^}]*\bcanAskQuestion\b[^}]*\}\) =>/);
  });

  it("質問タブの一覧の状態（読み込み中・失敗・0 件・一覧）より前に、レッスンの id を key にして置く", () => {
    const formAt = commentsTab.indexOf(
      "{canAskQuestion && activeLesson?.id && <LessonQuestionForm key={activeLesson.id} lessonId={activeLesson.id} onReload={reloadCommentsAfterPost} />}"
    );
    const listAt = commentsTab.indexOf("{commentsWaiting ? (");
    assert.ok(formAt >= 0, "投稿欄の配置が見つからない");
    assert.ok(listAt > formAt, "投稿欄が一覧の状態の分岐の外・前にない");
    assert.equal((src.match(/<LessonQuestionForm\b/g) ?? []).length, 1, "LessonQuestionForm を置く場所が 1 か所でない");
  });

  it("講師の画面（AdminQuestions）や生徒の質問一覧（Questions）には置かない", () => {
    for (const name of ["AdminQuestions", "Questions"]) {
      assert.doesNotMatch(component(name), /LessonQuestionForm|QUESTION_POST_URL/, name);
    }
  });

  it("API は authFetch で呼び、素の fetch は使わない。本文は questionPostBody（parentId を送らない）", () => {
    assert.match(
      formSrc,
      /authFetch\(QUESTION_POST_URL, \{ method: "POST", headers: \{ "Content-Type": "application\/json" \}, body: questionPostBody\(lessonId, value\) \}\)/
    );
    assert.doesNotMatch(formSrc, /(?<![\w$.])fetch\s*\(/);
    assert.doesNotMatch(formSrc, /parentId|JSON\.stringify/);
  });

  it("失効は classifyAuthFailure で判定する", () => {
    assert.match(formSrc, /classifyAuthFailure\(\{ status: res\.status, redirected: res\.redirected, url: res\.url \}\) === "expired"/);
  });

  it("二重送信の防止：ref の判定 → ref の印 → 送信 の順で、finally で印を外す", () => {
    const guard = formSrc.indexOf("if (expiredRef.current || sendingRef.current) return;");
    const mark = formSrc.indexOf("sendingRef.current = true;");
    const post = formSrc.indexOf("authFetch(QUESTION_POST_URL");
    assert.ok(guard >= 0 && mark > guard && post > mark, "判定・印付け・送信の順になっていない");
    assert.match(formSrc, /finally \{\s*sendingRef\.current = false;\s*setSending\(false\);/);
  });

  it("Enter で送信しない：keydown を扱わず、form にしない", () => {
    assert.doesNotMatch(formSrc, /onKey(Down|Press|Up)\b|keydown/i);
    assert.doesNotMatch(formSrc, /<form\b|onSubmit/);
  });

  it("入力欄は textarea 1 つだけ（返信の入力欄を出さない）", () => {
    assert.equal((formSrc.match(/<textarea\b/g) ?? []).length, 1);
    assert.doesNotMatch(formSrc, /<input\b|<Input\b|返信/);
  });
});

// ───────────── 偽の React ─────────────

const transpiled = ts.transpileModule(formSrc, {
  fileName: "LessonQuestionForm.jsx",
  reportDiagnostics: true,
  compilerOptions: {
    jsx: ts.JsxEmit.React,
    jsxFactory: "h",
    jsxFragmentFactory: "Frag",
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
  },
});
const compiled = transpiled.outputText;

type El = { type: unknown; props: Record<string, unknown>; children: Node[] };
type Node = El | string | number;

function stub(name: string) {
  const f = () => null;
  Object.defineProperty(f, "name", { value: name });
  return f;
}
const Button = stub("Button");

function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
  const flat = (children.flat(Infinity) as unknown[]).filter(
    (c) => c !== null && c !== undefined && c !== false && c !== true && c !== ""
  ) as Node[];
  return { type, props: props ?? {}, children: flat };
}
const Frag = "Frag";

function assertRenderable(n: Node) {
  if (typeof n === "string" || typeof n === "number") return;
  assert.ok(n && typeof n === "object" && "type" in n && Array.isArray(n.children), `描画できない子: ${inspect(n)}`);
  for (const c of n.children) assertRenderable(c);
}

type FakeRes = { status: number; ok: boolean; redirected: boolean; url: string; json: () => Promise<unknown> };
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

  const useState = (init: unknown) => {
    const i = si++;
    if (!(i in states)) states[i] = init;
    const set = (v: unknown) => {
      states[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(states[i]) : v;
    };
    return [states[i], set];
  };
  const useRef = (init: unknown) => {
    const i = ri++;
    if (!(i in refs)) refs[i] = { current: init };
    return refs[i];
  };
  const useEffect = () => {
    throw new Error("LessonQuestionForm は useEffect を使わない想定");
  };
  const authFetch = (url: string, init?: RequestInit) => new Promise<FakeRes>((release, fail) => reqs.push({ url, init, release, fail }));

  const T = new Proxy({}, { get: () => "#000000" });
  const scope: Record<string, unknown> = {
    h,
    Frag,
    useState,
    useRef,
    useEffect,
    authFetch,
    classifyAuthFailure,
    ...commentForm,
    T,
    glassStyle: () => ({}),
    Button,
  };
  const names = Object.keys(scope);
  const LessonQuestionForm = new Function(...names, `${compiled}\nreturn LessonQuestionForm;`)(...names.map((n) => scope[n])) as (props: {
    lessonId: string;
    onReload: (id: string) => void;
  }) => El;

  const render = (): El => {
    si = 0;
    ri = 0;
    const tree = LessonQuestionForm({ lessonId, onReload: (id) => reloads.push(id) });
    assertRenderable(tree);
    return tree;
  };
  return { render, reqs, reloads };
}

// ───────────── 木の検索 ─────────────

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

function textarea(tree: El): El {
  const hit = findAll(tree, (e) => e.type === "textarea");
  assert.equal(hit.length, 1, "入力欄が 1 つでない");
  return hit[0];
}
function sendButton(tree: El): El {
  const hit = findAll(tree, (e) => e.type === Button);
  assert.equal(hit.length, 1, "ボタンが 1 つでない");
  return hit[0];
}
const click = (b: El) => (b.props.onClick as (e?: unknown) => void)({ preventDefault() {} });
const change = (el: El, value: string) => (el.props.onChange as (e: unknown) => void)({ target: { value } });
const alerts = (tree: El) => findAll(tree, (e) => e.props.role === "alert").map((e) => text(e));
const statuses = (tree: El) => findAll(tree, (e) => e.props.role === "status").map((e) => text(e));
const counter = (tree: El) => {
  const id = textarea(tree).props["aria-describedby"];
  const hit = findAll(tree, (e) => e.props.id === id);
  assert.equal(hit.length, 1, "文字数の表示が 1 つでない");
  return text(hit[0]);
};

/** 入力して送信ボタンを押した状態（応答待ち） */
function sent(value = "ダミーの質問です") {
  const m = mount();
  change(textarea(m.render()), value);
  click(sendButton(m.render()));
  assert.equal(m.reqs.length, 1, "送信が 1 本でない");
  return m;
}

// ───────────── 描画 ─────────────

describe("LessonQuestionForm 描画：前提", () => {
  it("JSX の変換：診断なしで、import / export を含まない", () => {
    assert.deepEqual(transpiled.diagnostics ?? [], []);
    assert.doesNotMatch(compiled, /^\s*(import|export)\b/m);
  });
});

describe("LessonQuestionForm 描画：入力欄", () => {
  it("最初は空・「0 / 2000」・送信できない。ラベルが入力欄に結び付いている。何も読み込まない", () => {
    const m = mount();
    const tree = m.render();
    const input = textarea(tree);
    assert.equal(input.props.value, "");
    assert.equal(counter(tree), "0 / 2000");
    assert.equal(sendButton(tree).props.disabled, true, "空なのに送信できる");
    assert.equal(text(sendButton(tree)).trim(), "質問を送信");
    const labels = findAll(tree, (e) => e.type === "label");
    assert.equal(labels.length, 1, "ラベルが 1 つでない");
    assert.equal(labels[0].props.htmlFor, input.props.id, "ラベルと入力欄が結び付いていない");
    assert.deepEqual(alerts(tree), []);
    assert.equal(m.reqs.length, 0);
  });

  it("Enter で送信しない：keydown を持たず、form の中に置かない", () => {
    const tree = mount().render();
    const input = textarea(tree);
    for (const k of ["onKeyDown", "onKeyPress", "onKeyUp", "onKeyDownCapture"]) assert.equal(input.props[k], undefined, k);
    assert.equal(findAll(tree, (e) => e.type === "form").length, 0, "form がある");
    assert.equal(sendButton(tree).props.type, undefined, "submit ボタンになっている");
  });

  it("空白・見えない文字だけは送れない、2000 字までは送れる、2001 字は送れず aria-invalid と超過数を出す", () => {
    const m = mount();
    for (const v of ["   ", "\n\n", "\u200B\u3000", "\uFEFF"]) {
      change(textarea(m.render()), v);
      assert.equal(sendButton(m.render()).props.disabled, true, JSON.stringify(v));
    }
    change(textarea(m.render()), "あ".repeat(2000));
    let tree = m.render();
    assert.equal(sendButton(tree).props.disabled, false, "2000 字で送れない");
    assert.equal(counter(tree), "2000 / 2000");
    change(textarea(m.render()), "あ".repeat(2001));
    tree = m.render();
    assert.equal(sendButton(tree).props.disabled, true, "2001 字で送れる");
    assert.equal(textarea(tree).props["aria-invalid"], true);
    assert.equal(counter(tree), "2001 / 2000（1 文字オーバー）");
  });

  it("送れない状態でボタンの onClick を直接呼んでも送らない", () => {
    const m = mount();
    click(sendButton(m.render()));
    change(textarea(m.render()), "あ".repeat(2001));
    click(sendButton(m.render()));
    assert.equal(m.reqs.length, 0);
  });
});

describe("LessonQuestionForm 描画：送信", () => {
  it("POST /api/comments に lessonId と content だけを送る（parentId なし）", () => {
    const m = sent("  質問です\n");
    const req = m.reqs[0];
    assert.equal(req.url, "/api/comments");
    assert.equal(req.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(req.init?.body)), { lessonId: "l1", content: "  質問です\n" });
  });

  it("送信中：ボタンは無効で「送信中...」、入力は読み取り専用。同じ描画のボタンを続けて押しても 1 本", async () => {
    const m = mount();
    change(textarea(m.render()), "ダミーの質問です");
    const before = sendButton(m.render());
    click(before);
    click(before);
    click(before);
    assert.equal(m.reqs.length, 1, "二重に送った");
    const during = m.render();
    assert.equal(sendButton(during).props.disabled, true, "送信中に押せる");
    assert.equal(text(sendButton(during)).trim(), "送信中...");
    assert.equal(textarea(during).props.readOnly, true, "送信中に入力を変えられる");
    click(sendButton(during));
    assert.equal(m.reqs.length, 1, "送信中に再送した");
    m.reqs[0].release(res(201, { id: "c1" }));
    await settle();
    assert.equal(m.reqs.length, 1);
  });

  it("成功（201）：入力を空にし、知らせを出し、そのレッスンの一覧を読み直す。また送れる", async () => {
    const m = sent();
    m.reqs[0].release(res(201, { id: "c1", content: "ダミーの質問です" }));
    await settle();
    const tree = m.render();
    assert.equal(textarea(tree).props.value, "", "成功したのに入力が残る");
    assert.equal(textarea(tree).props.readOnly, false);
    assert.deepEqual(statuses(tree), ["質問を投稿しました。"]);
    assert.deepEqual(alerts(tree), []);
    assert.deepEqual(m.reloads, ["l1"]);
    change(textarea(tree), "次の質問");
    click(sendButton(m.render()));
    assert.equal(m.reqs.length, 2, "成功の後に送れない");
    assert.deepEqual(statuses(m.render()), [""], "送信を始めても前の知らせが残る");
  });

  const failures: Array<[string, () => FakeRes | Error, RegExp, boolean]> = [
    ["429 rate_limited", () => res(429, { reason: "rate_limited", retryAfterSeconds: 25 }), /^投稿の間隔が短いか、1 日に投稿できる件数を超えました。しばらく待ってからもう一度お試しください。（目安：約 25 秒後）$/, false],
    ["409 duplicate", () => res(409, { reason: "duplicate" }), /^同じ内容の質問を送信済みです/, true],
    ["403 course_locked", () => res(403, { reason: "course_locked" }), /^このコースはまだ解放されていません。$/, false],
    ["403 forbidden_role", () => res(403, { reason: "forbidden_role" }), /質問対応/, false],
    ["403 reply_not_allowed", () => res(403, { reason: "reply_not_allowed" }), /返信は投稿できません/, false],
    ["400 too_long", () => res(400, { reason: "too_long" }), /2000 文字以内/, false],
    ["404", () => res(404, { error: "Lesson not found" }), /レッスンが見つかりません/, false],
    ["500", () => res(500, { error: "Internal server error" }), /サーバーでエラー/, false],
    ["502（本文が JSON でない）", () => res(502, undefined), /送信できたかどうか確かめられませんでした/, true],
    ["504", () => res(504, undefined), /送信できたかどうか確かめられませんでした/, true],
    ["/login 以外へのリダイレクト", () => res(200, undefined, { redirected: true, url: `${ORIGIN}/` }), /送信できたかどうか確かめられませんでした/, true],
    ["通信エラー", () => new TypeError("Failed to fetch"), /送信できたかどうか確かめられませんでした/, true],
  ];
  for (const [label, make, message, reload] of failures) {
    it(`失敗（${label}）：入力を残して role=alert で文言を出す。一覧の読み直しは ${reload ? "する" : "しない"}。もう一度送れる`, async () => {
      const m = sent("ダミーの質問です");
      const r = make();
      if (r instanceof Error) m.reqs[0].fail(r);
      else m.reqs[0].release(r);
      await settle();
      const tree = m.render();
      assert.equal(textarea(tree).props.value, "ダミーの質問です", "入力が消えた");
      assert.equal(textarea(tree).props.readOnly, false, "失敗の後に入力できない");
      const a = alerts(tree);
      assert.equal(a.length, 1, `エラーが 1 つでない：${a.join(" / ")}`);
      assert.match(a[0], message);
      assert.deepEqual(statuses(tree), [""], "成功の知らせが出ている");
      assert.deepEqual(m.reloads, reload ? ["l1"] : [], "一覧の読み直しが想定と違う");
      click(sendButton(tree));
      assert.equal(m.reqs.length, 2, "失敗の後に送れない");
      assert.deepEqual(alerts(m.render()), [], "送信を始めても前のエラーが残る");
    });
  }

  for (const [label, r] of [
    ["401", res(401, { error: "Unauthorized" })],
    ["/login へのリダイレクト", res(200, undefined, { redirected: true, url: `${ORIGIN}/login?callbackUrl=%2F` })],
  ] as Array<[string, FakeRes]>) {
    it(`期限切れ（${label}）：ログインの期限切れの文言を出し、読み直さず、もう送らない`, async () => {
      const m = sent();
      let jsonRead = false;
      m.reqs[0].release({ ...r, json: () => ((jsonRead = true), r.json()) });
      await settle();
      const tree = m.render();
      assert.equal(jsonRead, false, "期限切れの応答の本文を読んだ");
      assert.deepEqual(alerts(tree), [commentForm.COMMENT_SESSION_EXPIRED_MESSAGE]);
      assert.deepEqual(m.reloads, []);
      assert.equal(textarea(tree).props.value, "ダミーの質問です");
      click(sendButton(tree));
      assert.equal(m.reqs.length, 1, "期限切れの後に送った");
    });
  }

  it("成功の応答の本文は読まない（201 の本文が壊れていても成功）", async () => {
    const m = sent();
    m.reqs[0].release(res(201, undefined));
    await settle();
    assert.deepEqual(statuses(m.render()), ["質問を投稿しました。"]);
  });

  it("文言はすべて日本語（英語の既定文言を出さない）", async () => {
    for (const [, make] of failures) {
      const m = sent();
      const r = make();
      if (r instanceof Error) m.reqs[0].fail(r);
      else m.reqs[0].release(r);
      await settle();
      for (const a of alerts(m.render())) assert.doesNotMatch(a, /Error|error|Unauthorized|Forbidden|Too many|Conflict|not found/, a);
    }
  });
});

// ───────────── LessonView：投稿の後の読み直し ─────────────

describe("LessonView：reloadCommentsAfterPost（実行）", () => {
  const start = lessonView.indexOf("const activeLessonIdRef = useRef(null);");
  const end = lessonView.indexOf("\n  };", lessonView.indexOf("const reloadCommentsAfterPost"));
  assert.ok(start >= 0 && end > start, "reloadCommentsAfterPost が見つからない");
  const body = lessonView.slice(start, end + "\n  };".length);

  function harness(activeId: string | null) {
    const calls: string[] = [];
    // loadComments を呼んだ時点の読み込み中の印
    const inFlightAtCall: unknown[] = [];
    const commentsInFlight: { current: unknown } = { current: { lessonId: activeId } };
    const useRef = (init: unknown) => ({ current: init });
    const activeLesson = activeId === null ? null : { id: activeId };
    const reload = new Function("useRef", "activeLesson", "commentsInFlight", "loadComments", `${body}\nreturn reloadCommentsAfterPost;`)(
      useRef,
      activeLesson,
      commentsInFlight,
      (id: string) => {
        calls.push(id);
        inFlightAtCall.push(commentsInFlight.current);
      }
    ) as (id: string | undefined) => void;
    return { reload, calls, inFlightAtCall, commentsInFlight };
  }

  it("今のレッスンなら、読み込み中の印を外してから読み直す（投稿の前に始まった読み込みに頼らない）", () => {
    const { reload, inFlightAtCall } = harness("l1");
    reload("l1");
    assert.deepEqual(inFlightAtCall, [null], "読み込み中の印が残ったまま loadComments を呼んだ");
  });

  it("今のレッスンなら loadComments(lessonId) を呼ぶ", () => {
    const { reload, calls } = harness("l1");
    reload("l1");
    assert.deepEqual(calls, ["l1"]);
  });

  it("別のレッスンに移った後・レッスンがない・id がないときは読まない（今のレッスンの読み込みを横取りしない）", () => {
    for (const [active, id] of [
      ["l2", "l1"],
      [null, "l1"],
      ["l1", undefined],
      ["l1", ""],
    ] as Array<[string | null, string | undefined]>) {
      const { reload, calls, commentsInFlight } = harness(active);
      const before = commentsInFlight.current;
      reload(id);
      assert.deepEqual(calls, [], `${active} / ${id} で読んだ`);
      assert.equal(commentsInFlight.current, before, `${active} / ${id} で読み込み中の印を変えた`);
    }
  });
});
