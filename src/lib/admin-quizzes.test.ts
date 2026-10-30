import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CHANGED_FIELD_ORDER,
  MAX_OPTIONS,
  OPTION_MAX_LENGTH,
  PATCH_QUESTION_FIELDS,
  QUESTION_MAX_LENGTH,
  REVISION_PATTERN,
  adminQuizStatus,
  buildAdminQuizDetail,
  buildAdminQuizList,
  optionDuplicateKey,
  parsePatchQuestionBody,
  patchQuestionResponse,
  planQuestionEdit,
  questionUpdatedLogMessage,
  revisionSource,
  toAdminQuizQuestion,
  type AdminQuizDetailRow,
  type AdminQuizListRow,
  type QuestionContent,
} from "./admin-quizzes";
import { questionRevision } from "./admin-quiz-revision";
import { MIN_OPTIONS } from "./student-quizzes";

// #81 Q1 クイズ管理 API の純粋関数（入力の検証・応答の組み立て・revision・変わった項目の判定）。
// DB・ネットワークなし。データはすべてダミー。

const REV = "a".repeat(64);
const ok2 = ["ダミーA", "ダミーB"];

// ───────────── revision ─────────────

describe("questionRevision（内容の sha256）", () => {
  const base: QuestionContent = { question: "ダミー問", options: ["ダミーA", "ダミーB", "ダミーC"], correctIndex: 1 };

  it("16 進 64 字で、REVISION_PATTERN に合う", () => {
    const r = questionRevision(base);
    assert.match(r, /^[0-9a-f]{64}$/);
    assert.ok(REVISION_PATTERN.test(r), "REVISION_PATTERN に合わない");
  });

  it("同じ内容なら同じ値（決定的）。別のオブジェクト・別の配列でも同じ", () => {
    assert.equal(questionRevision(base), questionRevision({ question: "ダミー問", options: [...(base.options as string[])], correctIndex: 1 }));
  });

  it("revisionSource の sha256 と一致する（秘密の鍵を使わない）", () => {
    assert.equal(questionRevision(base), createHash("sha256").update(revisionSource(base), "utf8").digest("hex"));
  });

  it("問題文・選択肢の文・選択肢の並び・選択肢の数・正解のどれが変わっても値が変わる", () => {
    const r0 = questionRevision(base);
    const variants: Array<[string, QuestionContent]> = [
      ["問題文", { ...base, question: "ダミー問2" }],
      ["選択肢の文", { ...base, options: ["ダミーA", "ダミーB", "ダミーD"] }],
      ["選択肢の並び", { ...base, options: ["ダミーB", "ダミーA", "ダミーC"] }],
      ["選択肢の数", { ...base, options: ["ダミーA", "ダミーB"] }],
      ["正解", { ...base, correctIndex: 2 }],
      ["壊れた options", { ...base, options: { a: 1 } }],
      ["options が null", { ...base, options: null }],
    ];
    const seen = new Set([r0]);
    for (const [label, v] of variants) {
      const r = questionRevision(v);
      assert.ok(!seen.has(r), `${label}を変えても revision が変わらない（または別の変更と衝突）`);
      seen.add(r);
    }
  });

  it("区切りの紛れがない（問題文の末尾と選択肢の先頭を入れ替えても別の値）", () => {
    const a = questionRevision({ question: "ab", options: ["c", "d"], correctIndex: 0 });
    const b = questionRevision({ question: "a", options: ["bc", "d"], correctIndex: 0 });
    assert.notEqual(a, b, "内容の区切りが紛れている");
  });
});

// ───────────── 状態 ─────────────

