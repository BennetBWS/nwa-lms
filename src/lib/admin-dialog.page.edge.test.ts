import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToString } from "react-dom/server";

// #44 追加検査。
// 1) page.tsx の ModalPortal の本文を取り出し、偽の useState / useEffect / createPortal / document で動かす。
//    （page.tsx は "use client" かつ // @ts-nocheck で import できないため、関数の本文だけを実行する）
// 2) 実際の React（react-dom/server）で SSR したとき何も出力せず、document に触れないこと。
// 3) Portal 化の前からある確認ダイアログ・招待ダイアログの挙動（Esc、フォーカスの戻り、処理中は閉じない、
//    409 DEACTIVATED からの切り替え、開くときの state の初期化）がソースに残っていること。
// ブラウザでの描画・フォーカス移動そのものは確認できない（手動確認）。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

/** start 以降で最初の open（"{" か "("）から、対応する閉じかっこまでを返す（両端を含む） */
function balanced(text: string, start: number, open: "{" | "("): string {
  const close = open === "{" ? "}" : ")";
  const from = text.indexOf(open, start);
  assert.ok(from >= 0, `${open} が見つからない`);
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  assert.fail(`${open} の閉じかっこが見つからない`);
}

/** `const ModalPortal = ({ children }) => { ... }` のアロー関数の式を取り出す */
function modalPortalSource(): string {
  const head = "const ModalPortal = ({ children }) =>";
  const start = src.indexOf(head);
  assert.ok(start >= 0, "ModalPortal の定義が見つからない（引数の形が変わった？）");
  const body = balanced(src, start + head.length, "{");
  return `({ children }) => ${body}`;
}

type Portal = { kind: "portal"; children: unknown; container: unknown };

/** ModalPortal を、外から差し込む useState / useEffect / createPortal / document で関数にする */
function buildModalPortal(deps: {
  useState: (init: unknown) => [unknown, (v: unknown) => void];
  useEffect: (fn: () => unknown, deps?: unknown[]) => void;
  createPortal: (children: unknown, container: unknown) => unknown;
  document: unknown;
}): (props: { children: unknown }) => unknown {
  // eslint-disable-next-line no-new-func
  const factory = new Function("useState", "useEffect", "createPortal", "document", `return (${modalPortalSource()});`);
  return factory(deps.useState, deps.useEffect, deps.createPortal, deps.document);
}

/**
 * 1 つのコンポーネントのインスタンスを模した最小のフック実行器。
 * - render() でフックの呼び出し順に state を割り当てる
 * - useEffect は deps が変わったときだけ、描画のあとに commit() で実行する
 * - setState は再描画が必要かどうかを記録するだけ（rerender は呼び出し側が行う）
 */
function createHarness(documentObj: unknown) {
  const states: unknown[] = [];
  const effectDeps: (unknown[] | undefined)[] = [];
  const cleanups: (unknown | undefined)[] = [];
  let pendingEffects: { index: number; fn: () => unknown }[] = [];
  let hookIndex = 0;
  let effectIndex = 0;
  let dirty = false;
  let rendering = false;
  const portals: Portal[] = [];
  let effectRuns = 0;

  const useState = (init: unknown): [unknown, (v: unknown) => void] => {
    const i = hookIndex++;
    if (states.length <= i) states.push(init);
    const set = (v: unknown) => {
      assert.ok(!rendering, "描画中に setState している");
      if (!Object.is(states[i], v)) {
        states[i] = v;
        dirty = true;
      }
    };
    return [states[i], set];
  };
  const useEffect = (fn: () => unknown, deps?: unknown[]) => {
    const i = effectIndex++;
    const prev = effectDeps[i];
    const changed =
      prev === undefined || deps === undefined || deps.length !== prev.length || deps.some((d, k) => !Object.is(d, prev[k]));
    if (changed) {
      effectDeps[i] = deps;
      pendingEffects.push({ index: i, fn });
    }
  };
  const createPortal = (children: unknown, container: unknown) => {
    const p: Portal = { kind: "portal", children, container };
    portals.push(p);
    return p;
  };

  const Comp = buildModalPortal({ useState, useEffect, createPortal, document: documentObj });

  return {
    portals,
    get effectRuns() {
      return effectRuns;
    },
    get dirty() {
      return dirty;
    },
    render(children: unknown) {
      hookIndex = 0;
      effectIndex = 0;
      dirty = false;
      rendering = true;
      try {
        return Comp({ children });
      } finally {
        rendering = false;
      }
    },
    commit() {
      const effects = pendingEffects;
      pendingEffects = [];
      for (const e of effects) {
        effectRuns++;
        cleanups[e.index] = e.fn();
      }
    },
    cleanups,
  };
}

