import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMMENT_MAX_LENGTH,
  COMMENTS_LIMIT,
  commentLength,
  commentsTabLabel,
  lessonTypeLabel,
  parseCreateComment,
  safeExternalUrl,
  toCommentItems,
  toCommentThreadView,
  type CommentThreadRow,
} from "./lesson-comments";

// #32 レッスンの質問タブ・/api/comments の純粋関数。DB・ネットワークなし。データはすべてダミー。
// 見えない文字はソースに直接書かず、\u エスケープで書く。

const ZWSP = "\u200B";
const RLO = "\u202E";
const HANGUL_FILLER = "\u3164";
const NBSP = "\u00A0";
const IDEOGRAPHIC_SPACE = "\u3000";
const COMBINING_ACUTE = "\u0301";
const EMOJI = "\u{1F600}";

const ok = (body: unknown) => {
  const r = parseCreateComment(body);
  assert.ok(r.ok, `ok のはず: ${JSON.stringify(r)}`);
  return (r as Extract<typeof r, { ok: true }>).value;
};
const reason = (body: unknown) => {
  const r = parseCreateComment(body);
  assert.ok(!r.ok, "失敗のはず");
  return (r as Extract<typeof r, { ok: false }>).reason;
};

describe("定数", () => {
  it("本文の上限は 2000 文字、取得は 100 件", () => {
    assert.equal(COMMENT_MAX_LENGTH, 2000);
    assert.equal(COMMENTS_LIMIT, 100);
  });

  it("commentLength はコードポイントで数える（サロゲートペアは 1、結合文字は別に 1）", () => {
    assert.equal(commentLength("abc"), 3);
    assert.equal(commentLength(EMOJI), 1);
    assert.equal(EMOJI.length, 2);
    assert.equal(commentLength(`e${COMBINING_ACUTE}`), 2);
    assert.equal(commentLength(""), 0);
  });
});

describe("parseCreateComment：body", () => {
  for (const [label, body] of [
    ["null", null],
    ["undefined", undefined],
    ["配列", [{ lessonId: "l1", content: "x" }]],
    ["文字列", "content"],
    ["数値", 1],
  ] as Array<[string, unknown]>) {
    it(`${label} は invalid_body`, () => {
      assert.equal(reason(body), "invalid_body");
    });
  }
});

describe("parseCreateComment：content", () => {
  const base = { lessonId: "lesson_1" };

  for (const [label, content] of [
    ["undefined", undefined],
    ["null", null],
    ["数値", 123],
    ["配列", ["x"]],
    ["オブジェクト", { text: "x" }],
    ["String オブジェクト", new String("x")],
  ] as Array<[string, unknown]>) {
    it(`${label} は invalid_content`, () => {
      assert.equal(reason({ ...base, content }), "invalid_content");
    });
  }

  for (const [label, content] of [
    ["空文字", ""],
    ["半角空白だけ", "   "],
    ["改行・タブだけ", "\n\t\r\n"],
    ["全角空白・NBSP だけ", `${IDEOGRAPHIC_SPACE}${NBSP}`],
    ["ゼロ幅スペースだけ", ZWSP.repeat(3)],
    ["RLO だけ", RLO],
    ["ハングルの埋め字だけ", HANGUL_FILLER],
    ["結合文字だけ", COMBINING_ACUTE],
    ["見えない文字と空白の混在", ` ${ZWSP}\n${HANGUL_FILLER} `],
  ] as Array<[string, string]>) {
    it(`${label} は empty`, () => {
      assert.equal(reason({ ...base, content }), "empty");
    });
  }

  it("2000 文字ちょうどは通る、2001 文字は too_long", () => {
    assert.equal(ok({ ...base, content: "あ".repeat(2000) }).content.length, 2000);
    assert.equal(reason({ ...base, content: "あ".repeat(2001) }), "too_long");
  });

  it("サロゲートペアは 1 文字として数える（絵文字 2000 個は通る、2001 個は too_long）", () => {
    assert.equal(commentLength(ok({ ...base, content: EMOJI.repeat(2000) }).content), 2000);
    assert.equal(reason({ ...base, content: EMOJI.repeat(2001) }), "too_long");
  });

  it("結合文字は別に数える（e + 結合アクセント × 1000 は 2000 文字で通る、1 文字足すと too_long）", () => {
    const s = `e${COMBINING_ACUTE}`.repeat(1000);
    assert.equal(commentLength(s), 2000);
    assert.equal(ok({ ...base, content: s }).content, s);
    assert.equal(reason({ ...base, content: `${s}x` }), "too_long");
  });

  it("前後の空白は除いてから数える（前後に空白のある 2000 文字は通る）", () => {
    const v = ok({ ...base, content: `  \n${"a".repeat(2000)}\n  ` });
    assert.equal(v.content, "a".repeat(2000));
  });

  it("中の改行は残し、前後の空白・改行は除く", () => {
    assert.equal(ok({ ...base, content: "\n  1行目\n\n2行目\r\n3行目  \n" }).content, "1行目\n\n2行目\r\n3行目");
  });

  it("見えない文字が混ざっていても、見える文字があれば通る（本文はそのまま）", () => {
    assert.equal(ok({ ...base, content: `a${ZWSP}b` }).content, `a${ZWSP}b`);
  });

  it("絵文字だけ・記号だけは通る", () => {
    assert.equal(ok({ ...base, content: EMOJI }).content, EMOJI);
    assert.equal(ok({ ...base, content: "?" }).content, "?");
  });
});