describe("adminQuizStatus", () => {
  it("受験できてコースがあれば ok", () => {
    assert.equal(adminQuizStatus([{ options: ok2, correctIndex: 0 }], true), "ok");
  });
  it("問題 0 件・壊れた options・範囲外の正解は unavailable（コースがあってもなくても）", () => {
    for (const hasCourse of [true, false]) {
      assert.equal(adminQuizStatus([], hasCourse), "unavailable");
      assert.equal(adminQuizStatus([{ options: ["1つだけ"], correctIndex: 0 }], hasCourse), "unavailable");
      assert.equal(adminQuizStatus([{ options: ok2, correctIndex: 2 }], hasCourse), "unavailable");
      assert.equal(adminQuizStatus([{ options: ok2, correctIndex: 0 }, { options: "x", correctIndex: 0 }], hasCourse), "unavailable");
    }
  });
  it("受験できるがコースがなければ no_course", () => {
    assert.equal(adminQuizStatus([{ options: ok2, correctIndex: 1 }], false), "no_course");
  });
});

// ───────────── 一覧 ─────────────

function listRow(p: Partial<AdminQuizListRow> & Pick<AdminQuizListRow, "id" | "type">): AdminQuizListRow {
  return {
    title: `ダミー${p.id}`,
    courseId: null,
    lesson: null,
    questions: [{ options: ok2, correctIndex: 0 }],
    _count: { attempts: 0 },
    ...p,
  };
}

function lesson(id: string, order: number, sectionId: string, sectionOrder: number, courseId: string) {
  return { id, title: `レッスン${id}`, order, section: { id: sectionId, order: sectionOrder, courseId } };
}

