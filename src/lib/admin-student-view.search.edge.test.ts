import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_VALUE_LABEL,
  STUDENTS_EMPTY_MESSAGE,
  STUDENTS_NO_MATCH_MESSAGE,
  filterStudentsByQuery,
  formatJstDate,
  normalizeSearchText,
  studentsEmptyMessage,
  toAdminStudentListItem,
  type AdminStudentApiRow,
} from "./admin-student-view";

// #32 生徒管理の検索・最終学習日の境界。データはすべてダミー（example.com）。
// 見えない文字は \u エスケープで書く。

const rows = [
  { id: "s1", name: "やまだ 花子", email: "hanako-32@example.com" },
  { id: "s2", name: "Suzuki Ichiro", email: "ICHIRO-32@Example.com" },
  { id: "s3", name: "がっこう\u3000太郎", email: "taro+tag-32@example.com" },
  { id: "s4", name: "a.b(c)*[d]", email: "regex-32@example.com" },
];
const ids = (q: string) => filterStudentsByQuery(rows, q).map((s) => s.id);

describe("filterStudentsByQuery：正規表現の特殊文字は文字どおりに比べる", () => {
  for (const q of [".", "(", ")", "*", "[", "]", "+", "?", "^", "$", "|", "\\", "{", "}"]) {
    it(`「${q}」で例外にならず、その文字を含む行だけ`, () => {
      const expected = rows.filter((r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)).map((r) => r.id);
      assert.deepEqual(ids(q), expected);
    });
  }

  it("「.」はどの 1 文字にも一致しない（メールのドットには一致する）", () => {
    assert.deepEqual(ids("a.b"), ["s4"]);
    assert.deepEqual(ids("(c)*"), ["s4"]);
    assert.deepEqual(ids(".*"), []);
  });

  it("メールの + や @ を含む部分一致", () => {
    assert.deepEqual(ids("+tag"), ["s3"]);
    assert.deepEqual(ids("TARO+TAG-32@"), ["s3"]);
  });
});

