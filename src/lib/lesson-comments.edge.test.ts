import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMMENT_MAX_LENGTH,
  commentLength,
  isValidId,
  parseCreateComment,
  toCommentItems,
  toCommentThreadView,
  type CommentThreadRow,
} from "./lesson-comments";

// #32 lesson-comments の境界（lesson-comments.test.ts の補強）。DB・ネットワークなし。データはすべてダミー。
// 見えない文字はソースに直接書かず、String.fromCodePoint で作る。

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const ZWSP = cp(0x200b);
const ZWJ = cp(0x200d);
const RLO = cp(0x202e);
const BOM = cp(0xfeff);
const VS16 = cp(0xfe0f);
const TAG_A = cp(0xe0061);
const LONE_HIGH = String.fromCharCode(0xd800);
const COMBINING_ACUTE = cp(0x0301);
const EMOJI = cp(0x1f600);
const FAMILY = [cp(0x1f468), cp(0x1f469), cp(0x1f467)].join(ZWJ); // 5 コードポイント

const parse = (content: unknown, extra: Record<string, unknown> = {}) => parseCreateComment({ lessonId: "lesson_1", content, ...extra });
const okContent = (content: unknown) => {
  const r = parse(content);
  assert.ok(r.ok, `ok のはず: ${JSON.stringify(r).slice(0, 80)}`);
  return (r as Extract<typeof r, { ok: true }>).value.content;
};
const reasonOf = (content: unknown, extra: Record<string, unknown> = {}) => {
  const r = parse(content, extra);
  assert.ok(!r.ok, "失敗のはず");
  return (r as Extract<typeof r, { ok: false }>).reason;
};

describe("parseCreateComment：文字数の境界（コードポイント単位）", () => {
  it("あ 1999 + 絵文字 1 は 2000 文字で通る（UTF-16 の length は 2001）", () => {
    const s = `${"あ".repeat(1999)}${EMOJI}`;
    assert.equal(s.length, 2001);
    assert.equal(okContent(s), s);
  });

  it("あ 2000 + 絵文字 1 は too_long", () => {
    assert.equal(reasonOf(`${"あ".repeat(2000)}${EMOJI}`), "too_long");
  });

  it("ZWJ でつないだ家族の絵文字は 5 文字として数える（400 個で 2000、401 個で too_long）", () => {
    assert.equal(commentLength(FAMILY), 5);
    assert.equal(commentLength(okContent(FAMILY.repeat(400))), COMMENT_MAX_LENGTH);
    assert.equal(reasonOf(FAMILY.repeat(401)), "too_long");
  });

  it("中の LF は 1 文字（a 1998 + LF + a = 2000 で通る、a 1999 + LF + a は too_long）", () => {
    assert.equal(okContent(`${"a".repeat(1998)}\na`), `${"a".repeat(1998)}\na`);
    assert.equal(reasonOf(`${"a".repeat(1999)}\na`), "too_long");
  });

  it("中の CRLF は 2 文字（a 1997 + CRLF + a = 2000 で通る、a 1998 + CRLF + a は too_long）。CRLF は LF に変えない", () => {
    assert.equal(okContent(`${"a".repeat(1997)}\r\na`), `${"a".repeat(1997)}\r\na`);
    assert.equal(reasonOf(`${"a".repeat(1998)}\r\na`), "too_long");
  });

  it("前後の CRLF・タブ・全角空白は数えない", () => {
    const body = "a".repeat(2000);
    assert.equal(okContent(`\r\n\t${cp(0x3000)}${body}\r\n\r\n`), body);
  });

  it("BOM は前後の空白として除く", () => {
    assert.equal(okContent(`${BOM}質問${BOM}`), "質問");
  });

  it("前後のゼロ幅スペースは trim で除かれず、本文に残って文字数にも入る", () => {
    assert.equal(okContent(`${ZWSP}質問`), `${ZWSP}質問`);
    assert.equal(reasonOf(`${ZWSP}${"a".repeat(2000)}`), "too_long");
  });

  it("2001 文字でも見える文字がなければ too_long ではなく empty", () => {
    assert.equal(reasonOf(ZWSP.repeat(2001)), "empty");
  });
});

describe("parseCreateComment：見えない文字だけは empty", () => {
  for (const [label, s] of [
    ["ZWJ だけ", ZWJ.repeat(3)],
    ["異体字セレクタだけ", VS16],
    ["タグ文字だけ", TAG_A],
    ["対になっていないサロゲートだけ", LONE_HIGH],
    ["結合文字だけ（複数）", COMBINING_ACUTE.repeat(5)],
    ["RLO と改行", `${RLO}\r\n${RLO}`],
  ] as Array<[string, string]>) {
    it(label, () => {
      assert.equal(reasonOf(s), "empty");
    });
  }

  it("見える文字があれば、対になっていないサロゲートや RLO を含んでも通る（本文は変えない）", () => {
    assert.equal(okContent(`a${LONE_HIGH}`), `a${LONE_HIGH}`);
    assert.equal(okContent(`${RLO}abc`), `${RLO}abc`);
  });
});