/** body に触れたら記録する document の代わり */
function fakeDocument() {
  const body = { nodeName: "BODY" };
  let bodyReads = 0;
  const doc = {
    get body() {
      bodyReads++;
      return body;
    },
  };
  return {
    doc,
    body,
    get bodyReads() {
      return bodyReads;
    },
  };
}

describe("ModalPortal（本文を取り出して実行）", () => {
  it("初回描画は null を返し、document にも createPortal にも触れない", () => {
    const d = fakeDocument();
    const h = createHarness(d.doc);
    assert.equal(h.render("child"), null);
    assert.equal(d.bodyReads, 0, "初回描画で document.body を読んでいる（SSR で落ちる）");
    assert.equal(h.portals.length, 0);
  });

  it("マウント後（effect の実行後）の再描画で、children を document.body に Portal で描画する", () => {
    const d = fakeDocument();
    const h = createHarness(d.doc);
    const children = { type: "div", key: "dialog" };
    assert.equal(h.render(children), null);
    h.commit();
    assert.equal(h.effectRuns, 1);
    assert.ok(h.dirty, "マウント後に再描画が要求されていない");
    const out = h.render(children) as Portal;
    assert.equal(out.kind, "portal");
    assert.equal(out.children, children, "children をそのまま渡していない");
    assert.equal(out.container, d.body, "document.body 以外に描画している");
    assert.equal(h.portals.length, 1);
  });

  it("マウントの effect は 1 回だけ（再描画のたびに setMounted しない）", () => {
    const d = fakeDocument();
    const h = createHarness(d.doc);
    h.render("a");
    h.commit();
    h.render("b");
    h.commit();
    h.render("c");
    h.commit();
    assert.equal(h.effectRuns, 1);
    assert.equal(h.dirty, false);
  });

  it("マウント後は children が変わるとその children を描画する", () => {
    const d = fakeDocument();
    const h = createHarness(d.doc);
    h.render("first");
    h.commit();
    assert.equal((h.render("first") as Portal).children, "first");
    assert.equal((h.render("second") as Portal).children, "second");
  });

  it("effect は後片付け（cleanup）を返さない（アンマウント時に何もしなくてよい：Portal は React が取り除く）", () => {
    const d = fakeDocument();
    const h = createHarness(d.doc);
    h.render("x");
    h.commit();
    assert.equal(h.cleanups[0], undefined);
  });

  it("新しく作られたインスタンス（閉じて開き直したとき）は、また初回描画で null から始まる", () => {
    const d = fakeDocument();
    const first = createHarness(d.doc);
    first.render("x");
    first.commit();
    assert.equal((first.render("x") as Portal).kind, "portal");
    const second = createHarness(d.doc);
    assert.equal(second.render("x"), null);
  });

  it("children が null・false でも落ちない（Portal に渡すだけ）", () => {
    const d = fakeDocument();
    const h = createHarness(d.doc);
    h.render(null);
    h.commit();
    assert.equal((h.render(null) as Portal).children, null);
    assert.equal((h.render(false) as Portal).children, false);
  });
});

describe("ModalPortal（実際の React で SSR）", () => {
  it("renderToString は空文字で、document がなくても落ちない", () => {
    assert.equal(typeof (globalThis as { document?: unknown }).document, "undefined", "テスト環境に document がある");
    const Comp = buildModalPortal({
      useState: React.useState as never,
      useEffect: React.useEffect as never,
      createPortal: () => {
        throw new Error("SSR で createPortal を呼んだ");
      },
      document: undefined,
    }) as unknown as React.FC<{ children?: React.ReactNode }>;
    const html = renderToString(
      React.createElement("main", null, React.createElement(Comp, null, React.createElement("div", { role: "dialog" }, "確認"))),
    );
    assert.equal(html, "<main></main>");
  });
});