describe("parseCreateComment：lessonId", () => {
  for (const [label, lessonId] of [
    ["undefined", undefined],
    ["null", null],
    ["空文字", ""],
    ["数値", 1],
    ["65 文字", "a".repeat(65)],
    ["配列", ["l1"]],
  ] as Array<[string, unknown]>) {
    it(`${label} は invalid_lesson_id`, () => {
      assert.equal(reason({ lessonId, content: "質問" }), "invalid_lesson_id");
    });
  }

  it("64 文字は通る", () => {
    assert.equal(ok({ lessonId: "a".repeat(64), content: "質問" }).lessonId, "a".repeat(64));
  });
});

describe("parseCreateComment：parentId", () => {
  const base = { lessonId: "lesson_1", content: "質問" };

  it("undefined（キーなし）と null は親の質問（parentId: null）", () => {
    assert.equal(ok(base).parentId, null);
    assert.equal(ok({ ...base, parentId: null }).parentId, null);
  });

  it("空でない文字列はそのまま", () => {
    assert.equal(ok({ ...base, parentId: "c_parent" }).parentId, "c_parent");
  });

  for (const [label, parentId] of [
    ["空文字", ""],
    ["数値", 1],
    ["0", 0],
    ["false", false],
    ["オブジェクト", { id: "c1" }],
    ["65 文字", "p".repeat(65)],
  ] as Array<[string, unknown]>) {
    it(`${label} は invalid_parent_id`, () => {
      assert.equal(reason({ ...base, parentId }), "invalid_parent_id");
    });
  }

  it("userId を送っても値に含めない", () => {
    const v = ok({ ...base, userId: "someone_else" });
    assert.deepEqual(Object.keys(v).sort(), ["content", "lessonId", "parentId"]);
  });
});