describe("buildAdminQuizList", () => {
  const courses = [
    { id: "c1", name: "STEP1 ダミー" },
    { id: "c2", name: "STEP2 ダミー" },
  ];

  it("コース順 → 修了テスト（タイトル・id 順）→ ミニテスト（セクション・レッスン順）→ コースなしは最後", () => {
    const quizzes: AdminQuizListRow[] = [
      listRow({ id: "orphan_mini", type: "MINI", title: "A" }),
      listRow({ id: "m_c2", type: "MINI", lesson: lesson("l21", 1, "s21", 1, "c2") }),
      listRow({ id: "f_c1_b", type: "FINAL", courseId: "c1", title: "B" }),
      listRow({ id: "m_c1_s2", type: "MINI", lesson: lesson("l3", 1, "s2", 2, "c1") }),
      listRow({ id: "m_c1_s1_l2", type: "MINI", lesson: lesson("l2", 2, "s1", 1, "c1") }),
      listRow({ id: "m_c1_s1_l1", type: "MINI", lesson: lesson("l1", 1, "s1", 1, "c1") }),
      listRow({ id: "f_c1_a2", type: "FINAL", courseId: "c1", title: "A" }),
      listRow({ id: "f_c1_a1", type: "FINAL", courseId: "c1", title: "A" }),
      listRow({ id: "orphan_final_gone", type: "FINAL", courseId: "c_gone", title: "Z" }),
      listRow({ id: "orphan_final_null", type: "FINAL", courseId: null, title: "Y" }),
      listRow({ id: "f_c2", type: "FINAL", courseId: "c2" }),
    ];
    const out = buildAdminQuizList(courses, quizzes);
    assert.deepEqual(out.map((q) => q.id), [
      "f_c1_a1",
      "f_c1_a2",
      "f_c1_b",
      "m_c1_s1_l1",
      "m_c1_s1_l2",
      "m_c1_s2",
      "f_c2",
      "m_c2",
      "orphan_final_null",
      "orphan_final_gone",
      "orphan_mini",
    ]);
  });

  it("同じ order のセクション・レッスンは id で決める", () => {
    const out = buildAdminQuizList(courses, [
      listRow({ id: "q_s_b", type: "MINI", lesson: lesson("l9", 1, "s_b", 1, "c1") }),
      listRow({ id: "q_s_a_l_b", type: "MINI", lesson: lesson("l_b", 1, "s_a", 1, "c1") }),
      listRow({ id: "q_s_a_l_a", type: "MINI", lesson: lesson("l_a", 1, "s_a", 1, "c1") }),
    ]);
    assert.deepEqual(out.map((q) => q.id), ["q_s_a_l_a", "q_s_a_l_b", "q_s_b"]);
  });

  it("ミニテストのコースは lesson.section.courseId（Quiz.courseId は見ない）、修了テストは courseId（lesson は見ない）", () => {
    const out = buildAdminQuizList(courses, [
      listRow({ id: "m", type: "MINI", courseId: "c1", lesson: lesson("l21", 1, "s21", 1, "c2") }),
      listRow({ id: "f", type: "FINAL", courseId: "c1", lesson: lesson("l21", 1, "s21", 1, "c2") }),
    ]);
    const byId = new Map(out.map((q) => [q.id, q]));
    assert.equal(byId.get("m")?.courseId, "c2");
    assert.equal(byId.get("f")?.courseId, "c1");
    assert.equal(byId.get("f")?.lessonTitle, null, "修了テストに lessonTitle を付けた");
    assert.equal(byId.get("m")?.lessonTitle, "レッスンl21");
  });

  it("状態・件数・コース名を付け、項目は許可リストだけ（選択肢・正解・_count を出さない）", () => {
    const out = buildAdminQuizList(courses, [
      listRow({ id: "ok", type: "FINAL", courseId: "c1", questions: [{ options: ok2, correctIndex: 1 }, { options: ok2, correctIndex: 0 }], _count: { attempts: 7 } }),
      listRow({ id: "broken", type: "FINAL", courseId: "c1", questions: [{ options: ["正解のダミー"], correctIndex: 0 }] }),
      listRow({ id: "empty", type: "FINAL", courseId: "c1", questions: [] }),
      listRow({ id: "nocourse", type: "FINAL", courseId: null }),
      listRow({ id: "gone", type: "FINAL", courseId: "c_gone" }),
    ]);
    const byId = new Map(out.map((q) => [q.id, q]));
    assert.deepEqual(byId.get("ok"), {
      id: "ok",
      title: "ダミーok",
      type: "FINAL",
      courseId: "c1",
      courseName: "STEP1 ダミー",
      lessonTitle: null,
      questionCount: 2,
      attemptCount: 7,
      status: "ok",
    });
    assert.equal(byId.get("broken")?.status, "unavailable");
    assert.equal(byId.get("empty")?.status, "unavailable");
    assert.equal(byId.get("empty")?.questionCount, 0);
    assert.equal(byId.get("nocourse")?.status, "no_course");
    assert.deepEqual([byId.get("gone")?.status, byId.get("gone")?.courseId, byId.get("gone")?.courseName], ["no_course", null, null]);
    for (const q of out) {
      assert.deepEqual(
        Object.keys(q).sort(),
        ["attemptCount", "courseId", "courseName", "id", "lessonTitle", "questionCount", "status", "title", "type"],
        `${q.id} の項目が許可リストと違う`
      );
    }
    assert.ok(!JSON.stringify(out).includes("正解のダミー"), "一覧に選択肢の文が含まれる");
    assert.ok(!JSON.stringify(out).includes("correctIndex"), "一覧に correctIndex が含まれる");
  });

  it("クイズがなければ空配列。コースが重複していても 1 回だけ並べる", () => {
    assert.deepEqual(buildAdminQuizList(courses, []), []);
    const out = buildAdminQuizList([...courses, courses[0]], [listRow({ id: "f", type: "FINAL", courseId: "c1" })]);
    assert.deepEqual(out.map((q) => q.id), ["f"]);
  });
});

// ───────────── 詳細 ─────────────