// ---- Portal 化の前からある挙動がソースに残っているか ----

function component(name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nconst [A-Z]\w* ?=|\nexport default function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

// #32 受講生の表とダイアログは「生徒管理」（AdminStudents）に移した
const admin = component("AdminStudents");

/** `{cond && (` の中身 */
function conditionalBlock(cond: string): string {
  const head = `{${cond} && (`;
  const start = admin.indexOf(head);
  assert.ok(start >= 0, `${head} が見つからない`);
  return balanced(admin, start + head.length - 1, "(");
}

describe("AdminStudents：確認ダイアログの挙動が Portal 化で変わっていない", () => {
  it("closeStatusDialog は処理中（statusSaving）なら閉じない", () => {
    const i = admin.indexOf("const closeStatusDialog = () =>");
    assert.ok(i >= 0);
    const body = balanced(admin, i, "{");
    assert.match(body, /^\{\s*if \(statusSaving\) return;\s*setStatusDialog\(null\);\s*\}$/);
  });

  it("Esc は window の keydown で受け、開いている間だけ登録し、閉じたら外す", () => {
    const i = admin.indexOf("useEffect(() => {\n    if (!statusDialog) return;");
    assert.ok(i >= 0, "Esc の effect が見つからない");
    const effect = admin.slice(i, admin.indexOf("}, [statusDialog, statusSaving]);", i) + 40);
    assert.match(effect, /if \(e\.key !== "Escape"\) return;/);
    assert.match(effect, /closeStatusDialog\(\);/);
    assert.match(effect, /window\.addEventListener\("keydown", onKeyDown\);/);
    assert.match(effect, /return \(\) => window\.removeEventListener\("keydown", onKeyDown\);/);
    // statusSaving を deps に含めないと、処理中の判定が古い値のままになる
    assert.match(effect, /\}, \[statusDialog, statusSaving\]\);/);
  });

  it("閉じたら開いたボタン（DOM に残っていれば）へフォーカスを戻す", () => {
    const i = admin.indexOf("if (statusDialogOpen) return;");
    assert.ok(i >= 0);
    const effect = admin.slice(i, admin.indexOf("}, [statusDialogOpen]);", i));
    assert.match(effect, /const trigger = statusDialogTriggerRef\.current;/);
    assert.match(effect, /statusDialogTriggerRef\.current = null;/);
    assert.match(effect, /if \(trigger && trigger\.isConnected\) trigger\.focus\(\);/);
  });

  it("openStatusDialog は開いたボタンを覚え、前回のエラーを消してから開く", () => {
    const i = admin.indexOf("const openStatusDialog = (action, student, trigger = null) =>");
    assert.ok(i >= 0);
    const body = balanced(admin, i, "{");
    const ref = body.indexOf("statusDialogTriggerRef.current = trigger;");
    const clear = body.indexOf('setStatusError("");');
    const open = body.indexOf("setStatusDialog({ action, id: student.id, name: student.name });");
    assert.ok(ref >= 0 && clear >= 0 && open >= 0);
    assert.ok(ref < open && clear < open, "開く前に初期化していない");
  });

  it("一覧の無効化・再有効化ボタンは、押したボタン（e.currentTarget）を渡して開く", () => {
    const calls = Array.from(admin.matchAll(/openStatusDialog\(([^)]*)\)/g), (m) => m[1]);
    const fromRows = calls.filter((a) => a.includes("currentTarget"));
    assert.ok(fromRows.length >= 1, "一覧から開く呼び出しで、フォーカスの戻り先を渡していない");
  });

  it("確認ダイアログの本体は role=dialog・aria-modal・見出しの id を持ち、背景クリックは closeStatusDialog", () => {
    const block = conditionalBlock("statusDialog");
    assert.match(block, /role="dialog" aria-modal="true" aria-labelledby="nwa-status-dialog-title"/);
    assert.match(block, /<h3 id="nwa-status-dialog-title"/);
    assert.match(block, /onClick=\{closeStatusDialog\}>/);
  });

  it("処理中はキャンセル・実行ボタンとも disabled", () => {
    const block = conditionalBlock("statusDialog");
    assert.match(block, /autoFocus onClick=\{closeStatusDialog\} disabled=\{statusSaving\}/);
    assert.match(block, /onClick=\{handleStatusAction\} disabled=\{statusSaving\}/);
  });

  it("ModalPortal の中で autoFocus を持つのはキャンセルだけ（実行ボタンに初期フォーカスしない）", () => {
    const block = conditionalBlock("statusDialog");
    assert.equal(block.split("autoFocus").length - 1, 1);
  });
});