describe("parseCreateComment：検証の順序", () => {
  it("lessonId → content → parentId の順で最初の失敗を返す", () => {
    assert.equal(parseCreateComment({ lessonId: "", content: 1, parentId: 1 }).ok, false);
    assert.equal((parseCreateComment({ lessonId: "", content: 1, parentId: 1 }) as { reason: string }).reason, "invalid_lesson_id");
    assert.equal(reasonOf(1, { parentId: 1 }), "invalid_content");
    assert.equal(reasonOf("", { parentId: 1 }), "empty");
    assert.equal(reasonOf("a".repeat(2001), { parentId: 1 }), "too_long");
    assert.equal(reasonOf("質問", { parentId: 1 }), "invalid_parent_id");
  });

  it("Object.create(null) の body も読める", () => {
    const body = Object.assign(Object.create(null), { lessonId: "lesson_1", content: "質問" });
    assert.equal(parseCreateComment(body).ok, true);
  });

  it("JSON の __proto__ キーで lessonId を差し込めない", () => {
    const body = JSON.parse('{"__proto__": {"lessonId": "lesson_x"}, "content": "質問"}');
    assert.equal((parseCreateComment(body) as { reason: string }).reason, "invalid_lesson_id");
  });
});

describe("isValidId", () => {
  it("UTF-16 の length で数える（絵文字 32 個 = 64 は通る、33 個 = 66 は通らない）", () => {
    assert.equal(isValidId(EMOJI.repeat(32)), true);
    assert.equal(isValidId(EMOJI.repeat(33)), false);
  });

  it("String オブジェクト・数値は通らない", () => {
    assert.equal(isValidId(new String("c1")), false);
    assert.equal(isValidId(1), false);
  });
});

describe("toCommentThreadView：境界", () => {
  const row: CommentThreadRow = {
    id: "c1",
    content: "質問",
    createdAt: new Date("2026-10-01T09:00:00.000Z"),
    userId: "stu_a",
    user: { name: "受講生エー", role: "STUDENT", deactivatedAt: null },
  };

  it("replies がなければ []", () => {
    assert.deepEqual(toCommentThreadView(row, "stu_a").replies, []);
  });

  it("role が小文字の instructor は講師にしない（完全一致）", () => {
    assert.equal(toCommentThreadView({ ...row, user: { ...row.user, role: "instructor" } }, "x").author.isInstructor, false);
  });

  it("viewerId が空文字・undefined でも userId が空でなければ mine にならない", () => {
    assert.equal(toCommentThreadView(row, "").mine, false);
    assert.equal(toCommentThreadView(row, undefined as unknown as string).mine, false);
  });

  it("無効化された受講生の名前は、返信・親のどちらにも残らない", () => {
    const gone = { name: "受講生ゴーン", role: "STUDENT", deactivatedAt: new Date(0) };
    const v = toCommentThreadView({ ...row, user: gone, replies: [{ ...row, id: "r1", user: gone }] }, "x");
    assert.doesNotMatch(JSON.stringify(v), /ゴーン/);
  });
});

describe("toCommentItems：境界", () => {
  const NOW = new Date("2026-10-06T12:00:00.000Z");
  const base = { content: "本文", createdAt: "2026-10-06T11:59:30.000Z", author: { name: "受講生エー", isInstructor: false }, mine: false };

  it("名前の制御文字（RLO・ゼロ幅）は表示から除く", () => {
    const [x] = toCommentItems([{ ...base, id: "c1", author: { name: `${RLO}ab${ZWSP}c`, isInstructor: false } }], NOW);
    assert.equal(x.name, "abc");
    assert.equal(x.initial, "A");
  });

  it("mine は true のときだけ（\"true\"・1 は false）", () => {
    const got = toCommentItems([{ ...base, id: "a", mine: "true" }, { ...base, id: "b", mine: 1 }, { ...base, id: "c", mine: true }], NOW);
    assert.deepEqual(got.map((x) => x.mine), [false, false, true]);
  });

  it("1 分未満・未来の時刻は「たった今」", () => {
    const got = toCommentItems([{ ...base, id: "a" }, { ...base, id: "b", createdAt: "2026-10-06T13:00:00.000Z" }], NOW);
    assert.deepEqual(got.map((x) => x.time), ["たった今", "たった今"]);
  });

  it("件数（タブの数）は親の質問だけ。返信は数えない", () => {
    const got = toCommentItems([{ ...base, id: "a", replies: [{ ...base, id: "r1" }, { ...base, id: "r2" }] }], NOW);
    assert.equal(got.length, 1);
    assert.equal(got[0].replies.length, 2);
  });

  it("返信と同じ id の親が後ろにあれば、親を優先して返信を捨てる（key の重複を出さない）", () => {
    const got = toCommentItems([{ ...base, id: "a", replies: [{ ...base, id: "b" }] }, { ...base, id: "b" }], NOW);
    assert.deepEqual(got.map((x) => [x.id, x.replies.map((r) => r.id)]), [["a", []], ["b", []]]);
  });
});

describe("見えない文字", () => {
  it("このファイルのソースに見えない文字（ゼロ幅・双方向制御・結合文字など）を直接書いていない", () => {
    const text = readFileSync(__filename, "utf8");
    assert.doesNotMatch(text, new RegExp("[\\u0300-\\u036F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\uFE0F\\u3164\\u00A0]|[\\u{E0000}-\\u{E007F}]", "u"));
  });
});