describe("toAdminQuizQuestion / buildAdminQuizDetail", () => {
  const quiz: AdminQuizDetailRow = {
    id: "qz1",
    title: "ダミーミニ",
    type: "MINI",
    courseId: null,
    lesson: { title: "ダミーレッスン", section: { courseId: "c1" } },
    questions: [
      { id: "q_b", order: 2, question: "問B", options: ["x", "y"], correctIndex: 1 },
      { id: "q_a2", order: 1, question: "問A2", options: ["x", "y", "z"], correctIndex: 5 },
      { id: "q_a1", order: 1, question: "問A1", options: ["z", "y", "x"], correctIndex: 0 },
    ],
    _count: { attempts: 3 },
  };

  it("問題は [order, id] の順、選択肢は元の並び。valid と revision を付ける", () => {
    const d = buildAdminQuizDetail(quiz, "STEP1 ダミー", questionRevision);
    assert.deepEqual(d.questions.map((q) => q.id), ["q_a1", "q_a2", "q_b"]);
    assert.deepEqual(d.questions[0].options, ["z", "y", "x"], "選択肢の並びが変わった");
    assert.deepEqual(d.questions.map((q) => q.valid), [true, false, true]);
    for (const q of d.questions) {
      const row = quiz.questions.find((r) => r.id === q.id)!;
      assert.equal(q.revision, questionRevision(row), `${q.id} の revision が内容の sha256 でない`);
    }
    assert.equal(d.status, "unavailable", "範囲外の正解を含むのに unavailable でない");
    assert.deepEqual(
      { id: d.id, title: d.title, type: d.type, courseName: d.courseName, lessonTitle: d.lessonTitle, attemptCount: d.attemptCount },
      { id: "qz1", title: "ダミーミニ", type: "MINI", courseName: "STEP1 ダミー", lessonTitle: "ダミーレッスン", attemptCount: 3 }
    );
    assert.deepEqual(Object.keys(d).sort(), ["attemptCount", "courseName", "id", "lessonTitle", "questions", "status", "title", "type"]);
    for (const q of d.questions) {
      assert.deepEqual(Object.keys(q).sort(), ["correctIndex", "id", "options", "order", "question", "revision", "valid"], `${q.id} の項目が許可リストと違う`);
    }
  });

  it("コース名がなければ no_course（受験できる場合）。修了テストには lessonTitle を付けない", () => {
    const d = buildAdminQuizDetail(
      { ...quiz, type: "FINAL", courseId: "c_gone", questions: [{ id: "q", order: 1, question: "問", options: ok2, correctIndex: 0 }] },
      null,
      questionRevision
    );
    assert.equal(d.status, "no_course");
    assert.equal(d.lessonTitle, null);
    assert.equal(d.courseName, null);
  });

  it("壊れた options は null・valid false（行の余計な項目は出さない）", () => {
    const q = toAdminQuizQuestion({ id: "q", order: 1, question: "問", options: "壊れた", correctIndex: 0, quizId: "secret" } as never, REV);
    assert.equal(q.options, null);
    assert.equal(q.valid, false);
    assert.equal(q.revision, REV);
    assert.ok(!("quizId" in q), "行の quizId をそのまま出した");
  });

  it("問題 0 件のクイズは unavailable で questions は空", () => {
    const d = buildAdminQuizDetail({ ...quiz, questions: [] }, "STEP1 ダミー", questionRevision);
    assert.equal(d.status, "unavailable");
    assert.deepEqual(d.questions, []);
  });
});

// ───────────── PATCH の body ─────────────