describe("toCommentThreadView", () => {
  const at = new Date("2026-10-01T09:00:00.000Z");
  const row = (over: Partial<CommentThreadRow> = {}): CommentThreadRow => ({
    id: "c1",
    content: "質問です",
    createdAt: at,
    userId: "stu_a",
    user: { name: "受講生エー", role: "STUDENT", deactivatedAt: null },
    ...over,
  });

  it("受講生は登録名、講師ではない、自分の投稿なら mine", () => {
    const v = toCommentThreadView(row(), "stu_a");
    assert.deepEqual(v, {
      id: "c1",
      content: "質問です",
      createdAt: "2026-10-01T09:00:00.000Z",
      author: { name: "受講生エー", isInstructor: false },
      mine: true,
      replies: [],
    });
  });

  it("他人の投稿は mine: false", () => {
    assert.equal(toCommentThreadView(row(), "stu_b").mine, false);
  });

  it("講師は isInstructor: true で名前を出す", () => {
    const v = toCommentThreadView(row({ userId: "ins_1", user: { name: "講師ビー", role: "INSTRUCTOR", deactivatedAt: null } }), "stu_a");
    assert.deepEqual(v.author, { name: "講師ビー", isInstructor: true });
  });

  it("無効化された受講生は name: null", () => {
    const v = toCommentThreadView(row({ user: { name: "受講生エー", role: "STUDENT", deactivatedAt: at } }), "stu_b");
    assert.deepEqual(v.author, { name: null, isInstructor: false });
  });

  it("講師は deactivatedAt があっても名前を出す（講師は無効化の対象外）", () => {
    const v = toCommentThreadView(row({ user: { name: "講師ビー", role: "INSTRUCTOR", deactivatedAt: at } }), "stu_a");
    assert.deepEqual(v.author, { name: "講師ビー", isInstructor: true });
  });

  it("返信を順序どおり変換し、返信にも同じ規則を当てる", () => {
    const v = toCommentThreadView(
      row({
        replies: [
          { id: "r1", content: "回答", createdAt: new Date("2026-10-01T10:00:00.000Z"), userId: "ins_1", user: { name: "講師ビー", role: "INSTRUCTOR", deactivatedAt: null } },
          { id: "r2", content: "追記", createdAt: new Date("2026-10-01T11:00:00.000Z"), userId: "stu_c", user: { name: "受講生シー", role: "STUDENT", deactivatedAt: at } },
        ],
      }),
      "stu_c"
    );
    assert.deepEqual(v.replies.map((r) => [r.id, r.author.name, r.author.isInstructor, r.mine]), [
      ["r1", "講師ビー", true, false],
      ["r2", null, false, true],
    ]);
    for (const r of v.replies) assert.equal("replies" in r, false);
  });

  it("userId・email・avatar・role・deactivatedAt を返さない", () => {
    const withExtra = {
      ...row(),
      user: { name: "受講生エー", role: "STUDENT", deactivatedAt: null, email: "student@example.com", avatar: "a.png", id: "stu_a" },
    } as CommentThreadRow;
    const text = JSON.stringify(toCommentThreadView(withExtra, "stu_a"));
    for (const k of ["userId", "email", "avatar", "role", "deactivatedAt", "stu_a", "example.com"]) {
      assert.doesNotMatch(text, new RegExp(k));
    }
  });
});

describe("toCommentItems", () => {
  const NOW = new Date("2026-10-06T12:00:00.000Z");
  const base = { content: "本文", createdAt: "2026-10-06T09:00:00.000Z", author: { name: "受講生エー", isInstructor: false }, mine: false, replies: [] };

  it("名前・頭文字・講師・相対時刻・本文・mine を作る", () => {
    const got = toCommentItems([{ ...base, id: "c1", mine: true }], NOW);
    assert.deepEqual(got, [
      { id: "c1", name: "受講生エー", initial: "受", isInstructor: false, time: "3時間前", content: "本文", mine: true, replies: [] },
    ]);
  });

  it("name: null（無効化された受講生）は「受講生」で頭文字 null", () => {
    const [x] = toCommentItems([{ ...base, id: "c1", author: { name: null, isInstructor: false } }], NOW);
    assert.equal(x.name, "受講生");
    assert.equal(x.initial, null);
  });

  it("見えない文字だけの名前も「受講生」、講師なら「講師」", () => {
    const got = toCommentItems(
      [
        { ...base, id: "c1", author: { name: ZWSP, isInstructor: false } },
        { ...base, id: "c2", author: { name: HANGUL_FILLER, isInstructor: true } },
      ],
      NOW
    );
    assert.deepEqual(got.map((x) => [x.name, x.initial, x.isInstructor]), [
      ["受講生", null, false],
      ["講師", null, true],
    ]);
  });

  it("講師は名前と isInstructor、英字の頭文字は大文字", () => {
    const [x] = toCommentItems([{ ...base, id: "c1", author: { name: "bob", isInstructor: true } }], NOW);
    assert.deepEqual([x.name, x.initial, x.isInstructor], ["bob", "B", true]);
  });

  it("author がない・壊れていても名前は「受講生」", () => {
    const got = toCommentItems([{ ...base, id: "c1", author: undefined }, { ...base, id: "c2", author: "x" }], NOW);
    assert.deepEqual(got.map((x) => [x.name, x.isInstructor]), [["受講生", false], ["受講生", false]]);
  });

  it("isInstructor は true のときだけ（\"true\" や 1 は講師にしない）", () => {
    const got = toCommentItems(
      [
        { ...base, id: "c1", author: { name: "x", isInstructor: "true" } },
        { ...base, id: "c2", author: { name: "y", isInstructor: 1 } },
      ],
      NOW
    );
    assert.deepEqual(got.map((x) => x.isInstructor), [false, false]);
  });

  it("配列でない入力は []", () => {
    for (const v of [null, undefined, {}, "[]", 0]) assert.deepEqual(toCommentItems(v, NOW), []);
  });

  it("壊れた要素（非オブジェクト、id・content が文字列でない、空の id）を飛ばす", () => {
    const got = toCommentItems(
      [null, 1, "x", [], { ...base, id: 1 }, { ...base, id: "" }, { ...base, id: "c0", content: null }, { ...base, id: "ok" }],
      NOW
    );
    assert.deepEqual(got.map((x) => x.id), ["ok"]);
  });

  it("重複した id は最初の 1 件だけ（親と返信をまたいでも）", () => {
    const got = toCommentItems(
      [
        { ...base, id: "a", content: "1", replies: [{ ...base, id: "r1" }, { ...base, id: "r1" }, { ...base, id: "a" }] },
        { ...base, id: "a", content: "2" },
        { ...base, id: "b", replies: [{ ...base, id: "r1" }, { ...base, id: "r2" }] },
      ],
      NOW
    );
    assert.deepEqual(got.map((x) => [x.id, x.content, x.replies.map((r) => r.id)]), [
      ["a", "1", ["r1"]],
      ["b", "本文", ["r2"]],
    ]);
  });

  it("replies が配列でなければ []、返信の返信は読まない", () => {
    const got = toCommentItems([{ ...base, id: "a", replies: "x" }, { ...base, id: "b", replies: [{ ...base, id: "r", replies: [{ ...base, id: "rr" }] }] }], NOW);
    assert.deepEqual(got[0].replies, []);
    assert.deepEqual(Object.keys(got[1].replies[0]).sort(), ["content", "id", "initial", "isInstructor", "mine", "name", "time"]);
  });

  it("createdAt が不正なら時刻は空文字、順序は API のまま", () => {
    const got = toCommentItems([{ ...base, id: "b", createdAt: "bad" }, { ...base, id: "a", createdAt: { t: 1 } }], NOW);
    assert.deepEqual(got.map((x) => [x.id, x.time]), [["b", ""], ["a", ""]]);
  });

  it("本文の改行はそのまま", () => {
    const [x] = toCommentItems([{ ...base, id: "c1", content: "1行目\n2行目" }], NOW);
    assert.equal(x.content, "1行目\n2行目");
  });
});