describe("filterStudentsByQuery：空白・見えない文字・NFKC", () => {
  it("前後の全角空白・NBSP・BOM・改行・タブは除いて比べる", () => {
    for (const q of ["\u3000花子\u3000", "\u00A0花子\u00A0", "\uFEFF花子", "\n花子\t", "\u2028花子\u2029"]) {
      assert.deepEqual(ids(q), ["s1"], JSON.stringify(q));
    }
  });

  it("全角空白・BOM・NBSP だけの検索語は空とみなし、全件", () => {
    for (const q of ["\u3000\u3000", "\uFEFF", "\u00A0 \u3000", "\t\n"]) {
      assert.deepEqual(ids(q), ["s1", "s2", "s3", "s4"], JSON.stringify(q));
    }
  });

  it("名前の中の全角空白は、半角空白の検索語でも一致する（NFKC）", () => {
    assert.deepEqual(ids("がっこう 太郎"), ["s3"]);
    assert.deepEqual(ids("やまだ\u3000花子"), ["s1"]);
  });

  it("濁点が分かれた入力（か + 結合用濁点）も一致する（NFKC で合成）", () => {
    assert.deepEqual(ids("か\u3099っこう"), ["s3"]);
    const decomposed = [{ id: "d", name: "か\u3099っこう", email: "d-32@example.com" }];
    assert.deepEqual(filterStudentsByQuery(decomposed, "がっこう").map((s) => s.id), ["d"]);
  });

  it("全角英数・半角カナ・大文字小文字を区別しない", () => {
    assert.deepEqual(ids("ｓｕｚｕｋｉ"), ["s2"]);
    assert.deepEqual(ids("ICHIRO-32@EXAMPLE.COM"), ["s2"]);
    const kana = [{ id: "k", name: "ヤマダ", email: "k-32@example.com" }];
    assert.deepEqual(filterStudentsByQuery(kana, "ﾔﾏﾀﾞ").map((s) => s.id), ["k"]);
  });

  it("名前とメールをつなげた文字列では一致しない（それぞれ別に比べる）", () => {
    assert.deepEqual(ids("ichirohanako"), []);
    assert.deepEqual(ids("Ichiroichiro"), []);
  });

  it("検索語が空のときの空表示：空白・見えない空白だけなら「受講生はまだいません」", () => {
    assert.equal(studentsEmptyMessage(0, "\u3000\uFEFF"), STUDENTS_EMPTY_MESSAGE);
    assert.equal(studentsEmptyMessage(0, "\u3000x"), STUDENTS_NO_MATCH_MESSAGE);
  });

  it("U+200B などの幅のない文字・書式文字だけの検索語は空とみなし、全件", () => {
    for (const q of ["\u200B", "\u200B\u200C\u200D", "\u2060\u202E\u00AD", " \u200B\u3000"]) {
      assert.deepEqual(ids(q), ["s1", "s2", "s3", "s4"], JSON.stringify(q));
    }
    assert.equal(studentsEmptyMessage(0, "\u200B"), STUDENTS_EMPTY_MESSAGE);
  });

  it("名前に幅のない文字・向きの制御文字・ZWJ が混ざっていても「田中花子」で見つかる", () => {
    const hidden = [
      { id: "z1", name: "田中\u200B花子", email: "z1-32@example.com" },
      { id: "z2", name: "\u202E田\u200C中\u2060花\uFEFF子\u202C", email: "z2-32@example.com" },
      { id: "z3", name: "田中\u200D花子", email: "z3-32@example.com" },
      { id: "z4", name: "田中\u00AD花子", email: "z4-32@example.com" },
      { id: "other", name: "田中太郎", email: "other-32@example.com" },
    ];
    assert.deepEqual(filterStudentsByQuery(hidden, "田中花子").map((s) => s.id), ["z1", "z2", "z3", "z4"]);
  });

  it("検索語の中の幅のない文字も除く（メールも同じ）", () => {
    assert.deepEqual(ids("花\u200B子"), ["s1"]);
    assert.deepEqual(ids("hana\u200Bko-32"), ["s1"]);
    const mail = [{ id: "m", name: "ダミー", email: "zw\u200Bsp-32@example.com" }];
    assert.deepEqual(filterStudentsByQuery(mail, "zwsp-32@").map((s) => s.id), ["m"]);
  });

  it("絵文字をつなぐ ZWJ と旗のタグ文字は残す（絵文字の検索は壊さない）", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
    const thumbs = "\u{1F44D}\u{1F3FD}\u200D\u2642\uFE0F";
    assert.equal(normalizeSearchText(family), family);
    assert.equal(normalizeSearchText(scotland), scotland);
    assert.equal(normalizeSearchText(thumbs), thumbs);
    const rowsE = [
      { id: "e1", name: `${family} ダミー`, email: "e1-32@example.com" },
      { id: "e2", name: `${scotland} ダミー`, email: "e2-32@example.com" },
      { id: "e3", name: "\u{1F468} ダミー", email: "e3-32@example.com" },
    ];
    assert.deepEqual(filterStudentsByQuery(rowsE, family).map((s) => s.id), ["e1"]);
    assert.deepEqual(filterStudentsByQuery(rowsE, scotland).map((s) => s.id), ["e2"]);
  });

  it("連続した空白（半角・全角・タブ・改行・NBSP）は 1 つにまとめる", () => {
    assert.equal(normalizeSearchText("やまだ  \u3000\t\n\u00A0花子"), "やまだ 花子");
    assert.equal(normalizeSearchText("Suzuki\u3000\u3000Ichiro"), "suzuki ichiro");
  });

  it("見えない文字をはさんだ空白も 1 つにまとめる（まとめた後に見えない文字を除いても空白が 2 つ残らない）", () => {
    assert.equal(normalizeSearchText("やまだ \u200B 花子"), "やまだ 花子");
    assert.equal(normalizeSearchText("やまだ\u3000\uFEFF\u3000花子"), "やまだ 花子");
  });

  it("BOM（U+FEFF）は空白にせず除く（\\s に含まれるが見えない文字として扱う）", () => {
    assert.equal(normalizeSearchText("田中\uFEFF花子"), "田中花子");
    assert.equal(normalizeSearchText("\uFEFF田中 \uFEFF花子"), "田中 花子");
  });

  it("名前の空白が 1 つでも、検索語の空白が複数（またはその逆）でも一致する", () => {
    assert.deepEqual(ids("やまだ\u3000\u3000 花子"), ["s1"]);
    assert.deepEqual(ids("suzuki  ichiro"), ["s2"]);
    const rowsW = [{ id: "w1", name: "やまだ \t\u3000 花子", email: "w1-32@example.com" }];
    assert.deepEqual(filterStudentsByQuery(rowsW, "やまだ 花子").map((s) => s.id), ["w1"]);
  });

  it("normalizeSearchText は冪等", () => {
    for (const s of ["\u3000ＡＢＣ\u3000", "ﾔﾏﾀﾞ", "か\u3099", "Mixed Case", "田\u200B中\u200D花子", "\u{1F468}\u200D\u{1F469}", "a \u200B \t b"]) {
      assert.equal(normalizeSearchText(normalizeSearchText(s)), normalizeSearchText(s));
    }
  });
});