describe("parsePatchQuestionBody", () => {
  const reason = (body: unknown) => {
    const r = parsePatchQuestionBody(body);
    return "reason" in r ? r.reason : null;
  };
  const value = (body: unknown) => {
    const r = parsePatchQuestionBody(body);
    assert.ok("value" in r, `検証に通らない：${JSON.stringify(body)}`);
    return r.value;
  };

  it("オブジェクトでなければ invalid_json", () => {
    for (const b of [null, [], "x", 1, true]) assert.equal(reason(b), "invalid_json", JSON.stringify(b));
  });

  it("許可していない項目（order・quizId・id など）は unknown_field（黙って無視しない）", () => {
    for (const k of ["order", "quizId", "id", "valid", "question_", "Question"]) {
      assert.equal(reason({ revision: REV, question: "問", [k]: 1 }), "unknown_field", k);
    }
    assert.deepEqual([...PATCH_QUESTION_FIELDS].sort(), ["correctIndex", "options", "question", "revision"]);
  });

  it("revision がない・形が違えば invalid_revision", () => {
    for (const r of [undefined, null, "", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), 1]) {
      const body: Record<string, unknown> = { question: "問" };
      if (r !== undefined) body.revision = r;
      assert.equal(reason(body), "invalid_revision", JSON.stringify(r));
    }
  });

  it("問題文：前後の空白を除いて 1〜1000 字。空白だけ・見えない文字だけ・1001 字・文字列以外は invalid_question", () => {
    assert.equal(value({ revision: REV, question: "  問  " }).question, "問", "前後の空白を除いていない");
    assert.equal(value({ revision: REV, question: "あ".repeat(QUESTION_MAX_LENGTH) }).question?.length, QUESTION_MAX_LENGTH);
    assert.equal(value({ revision: REV, question: ` ${"あ".repeat(QUESTION_MAX_LENGTH)} ` }).question?.length, QUESTION_MAX_LENGTH, "空白を除く前の長さで数えている");
    // サロゲートペア（絵文字）は 1 文字として数える
    assert.ok("value" in parsePatchQuestionBody({ revision: REV, question: "\u{1F600}".repeat(QUESTION_MAX_LENGTH) }), "絵文字を 2 文字として数えた");
    for (const q of ["", "   ", "\n\t", "\u200B", "\u200B\u200B", "あ".repeat(QUESTION_MAX_LENGTH + 1), null, 1, ["問"]]) {
      assert.equal(reason({ revision: REV, question: q }), "invalid_question", JSON.stringify(q));
    }
  });

  it(`選択肢：${MIN_OPTIONS}〜${MAX_OPTIONS} 件、各 1〜${OPTION_MAX_LENGTH} 字、重複なし`, () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => `選択肢${i}`);
    assert.deepEqual(value({ revision: REV, options: n(2) }).options, n(2));
    assert.deepEqual(value({ revision: REV, options: n(10) }).options, n(10));
    assert.deepEqual(value({ revision: REV, options: [" a ", "b\n"] }).options, ["a", "b"], "前後の空白を除いていない");
    assert.equal(value({ revision: REV, options: ["あ".repeat(OPTION_MAX_LENGTH), "b"] }).options?.[0].length, OPTION_MAX_LENGTH);
    const bad: unknown[] = [
      n(1),
      n(11),
      [],
      "a,b",
      null,
      ["a", "a"],
      ["a", " a "],
      ["a", ""],
      ["a", "  "],
      ["a", "\u200B"],
      ["a", 1],
      ["a", null],
      ["a", "あ".repeat(OPTION_MAX_LENGTH + 1)],
    ];
    for (const o of bad) assert.equal(reason({ revision: REV, options: o }), "invalid_options", JSON.stringify(o));
  });

  it("正解：0 以上の整数で MAX_OPTIONS 未満。-1・小数・文字列・NaN・true は invalid_correct_index", () => {
    assert.equal(value({ revision: REV, correctIndex: 0 }).correctIndex, 0);
    assert.equal(value({ revision: REV, correctIndex: MAX_OPTIONS - 1 }).correctIndex, MAX_OPTIONS - 1);
    for (const c of [-1, 0.5, 1.0000001, "1", null, true, MAX_OPTIONS, Number.NaN, Infinity]) {
      assert.equal(reason({ revision: REV, correctIndex: c }), "invalid_correct_index", String(c));
    }
  });

  it("NUL・対になっていないサロゲートを含む問題文・選択肢は断る（Postgres が受け付けない）。対になったサロゲートは通す", () => {
    for (const q of ["問\u0000", "\u0000問", "問\uD800", "問\uDC00", "\uDC00\uD800問", "問\uD83D"]) {
      assert.equal(reason({ revision: REV, question: q }), "invalid_question", JSON.stringify(q));
      assert.equal(reason({ revision: REV, options: [q, "b"] }), "invalid_options", JSON.stringify(q));
    }
    assert.equal(value({ revision: REV, question: "問\uD83D\uDE00" }).question, "問\uD83D\uDE00", "対になったサロゲートを断った");
  });

  it("UTF-16 の長さで先に打ち切っても、結果は文字数の規則と同じ（前後の空白は除いてから数える）", () => {
    // 前後の空白が多くても、除いたあとが上限以内なら通す
    const padded = " ".repeat(QUESTION_MAX_LENGTH * 3) + "問" + " ".repeat(QUESTION_MAX_LENGTH * 3);
    assert.equal(value({ revision: REV, question: padded }).question, "問");
    // 上限ちょうどの絵文字（UTF-16 で上限の 2 倍）は通し、1 文字多ければ断る
    assert.ok("value" in parsePatchQuestionBody({ revision: REV, question: "\u{1F600}".repeat(QUESTION_MAX_LENGTH) }), "上限ちょうどの絵文字を断った");
    assert.equal(reason({ revision: REV, question: "\u{1F600}".repeat(QUESTION_MAX_LENGTH + 1) }), "invalid_question");
    assert.equal(reason({ revision: REV, options: ["\u{1F600}".repeat(OPTION_MAX_LENGTH + 1), "b"] }), "invalid_options");
    // 巨大な見えない文字だけの値も断る（正規化の前に打ち切る。時間は測らない）
    assert.equal(reason({ revision: REV, question: "\u200B".repeat(5 * 1024 * 1024) }), "invalid_question");
    assert.equal(reason({ revision: REV, options: ["\u200B".repeat(5 * 1024 * 1024), "b"] }), "invalid_options");
  });

  it("見た目が同じ選択肢は重複として断る（NFC・書式文字・異体字セレクタ）。保存するのは前後の空白を除いただけの値", () => {
    const dup: Array<[string, string[]]> = [
      ["ZWSP", ["a", "a\u200B"]],
      ["制御文字 U+0001", ["a", "a\u0001"]],
      ["ハングルの埋め字 U+3164", ["a", "a\u3164"]],
      ["ソフトハイフン", ["ab", "a\u00ADb"]],
      ["BOM", ["a", "\uFEFFa"]],
      ["NFC と NFD の「が」", ["\u304C", "\u304B\u3099"]],
      ["異体字セレクタ", ["\u845B", "\u845B\uFE00"]],
      ["異体字セレクタ（補助）", ["\u845B", "\u845B\u{E0100}"]],
      ["書式文字をはさんだ結合", ["\u304C", "\u304B\u200B\u3099"]],
    ];
    for (const [label, options] of dup) {
      assert.equal(reason({ revision: REV, options }), "invalid_options", `${label}を重複とみなさない`);
    }
    // 絵文字に要る ZWJ とサブディビジョン旗のタグ文字は残す（hasVisibleText と同じ規則）ので、重複にしない
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const separate = "\u{1F468}\u{1F469}\u{1F467}";
    assert.deepEqual(value({ revision: REV, options: [family, separate] }).options, [family, separate], "ZWJ でつないだ家族の絵文字を重複とみなした");
    const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
    assert.deepEqual(value({ revision: REV, options: [england, scotland] }).options, [england, scotland], "イングランドとスコットランドの旗を重複とみなした");
    assert.equal(optionDuplicateKey(england), england, "旗のタグ文字を消した");
    // ZWJ は絵文字の外でも残す（既存の規則と同じ）
    assert.deepEqual(value({ revision: REV, options: ["ab", "a\u200Db"] }).options, ["ab", "a\u200Db"]);
    // 違う文字は重複にしない
    assert.deepEqual(value({ revision: REV, options: ["a", "A"] }).options, ["a", "A"]);
    assert.deepEqual(value({ revision: REV, options: ["\u304B", "\u304C"] }).options, ["\u304B", "\u304C"]);
    // 保存する値は正規化しない（NFD のまま・書式文字も残す）
    assert.deepEqual(value({ revision: REV, options: [" \u304B\u3099 ", "a\u200Bb"] }).options, ["\u304B\u3099", "a\u200Bb"]);
    assert.equal(optionDuplicateKey("\u304B\u3099"), "\u304C");
    assert.equal(optionDuplicateKey("a\u200B\uFE0F"), "a");
  });

  it("question・options・correctIndex がどれもなければ no_changes", () => {
    assert.equal(reason({ revision: REV }), "no_changes");
  });

  it("判定の順：unknown_field は revision より先、revision は値より先", () => {
    assert.equal(reason({ order: 1 }), "unknown_field");
    assert.equal(reason({ question: "" }), "invalid_revision");
    assert.equal(reason({ revision: REV, question: "", options: [] }), "invalid_question");
    assert.equal(reason({ revision: REV, options: [], correctIndex: -1 }), "invalid_options");
  });

  it("成功時の options は新しい配列（送られた配列をそのまま持たない）", () => {
    const sent = ["a", "b"];
    const v = value({ revision: REV, options: sent });
    assert.notEqual(v.options, sent);
  });
});