describe("AdminStudents：招待ダイアログの挙動が Portal 化で変わっていない", () => {
  it("招待ボタンは、開くときに前回の結果・入力を消す", () => {
    const m = admin.match(/onClick=\{\(\) => \{ setInviteModal\(true\);([^}]*)\}\}/);
    assert.ok(m, "招待を開く onClick が見つからない");
    for (const s of ["setInviteResponse(null);", 'setInviteEmail("");', 'setInviteName("");']) {
      assert.ok(m[1].includes(s), `${s} がない`);
    }
  });

  it("409 DEACTIVATED の「再有効化する」は、招待を閉じてから確認ダイアログを開く（戻り先のボタンは渡さない）", () => {
    const block = conditionalBlock("inviteModal");
    assert.match(
      block,
      /onClick=\{\(\) => \{ setInviteModal\(false\); openStatusDialog\("reactivate", inviteDeactivatedStudent\); \}\}/,
    );
  });

  it("確認ダイアログは招待ダイアログの外（兄弟）にあり、それぞれ別の ModalPortal", () => {
    const invite = conditionalBlock("inviteModal");
    assert.ok(!invite.includes("{statusDialog && ("), "確認ダイアログが招待ダイアログの中にある");
    const status = conditionalBlock("statusDialog");
    assert.equal(invite.split("<ModalPortal>").length - 1, 1);
    assert.equal(status.split("<ModalPortal>").length - 1, 1);
  });

  it("招待ダイアログの閉じる操作（背景・キャンセル・完了後の閉じる）は setInviteModal(false)", () => {
    const block = conditionalBlock("inviteModal");
    // 背景・成功時の閉じる・キャンセル・再有効化への切り替え の 4 か所
    assert.equal(block.split("setInviteModal(false)").length - 1, 4);
  });

  it("招待ボタンは未入力・送信中は押せない", () => {
    const block = conditionalBlock("inviteModal");
    assert.match(block, /onClick=\{handleInvite\} disabled=\{inviting \|\| !inviteEmail \|\| !inviteName\}/);
  });
});

describe("page.tsx：ModalPortal の使われ方", () => {
  it("ModalPortal は AdminStudents の 2 つのダイアログだけで使う（AdminDashboard には残っていない）", () => {
    assert.equal(src.split("<ModalPortal>").length - 1, 2);
    assert.equal(src.split("</ModalPortal>").length - 1, 2);
    assert.equal(admin.split("<ModalPortal>").length - 1, 2);
    const dashboard = component("AdminDashboard");
    assert.ok(!dashboard.includes("<ModalPortal>"), "AdminDashboard に ModalPortal が残っている");
  });

  it("ModalPortal はトップレベルで 1 回だけ定義されている", () => {
    assert.equal(src.split("const ModalPortal =").length - 1, 1);
  });

  it("Portal 先の背景は、親から継承できなくなるフォントと文字色を自分で指定している", () => {
    for (const cond of ["inviteModal", "statusDialog"]) {
      const backdrop = conditionalBlock(cond).split("\n")[2] ?? "";
      assert.match(backdrop, /position: "fixed"/, cond);
      assert.match(backdrop, /fontFamily: "var\(--font-zen\), 'Zen Kaku Gothic New', sans-serif"/, cond);
      assert.match(backdrop, /color: T\.textPrimary/, cond);
    }
  });
});