describe("最終学習日（日本時間の日付境界）", () => {
  it("UTC 14:59:59.999 は同じ日、15:00 は翌日", () => {
    assert.equal(formatJstDate("2026-09-30T14:59:59.999Z"), "2026/09/30");
    assert.equal(formatJstDate("2026-09-30T15:00:00.000Z"), "2026/10/01");
  });

  it("年をまたぐ・うるう日", () => {
    assert.equal(formatJstDate("2026-12-31T14:59:59.999Z"), "2026/12/31");
    assert.equal(formatJstDate("2026-12-31T15:00:00.000Z"), "2027/01/01");
    assert.equal(formatJstDate("2028-02-28T15:00:00.000Z"), "2028/02/29");
  });

  it("タイムゾーン付きの文字列も日本時間に直す", () => {
    assert.equal(formatJstDate("2026-10-01T00:30:00+09:00"), "2026/10/01");
    assert.equal(formatJstDate("2026-09-30T23:59:00-05:00"), "2026/10/01");
  });

  it("null・空・解釈できない値は空文字", () => {
    for (const v of [null, "", "not-a-date", "2026-13-40"]) assert.equal(formatJstDate(v), "", JSON.stringify(v));
  });

  const base: AdminStudentApiRow = {
    id: "s1",
    name: "ダミー",
    email: "dummy-32@example.com",
    completedLessons: 0,
    totalLessons: 0,
    lastActive: null,
    status: "active",
    deactivatedAt: null,
    currentCourse: null,
  };

  it("表の行：最終学習日が解釈できない・ないときは「—」、境界は日本時間", () => {
    assert.equal(toAdminStudentListItem({ ...base, lastActive: "bad" }).last, EMPTY_VALUE_LABEL);
    assert.equal(toAdminStudentListItem({ ...base, lastActive: "2026-09-30T14:59:59.999Z" }).last, "2026/09/30");
    assert.equal(toAdminStudentListItem({ ...base, lastActive: "2026-09-30T15:00:00.000Z" }).last, "2026/10/01");
  });

  it("表の行：レッスンが 0 件で currentCourse が null なら Course 列は「—」（全コース修了ではない）", () => {
    assert.equal(toAdminStudentListItem(base).course, EMPTY_VALUE_LABEL);
    assert.equal(toAdminStudentListItem({ ...base, totalLessons: 3, completedLessons: 3 }).course, "全コース修了");
  });

  it("表の行：未知の status は有効として扱い、余計な項目（avatar・createdAt など）を持たない", () => {
    const item = toAdminStudentListItem({ ...base, status: "weird", avatar: "a.png", createdAt: "2026-04-01T00:00:00.000Z" } as AdminStudentApiRow);
    assert.equal(item.status, "active");
    assert.deepEqual(Object.keys(item).sort(), ["course", "deactivatedAt", "email", "id", "last", "name", "progress", "progressStatus", "status"]);
  });
});