// ───────────── 変わった項目 ─────────────

describe("planQuestionEdit", () => {
  const current: QuestionContent = { question: "問", options: ["a", "b", "c"], correctIndex: 1 };
  const plan = (input: Record<string, unknown>, cur: QuestionContent = current) => {
    const r = planQuestionEdit(cur, { revision: REV, ...input });
    return r;
  };
  const okPlan = (input: Record<string, unknown>, cur: QuestionContent = current) => {
    const r = plan(input, cur);
    assert.ok("value" in r, `計画が失敗した：${JSON.stringify(input)} → ${"reason" in r ? r.reason : ""}`);
    return r.value;
  };

  it("正解だけを変える：changed は correctIndex だけ、data も correctIndex だけ", () => {
    const p = okPlan({ correctIndex: 2 });
    assert.deepEqual(p.changed, ["correctIndex"]);
    assert.deepEqual(p.data, { correctIndex: 2 });
    assert.deepEqual(p.before, current);
    assert.deepEqual(p.after, { ...current, correctIndex: 2 });
  });

  it("送った値が今と同じ項目は changed に入れない。すべて同じなら no_changes", () => {
    assert.deepEqual(okPlan({ question: "問", correctIndex: 2 }).changed, ["correctIndex"]);
    for (const input of [{ question: "問" }, { options: ["a", "b", "c"] }, { correctIndex: 1 }, { question: "問", options: ["a", "b", "c"], correctIndex: 1 }]) {
      const r = plan(input);
      assert.ok("reason" in r && r.reason === "no_changes", `no_changes にならない：${JSON.stringify(input)}`);
    }
  });

  it("changed は空でない配列で、CHANGED_FIELD_ORDER の順", () => {
    const p = okPlan({ correctIndex: 0, options: ["c", "b", "a"], question: "問2" });
    assert.ok(Array.isArray(p.changed) && p.changed.length > 0, "changed が空");
    assert.deepEqual(p.changed, ["question", "options", "correctIndex"]);
    assert.deepEqual([...CHANGED_FIELD_ORDER], ["question", "options", "correctIndex"]);
  });

  it("選択肢の並べ替え・文の変更・数の変更は options の変更", () => {
    assert.deepEqual(okPlan({ options: ["b", "a", "c"] }).changed, ["options"]);
    assert.deepEqual(okPlan({ options: ["a", "b", "d"] }).changed, ["options"]);
    assert.deepEqual(okPlan({ options: ["a", "b", "c", "d"] }).changed, ["options"]);
  });

  it("選択肢を減らすと今の正解が範囲外になる場合は invalid_correct_index（正解も送れば通る）", () => {
    const cur: QuestionContent = { ...current, correctIndex: 2 };
    const r = plan({ options: ["a", "b"] }, cur);
    assert.ok("reason" in r && r.reason === "invalid_correct_index", "範囲外の正解を通した");
    assert.deepEqual(okPlan({ options: ["a", "b"], correctIndex: 1 }, cur).changed, ["options", "correctIndex"]);
  });

  it("正解は変更後の選択肢の範囲で確かめる（増やした選択肢の位置を正解にできる）", () => {
    assert.deepEqual(okPlan({ options: ["a", "b", "c", "d"], correctIndex: 3 }).after.correctIndex, 3);
    const r = plan({ correctIndex: 3 });
    assert.ok("reason" in r && r.reason === "invalid_correct_index", "今の選択肢の範囲外の正解を通した");
  });

  it("今の options が壊れている：正解だけは確かめられず invalid_correct_index。options を送れば直せる。問題文だけは直せる", () => {
    const broken: QuestionContent = { question: "問", options: { x: 1 }, correctIndex: 0 };
    const r = plan({ correctIndex: 1 }, broken);
    assert.ok("reason" in r && r.reason === "invalid_correct_index", "壊れた options で正解だけの変更を通した");
    const fixed = okPlan({ options: ["a", "b"] }, broken);
    assert.deepEqual(fixed.changed, ["options"], "壊れた options を直した変更が options の変更にならない");
    assert.deepEqual(fixed.before.options, { x: 1 }, "before に壊れた値をそのまま残していない");
    const q = okPlan({ question: "問2" }, broken);
    assert.deepEqual(q.changed, ["question"]);
    assert.deepEqual(q.after.options, { x: 1 });
  });

  it("before / after は {question, options, correctIndex} のオブジェクト（ほかの項目なし）", () => {
    const p = okPlan({ question: "問2" });
    for (const s of [p.before, p.after]) {
      assert.deepEqual(Object.keys(s).sort(), ["correctIndex", "options", "question"]);
    }
  });
});