describe("commentsTabLabel", () => {
  it("null は「質問」、件数は「質問 (n)」", () => {
    assert.equal(commentsTabLabel(null), "質問");
    assert.equal(commentsTabLabel(0), "質問 (0)");
    assert.equal(commentsTabLabel(3), "質問 (3)");
    assert.equal(commentsTabLabel(100), "質問 (100)");
  });

  it("負数・小数・NaN は「質問」", () => {
    for (const n of [-1, 1.5, NaN, Infinity]) assert.equal(commentsTabLabel(n), "質問");
  });
});

describe("lessonTypeLabel", () => {
  it("テキスト／動画／PDF／クイズ", () => {
    assert.equal(lessonTypeLabel("TEXT"), "テキスト");
    assert.equal(lessonTypeLabel("VIDEO"), "動画");
    assert.equal(lessonTypeLabel("PDF"), "PDF");
    assert.equal(lessonTypeLabel("QUIZ"), "クイズ");
  });

  it("未知の値・小文字・値なしは null（バッジを出さない）", () => {
    for (const v of [undefined, null, "", "text", "AUDIO", "toString", "__proto__", 1]) assert.equal(lessonTypeLabel(v), null);
  });
});

describe("safeExternalUrl", () => {
  it("http: / https: の URL はリンクにする", () => {
    assert.equal(safeExternalUrl("https://docs.google.com/document/d/abc/edit"), "https://docs.google.com/document/d/abc/edit");
    assert.equal(safeExternalUrl("http://example.com"), "http://example.com/");
  });

  for (const v of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<b>x</b>",
    "vbscript:x",
    "file:///etc/hosts",
    "ftp://example.com/a",
    "/relative/path",
    "docs.google.com/document",
    "テキストの本文",
    " https://example.com",
    "https://example.com\n",
    "",
    "https://",
  ]) {
    it(`${JSON.stringify(v)} はリンクにしない`, () => {
      assert.equal(safeExternalUrl(v), null);
    });
  }

  it("文字列でない値は null", () => {
    for (const v of [undefined, null, 1, {}, new URL("https://example.com")]) assert.equal(safeExternalUrl(v), null);
  });
});