// ───────────── 応答・ログ ─────────────

describe("patchQuestionResponse / questionUpdatedLogMessage", () => {
  const q = toAdminQuizQuestion({ id: "q", order: 1, question: "問", options: ok2, correctIndex: 0 }, REV);

  it("inProgressInvalidated は options が変わったときだけ true", () => {
    assert.equal(patchQuestionResponse(q, ["options"], 0).inProgressInvalidated, true);
    assert.equal(patchQuestionResponse(q, ["question", "correctIndex"], 0).inProgressInvalidated, false);
  });

  it("項目は question・changed・inProgressInvalidated・attemptCount だけ", () => {
    const r = patchQuestionResponse(q, ["correctIndex"], 4);
    assert.deepEqual(Object.keys(r).sort(), ["attemptCount", "changed", "inProgressInvalidated", "question"]);
    assert.equal(r.attemptCount, 4);
  });

  it("ログは固定文と項目の名前だけ（並びは固定）", () => {
    assert.equal(questionUpdatedLogMessage(["correctIndex", "question"]), "[admin] quiz question updated: question,correctIndex");
  });
});

// ───────────── import の境界 ─────────────

describe("import の境界（node:crypto を画面に入れない）", () => {
  const root = join(__dirname, "..", "..");
  const importsOf = (rel: string) => {
    const src = readFileSync(join(root, rel), "utf8");
    return Array.from(src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g), (m) => m[1]);
  };

  // admin-quiz-view.ts は #81 Q2 の画面用の lib（page.tsx が import する）
  for (const rel of ["src/app/page.tsx", "src/lib/admin-quizzes.ts", "src/lib/admin-quiz-view.ts"]) {
    it(`${rel} は admin-quiz-revision・node:crypto を import しない`, () => {
      const specs = importsOf(rel);
      assert.ok(specs.length > 0, `${rel} の import を読めていない`);
      for (const s of specs) {
        assert.doesNotMatch(s, /admin-quiz-revision/, `${rel} が ${s} を import している`);
        assert.doesNotMatch(s, /^(node:)?crypto$/, `${rel} が ${s} を import している`);
      }
    });
  }

  it("admin-quiz-revision を import するのはクイズ管理の詳細と問題の PATCH の route だけ", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(join(root, "src"));
    assert.ok(files.length >= 50, `走査したファイルが ${files.length} 件しかない（走査の前提）`);
    const users = files
      .map((f) => f.slice(root.length + 1).split("\\").join("/"))
      .filter((rel) => importsOf(rel).some((s) => /admin-quiz-revision/.test(s)))
      .sort();
    assert.deepEqual(users, ["src/app/api/admin/questions/[id]/route.ts", "src/app/api/admin/quizzes/[id]/route.ts"]);
  });
});
