import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_OPTIONS, OPTION_MAX_LENGTH, QUESTION_MAX_LENGTH, parsePatchQuestionBody, planQuestionEdit, type AdminQuizDetail, type AdminQuizQuestion, type AdminQuizSummary } from "./admin-quizzes";
import { MIN_OPTIONS } from "./student-quizzes";
import {
  ADMIN_QUIZ_LIST_URL,
  BROKEN_OPTIONS_WARNING,
  CORRECT_NOT_SELECTED_MESSAGE,
  CORRECT_OUT_OF_RANGE_WARNING,
  EDIT_CONFLICT_MESSAGE,
  NO_COURSE_GROUP_LABEL,
  OPTIONS_CHANGE_NOTICE,
  QUESTION_GONE_MESSAGE,
  SAVE_FORBIDDEN_MESSAGE,
  SAVE_SERVER_ERROR_MESSAGE,
  SAVE_UNCERTAIN_MESSAGE,
  addDraftOption,
  adminQuestionUrl,
  adminQuizDetailUrl,
  adminQuizTypeLabel,
  applyQuestionUpdate,
  canAddOption,
  canRemoveOption,
  changedFieldsLabel,
  draftCorrectIndex,
  editDialogTitle,
  initialQuestionDraft,
  interpretQuestionPatchResponse,
  moveDraftOption,
  pastAttemptsNotice,
  patchReasonMessage,
  questionEditConfirmLines,
  questionEditOutcome,
  questionSavedMessage,
  quizDetailMeta,
  quizStatusAfterEdit,
  quizStatusBadge,
  readAdminQuizDetail,
  readAdminQuizList,
  removeDraftOption,
  setDraftCorrect,
  setDraftOptionText,
  setDraftQuestion,
  sortQuestions,
  toAdminQuizGroups,
  toQuestionView,
  type QuestionDraft,
} from "./admin-quiz-view";

// #81 Q2 クイズ管理の画面用の lib（文言・判定・送る body の組み立て）。DB・ネットワーク・DOM なし。データはすべてダミー。

const REV = "a".repeat(64);
const REV2 = "b".repeat(64);

const question = (over: Partial<AdminQuizQuestion> = {}): AdminQuizQuestion => ({
  id: "qq1",
  order: 1,
  question: "ダミーの問題文",
  options: ["選択肢A", "選択肢B", "選択肢C"],
  correctIndex: 1,
  valid: true,
  revision: REV,
  ...over,
});

const summary = (over: Partial<AdminQuizSummary> = {}): AdminQuizSummary => ({
  id: "qz1",
  title: "ダミーのミニテスト",
  type: "MINI",
  courseId: "co1",
  courseName: "STEP1 ダミー",
  lessonTitle: "レッスン1",
  questionCount: 3,
  attemptCount: 2,
  status: "ok",
  ...over,
});

const detail = (over: Partial<AdminQuizDetail> = {}): AdminQuizDetail => ({
  id: "qz1",
  title: "ダミーのミニテスト",
  type: "MINI",
  courseName: "STEP1 ダミー",
  lessonTitle: "レッスン1",
  attemptCount: 2,
  status: "ok",
  questions: [question()],
  ...over,
});

/** 下書きの選択肢の key を位置から引く */
const keyAt = (d: QuestionDraft, i: number) => d.options[i].key;

describe("URL", () => {
  it("一覧は定数、詳細と問題は id を encodeURIComponent する", () => {
    assert.equal(ADMIN_QUIZ_LIST_URL, "/api/admin/quizzes");
    assert.equal(adminQuizDetailUrl("qz1"), "/api/admin/quizzes/qz1");
    assert.equal(adminQuestionUrl("qq1"), "/api/admin/questions/qq1");
    assert.equal(adminQuizDetailUrl("a/b?c#d"), "/api/admin/quizzes/a%2Fb%3Fc%23d");
    assert.equal(adminQuestionUrl("../x"), "/api/admin/questions/..%2Fx");
  });
});

describe("状態のバッジ", () => {
  it("unavailable は「受験できない」、no_course は「コースなし」、ok はなし", () => {
    assert.equal(quizStatusBadge("unavailable")?.label, "受験できない");
    assert.equal(quizStatusBadge("no_course")?.label, "コースなし");
    assert.equal(quizStatusBadge("ok"), null);
    assert.ok((quizStatusBadge("unavailable")?.description ?? "").includes("受講生の一覧に出ません"), "unavailable の説明がない");
    assert.ok((quizStatusBadge("no_course")?.description ?? "").includes("コースがない"), "no_course の説明がない");
  });

  it("種類のラベル", () => {
    assert.equal(adminQuizTypeLabel("FINAL"), "修了テスト");
    assert.equal(adminQuizTypeLabel("MINI"), "ミニテスト");
  });
});

describe("readAdminQuizList", () => {
  it("正しい形はそのまま読む（空の一覧も読む）", () => {
    const list = [summary(), summary({ id: "qz2", type: "FINAL", lessonTitle: null, status: "unavailable" })];
    assert.deepEqual(readAdminQuizList({ quizzes: list }), list);
    assert.deepEqual(readAdminQuizList({ quizzes: [] }), []);
  });

  it("余分な項目は読み捨てる", () => {
    const got = readAdminQuizList({ quizzes: [{ ...summary(), options: ["x"], correctIndex: 0 }] });
    assert.ok(got, "読めていない");
    assert.equal("options" in got[0], false, "許可していない項目を残した");
  });

  it("形が違えば（1 件でも）null", () => {
    const bad: unknown[] = [
      null,
      [],
      "x",
      {},
      { quizzes: {} },
      { quizzes: [null] },
      { quizzes: [summary(), { ...summary(), type: "OTHER" }] },
      { quizzes: [{ ...summary(), status: "broken" }] },
      { quizzes: [{ ...summary(), questionCount: -1 }] },
      { quizzes: [{ ...summary(), attemptCount: 1.5 }] },
      { quizzes: [{ ...summary(), id: "" }] },
      { quizzes: [{ ...summary(), courseId: 1 }] },
      { quizzes: [{ ...summary(), lessonTitle: undefined }] },
    ];
    for (const b of bad) assert.equal(readAdminQuizList(b), null, `null にならない：${JSON.stringify(b)}`);
  });
});

describe("toAdminQuizGroups", () => {
  it("サーバーの並びのままコースごとにまとめ、コースなしは最後に 1 つ", () => {
    const groups = toAdminQuizGroups([
      summary({ id: "f1", type: "FINAL", title: "修了", lessonTitle: null }),
      summary({ id: "m1" }),
      summary({ id: "m2", courseId: "co2", courseName: "STEP2 ダミー", lessonTitle: "レッスン2" }),
      summary({ id: "o1", courseId: null, courseName: null, type: "FINAL", lessonTitle: null, status: "no_course" }),
      summary({ id: "o2", courseId: null, courseName: null, lessonTitle: null, status: "unavailable" }),
    ]);
    assert.deepEqual(groups.map((g) => [g.courseName, g.noCourse, g.rows.map((r) => r.id)]), [
      ["STEP1 ダミー", false, ["f1", "m1"]],
      ["STEP2 ダミー", false, ["m2"]],
      [NO_COURSE_GROUP_LABEL, true, ["o1", "o2"]],
    ]);
    assert.equal(new Set(groups.map((g) => g.key)).size, groups.length, "key が重なっている");
  });

  it("行：種類・レッスン名（ミニテストだけ）・問題数・受験数・バッジ", () => {
    const [g] = toAdminQuizGroups([
      summary({ id: "f1", type: "FINAL", lessonTitle: "使わない", questionCount: 10, attemptCount: 0 }),
      summary({ id: "m1", lessonTitle: null, status: "unavailable" }),
      summary({ id: "m2" }),
    ]);
    assert.deepEqual(g.rows[0], { id: "f1", title: "ダミーのミニテスト", typeLabel: "修了テスト", lessonLabel: "—", questionCount: 10, attemptCount: 0, badge: null });
    assert.equal(g.rows[1].lessonLabel, "—");
    assert.equal(g.rows[1].badge?.label, "受験できない");
    assert.equal(g.rows[2].lessonLabel, "レッスン1");
    assert.equal(g.rows[2].typeLabel, "ミニテスト");
  });

  it("コースなしの no_course にはバッジ「コースなし」を付ける（unavailable が優先のときは「受験できない」）", () => {
    const groups = toAdminQuizGroups([
      summary({ id: "o1", courseId: null, courseName: null, status: "no_course" }),
      summary({ id: "o2", courseId: null, courseName: null, status: "unavailable" }),
    ]);
    assert.deepEqual(groups[0].rows.map((r) => r.badge?.label), ["コースなし", "受験できない"]);
  });

  it("courseName のないコースは名前の代わりの文言にする。空の一覧は空", () => {
    assert.equal(toAdminQuizGroups([summary({ courseName: null })])[0].courseName, "（名前のないコース）");
    assert.deepEqual(toAdminQuizGroups([]), []);
  });
});

describe("readAdminQuizDetail", () => {
  const body = (over: Record<string, unknown> = {}) => ({ ...detail(), ...over });

  it("正しい形を読み、問題を [order, id] の順に並べる（選択肢は元の並び）", () => {
    const qs = [question({ id: "b", order: 2 }), question({ id: "z", order: 1 }), question({ id: "a", order: 2, options: ["x", "y"] })];
    const got = readAdminQuizDetail(body({ questions: qs }), "qz1");
    assert.ok(got, "読めていない");
    assert.deepEqual(got.questions.map((q) => q.id), ["z", "a", "b"]);
    assert.deepEqual(got.questions[1].options, ["x", "y"]);
  });

  it("壊れた選択肢（null）と範囲外の正解はそのまま読む", () => {
    const got = readAdminQuizDetail(body({ questions: [question({ id: "a", options: null, valid: false }), question({ id: "b", correctIndex: 7, valid: false })] }), "qz1");
    assert.ok(got, "読めていない");
    assert.equal(got.questions[0].options, null);
    assert.equal(got.questions[1].correctIndex, 7);
  });

  it("別のクイズの応答・形が違えば null", () => {
    assert.equal(readAdminQuizDetail(body(), "qz2"), null);
    const bad: unknown[] = [
      null,
      body({ type: "X" }),
      body({ status: "x" }),
      body({ attemptCount: -1 }),
      body({ questions: null }),
      body({ questions: [question({ revision: "ABC" })] }),
      body({ questions: [question({ revision: "A".repeat(64) })] }),
      body({ questions: [{ ...question(), options: ["a", 1] }] }),
      body({ questions: [{ ...question(), valid: "yes" }] }),
      body({ questions: [{ ...question(), order: 1.5 }] }),
      body({ questions: [{ ...question(), id: "" }] }),
    ];
    for (const b of bad) assert.equal(readAdminQuizDetail(b, "qz1"), null, `null にならない：${JSON.stringify(b)}`);
  });

  it("sortQuestions は元の配列を変えない", () => {
    const qs = [question({ id: "b" }), question({ id: "a" })];
    assert.deepEqual(sortQuestions(qs).map((q) => q.id), ["a", "b"]);
    assert.deepEqual(qs.map((q) => q.id), ["b", "a"]);
  });

  it("見出しの下の 1 行", () => {
    assert.equal(quizDetailMeta(detail()), "ミニテスト · STEP1 ダミー · レッスン1 · 問題 1 問 · 受験 2 件");
    assert.equal(quizDetailMeta(detail({ type: "FINAL", courseName: null, lessonTitle: "x", questions: [] })), "修了テスト · コースなし · 問題 0 問 · 受験 2 件");
  });
});

describe("toQuestionView", () => {
  it("正解に印を付け、並びは変えない。valid なら警告なし", () => {
    const v = toQuestionView(question(), 0);
    assert.equal(v.number, 1);
    assert.deepEqual(v.options, [
      { text: "選択肢A", correct: false },
      { text: "選択肢B", correct: true },
      { text: "選択肢C", correct: false },
    ]);
    assert.equal(v.warning, null);
  });

  it("valid: false の警告：選択肢が壊れている / 正解が範囲外", () => {
    assert.equal(toQuestionView(question({ options: null, valid: false }), 2).warning, BROKEN_OPTIONS_WARNING);
    assert.equal(toQuestionView(question({ options: null, valid: false }), 2).options, null);
    const out = toQuestionView(question({ correctIndex: 3, valid: false }), 0);
    assert.equal(out.warning, CORRECT_OUT_OF_RANGE_WARNING);
    assert.ok(out.options?.every((o) => !o.correct), "範囲外の正解に印を付けた");
  });
});

describe("保存のあとの詳細", () => {
  it("quizStatusAfterEdit：全問 valid かつ 1 問以上でコースがあれば ok", () => {
    assert.equal(quizStatusAfterEdit([question()], "STEP1"), "ok");
    assert.equal(quizStatusAfterEdit([question()], null), "no_course");
    assert.equal(quizStatusAfterEdit([question(), question({ valid: false })], "STEP1"), "unavailable");
    assert.equal(quizStatusAfterEdit([question({ valid: false })], null), "unavailable");
    assert.equal(quizStatusAfterEdit([], "STEP1"), "unavailable");
  });

  it("applyQuestionUpdate：その問題を置き換え、受験数は応答の値、状態を決め直す", () => {
    const before = detail({ status: "unavailable", questions: [question({ valid: false, correctIndex: 9 }), question({ id: "qq2", order: 2 })] });
    const updated = question({ correctIndex: 0, revision: REV2 });
    const after = applyQuestionUpdate(before, { question: updated, attemptCount: 5 });
    assert.deepEqual(after.questions.map((q) => [q.id, q.revision, q.correctIndex]), [["qq1", REV2, 0], ["qq2", REV, 1]]);
    assert.equal(after.attemptCount, 5);
    assert.equal(after.status, "ok");
    assert.equal(before.questions[0].correctIndex, 9, "元の詳細を書き換えた");
  });

  it("applyQuestionUpdate：詳細にない問題なら何もしない", () => {
    const d = detail();
    assert.equal(applyQuestionUpdate(d, { question: question({ id: "other" }), attemptCount: 9 }), d);
  });
});

describe("下書き", () => {
  it("初期値：問題文・選択肢・正解（key で持つ）", () => {
    const d = initialQuestionDraft(question());
    assert.equal(d.question, "ダミーの問題文");
    assert.deepEqual(d.options.map((o) => o.text), ["選択肢A", "選択肢B", "選択肢C"]);
    assert.equal(new Set(d.options.map((o) => o.key)).size, 3, "key が重なっている");
    assert.equal(draftCorrectIndex(d), 1);
  });

  it("初期値：選択肢が壊れていれば空の 2 件・正解なし。正解が範囲外なら正解なし", () => {
    const broken = initialQuestionDraft(question({ options: null, valid: false }));
    assert.deepEqual(broken.options.map((o) => o.text), ["", ""]);
    assert.equal(broken.correctKey, null);
    assert.equal(initialQuestionDraft(question({ correctIndex: 3, valid: false })).correctKey, null);
    assert.equal(initialQuestionDraft(question({ correctIndex: -1, valid: false })).correctKey, null);
  });

  it("追加は 10 件まで、削除は 2 件まで", () => {
    let d = initialQuestionDraft(question());
    while (canAddOption(d)) d = addDraftOption(d);
    assert.equal(d.options.length, MAX_OPTIONS);
    assert.equal(addDraftOption(d), d, "10 件を超えて足した");
    assert.equal(new Set(d.options.map((o) => o.key)).size, MAX_OPTIONS, "足した key が重なっている");
    while (canRemoveOption(d)) d = removeDraftOption(d, keyAt(d, d.options.length - 1));
    assert.equal(d.options.length, MIN_OPTIONS);
    assert.equal(removeDraftOption(d, keyAt(d, 0)), d, "2 件より減らした");
  });

  it("正解の選択肢を消すと正解なしに戻る。ほかを消しても正解は同じ選択肢", () => {
    const d = initialQuestionDraft(question());
    const removedOther = removeDraftOption(d, keyAt(d, 0));
    assert.equal(removedOther.options[draftCorrectIndex(removedOther) ?? -1].text, "選択肢B");
    const removedCorrect = removeDraftOption(d, keyAt(d, 1));
    assert.equal(removedCorrect.correctKey, null);
    assert.equal(draftCorrectIndex(removedCorrect), null);
  });

  it("並べ替え：端では動かない。正解は同じ選択肢のまま", () => {
    const d = initialQuestionDraft(question());
    assert.equal(moveDraftOption(d, keyAt(d, 0), -1), d);
    assert.equal(moveDraftOption(d, keyAt(d, 2), 1), d);
    const up = moveDraftOption(d, keyAt(d, 1), -1);
    assert.deepEqual(up.options.map((o) => o.text), ["選択肢B", "選択肢A", "選択肢C"]);
    assert.equal(draftCorrectIndex(up), 0);
    const down = moveDraftOption(d, keyAt(d, 0), 1);
    assert.equal(draftCorrectIndex(down), 0, "正解の前の選択肢を後ろへ動かしても正解の位置が追従しない");
  });

  it("setDraftCorrect は存在しない key を無視する。setDraft* は元の下書きを変えない", () => {
    const d = initialQuestionDraft(question());
    assert.equal(setDraftCorrect(d, 999), d);
    const t = setDraftOptionText(setDraftQuestion(d, "新しい問題文"), keyAt(d, 0), "新A");
    assert.equal(d.question, "ダミーの問題文");
    assert.equal(d.options[0].text, "選択肢A");
    assert.equal(t.question, "新しい問題文");
    assert.equal(t.options[0].text, "新A");
  });
});

describe("questionEditOutcome（送る body）", () => {
  const q = question();

  it("何も変えなければ unchanged（前後の空白だけの変更も）", () => {
    const d = initialQuestionDraft(q);
    assert.deepEqual(questionEditOutcome(q, d), { kind: "unchanged" });
    const spaced = setDraftOptionText(setDraftQuestion(d, `  ${q.question}\n`), keyAt(d, 0), " 選択肢A ");
    assert.deepEqual(questionEditOutcome(q, spaced), { kind: "unchanged" });
    // 一度変えて戻した
    assert.deepEqual(questionEditOutcome(q, setDraftCorrect(setDraftCorrect(d, keyAt(d, 2)), keyAt(d, 1))), { kind: "unchanged" });
  });

  it("問題文だけ：revision と問題文（前後の空白を除く）だけを送る", () => {
    const out = questionEditOutcome(q, setDraftQuestion(initialQuestionDraft(q), "  直した問題文  "));
    assert.deepEqual(out, { kind: "ready", body: { revision: REV, question: "直した問題文" }, changed: ["question"] });
  });

  it("正解だけ：revision と correctIndex だけを送る", () => {
    const d = initialQuestionDraft(q);
    const out = questionEditOutcome(q, setDraftCorrect(d, keyAt(d, 2)));
    assert.deepEqual(out, { kind: "ready", body: { revision: REV, correctIndex: 2 }, changed: ["correctIndex"] });
  });

  it("選択肢の文だけ：正解の位置が同じなら correctIndex は送らない", () => {
    const d = initialQuestionDraft(q);
    const out = questionEditOutcome(q, setDraftOptionText(d, keyAt(d, 0), " 直したA "));
    assert.deepEqual(out, { kind: "ready", body: { revision: REV, options: ["直したA", "選択肢B", "選択肢C"] }, changed: ["options"] });
  });

  it("並べ替え：正解の選択肢を動かすと、選択肢と新しい位置の correctIndex を送る", () => {
    const d = initialQuestionDraft(q);
    const out = questionEditOutcome(q, moveDraftOption(d, keyAt(d, 1), 1));
    assert.deepEqual(out, { kind: "ready", body: { revision: REV, options: ["選択肢A", "選択肢C", "選択肢B"], correctIndex: 2 }, changed: ["options", "correctIndex"] });
  });

  it("並べ替え：正解の前の選択肢を後ろへ動かすと、正解の位置が 1 つ前になる", () => {
    const d = initialQuestionDraft(q);
    const out = questionEditOutcome(q, moveDraftOption(moveDraftOption(d, keyAt(d, 0), 1), keyAt(d, 0), 1));
    assert.deepEqual(out, { kind: "ready", body: { revision: REV, options: ["選択肢B", "選択肢C", "選択肢A"], correctIndex: 0 }, changed: ["options", "correctIndex"] });
  });

  it("並べ替え：正解でない 2 つを入れ替えても正解の位置が同じなら correctIndex は送らない", () => {
    const q4 = question({ options: ["A", "B", "C", "D"], correctIndex: 0 });
    const d = initialQuestionDraft(q4);
    const out = questionEditOutcome(q4, moveDraftOption(d, keyAt(d, 2), 1));
    assert.deepEqual(out, { kind: "ready", body: { revision: REV, options: ["A", "B", "D", "C"] }, changed: ["options"] });
  });

  it("削除：正解より前を消すと正解の位置を詰める。正解を消すと invalid", () => {
    const q3 = question({ correctIndex: 2 });
    const d = initialQuestionDraft(q3);
    assert.deepEqual(questionEditOutcome(q3, removeDraftOption(d, keyAt(d, 0))), {
      kind: "ready",
      body: { revision: REV, options: ["選択肢B", "選択肢C"], correctIndex: 1 },
      changed: ["options", "correctIndex"],
    });
    assert.deepEqual(questionEditOutcome(q3, removeDraftOption(d, keyAt(d, 2))), { kind: "invalid", message: CORRECT_NOT_SELECTED_MESSAGE });
  });

  it("追加：空の選択肢は invalid、文を入れれば選択肢を送る", () => {
    const d = addDraftOption(initialQuestionDraft(q));
    const empty = questionEditOutcome(q, d);
    assert.equal(empty.kind, "invalid");
    assert.equal(empty.kind === "invalid" && empty.message, patchReasonMessage("invalid_options"));
    const filled = questionEditOutcome(q, setDraftOptionText(d, keyAt(d, 3), "選択肢D"));
    assert.deepEqual(filled, { kind: "ready", body: { revision: REV, options: ["選択肢A", "選択肢B", "選択肢C", "選択肢D"] }, changed: ["options"] });
  });

  it("重複（見た目が同じものを含む）・見えない文字だけ・NUL・対になっていないサロゲートは invalid", () => {
    const d = initialQuestionDraft(q);
    const cases: Array<[string, QuestionDraft]> = [
      ["同じ文", setDraftOptionText(d, keyAt(d, 0), "選択肢B")],
      ["ゼロ幅スペース付き", setDraftOptionText(d, keyAt(d, 0), "選択肢B​")],
      ["NFD", setDraftOptionText(setDraftOptionText(d, keyAt(d, 0), "が"), keyAt(d, 2), "が")],
      ["見えない文字だけ", setDraftOptionText(d, keyAt(d, 0), "​⁠")],
      ["NUL", setDraftOptionText(d, keyAt(d, 0), "A\u0000")],
      ["対になっていないサロゲート", setDraftOptionText(d, keyAt(d, 0), "A\uD800")],
    ];
    for (const [label, draft] of cases) {
      const out = questionEditOutcome(q, draft);
      assert.deepEqual(out, { kind: "invalid", message: patchReasonMessage("invalid_options") }, label);
    }
    for (const [label, text] of [["空", "   "], ["見えない文字だけ", "　​"], ["NUL", "a\u0000"], ["サロゲート", "\uDC00"]]) {
      assert.deepEqual(questionEditOutcome(q, setDraftQuestion(d, text)), { kind: "invalid", message: patchReasonMessage("invalid_question") }, label);
    }
  });

  it("長さの境界：問題文 1000 字・選択肢 300 字まで（サロゲートペアは 1 字）", () => {
    const d = initialQuestionDraft(q);
    assert.equal(questionEditOutcome(q, setDraftQuestion(d, "あ".repeat(QUESTION_MAX_LENGTH))).kind, "ready");
    assert.equal(questionEditOutcome(q, setDraftQuestion(d, "\u{1F600}".repeat(QUESTION_MAX_LENGTH))).kind, "ready");
    assert.equal(questionEditOutcome(q, setDraftQuestion(d, "あ".repeat(QUESTION_MAX_LENGTH + 1))).kind, "invalid");
    assert.equal(questionEditOutcome(q, setDraftOptionText(d, keyAt(d, 0), "x".repeat(OPTION_MAX_LENGTH))).kind, "ready");
    assert.equal(questionEditOutcome(q, setDraftOptionText(d, keyAt(d, 0), "x".repeat(OPTION_MAX_LENGTH + 1))).kind, "invalid");
  });

  it("元の選択肢が壊れているとき：選択肢を必ず送り、正解を選ぶまで invalid", () => {
    const broken = question({ options: null, correctIndex: 0, valid: false });
    let d = initialQuestionDraft(broken);
    d = setDraftOptionText(setDraftOptionText(d, keyAt(d, 0), "新A"), keyAt(d, 1), "新B");
    assert.deepEqual(questionEditOutcome(broken, d), { kind: "invalid", message: CORRECT_NOT_SELECTED_MESSAGE });
    // 元の correctIndex と同じ位置なら correctIndex は送らない（サーバーは今の correctIndex で範囲を確かめる）
    assert.deepEqual(questionEditOutcome(broken, setDraftCorrect(d, keyAt(d, 0))), { kind: "ready", body: { revision: REV, options: ["新A", "新B"] }, changed: ["options"] });
    assert.deepEqual(questionEditOutcome(broken, setDraftCorrect(d, keyAt(d, 1))), {
      kind: "ready",
      body: { revision: REV, options: ["新A", "新B"], correctIndex: 1 },
      changed: ["options", "correctIndex"],
    });
    // 問題文だけでは unchanged にならない（選択肢を送る必要がある）
    assert.equal(questionEditOutcome(broken, setDraftQuestion(initialQuestionDraft(broken), "直した")).kind, "invalid");
  });

  it("元の正解が範囲外のとき：問題文だけなら correctIndex を送らない。正解を選べば送る", () => {
    const out = question({ correctIndex: 5, valid: false });
    const d = initialQuestionDraft(out);
    assert.deepEqual(questionEditOutcome(out, setDraftQuestion(d, "直した")), { kind: "ready", body: { revision: REV, question: "直した" }, changed: ["question"] });
    assert.deepEqual(questionEditOutcome(out, setDraftCorrect(d, keyAt(d, 0))), { kind: "ready", body: { revision: REV, correctIndex: 0 }, changed: ["correctIndex"] });
    assert.deepEqual(questionEditOutcome(out, d), { kind: "unchanged" });
  });

  it("ランダムな操作のあと、ready の body はサーバーの検証を通り、サーバーで反映すると下書きどおりになる", () => {
    // 決まった種の擬似乱数（xorshift32）
    let seed = 0x81_0002;
    const rand = (n: number) => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    const words = ["甲", "乙", "丙", "丁", " 戊 ", "己", "庚"];
    let ready = 0;
    for (let round = 0; round < 300; round++) {
      const n = 2 + rand(4);
      const original = question({ options: Array.from({ length: n }, (_, i) => `元${i}`), correctIndex: rand(n) });
      let d = initialQuestionDraft(original);
      for (let step = 0; step < 6; step++) {
        const k = d.options[rand(d.options.length)].key;
        switch (rand(6)) {
          case 0: d = moveDraftOption(d, k, rand(2) === 0 ? -1 : 1); break;
          case 1: d = removeDraftOption(d, k); break;
          case 2: d = setDraftOptionText(addDraftOption(d), d.nextKey, `追加${round}-${step}`); break;
          case 3: d = setDraftOptionText(d, k, words[rand(words.length)] + round); break;
          case 4: d = setDraftCorrect(d, k); break;
          default: d = setDraftQuestion(d, rand(2) === 0 ? original.question : `問題${round}`);
        }
      }
      const out = questionEditOutcome(original, d);
      if (out.kind !== "ready") continue;
      ready++;
      const body = out.body;
      // 送るのは変わった項目と revision だけ
      assert.deepEqual(Object.keys(body).filter((k) => k !== "revision"), out.changed.map((c) => c), `項目と changed が食い違う：${JSON.stringify(out)}`);
      const parsed = parsePatchQuestionBody(body);
      assert.ok(!("reason" in parsed), `サーバーの検証を通らない：${JSON.stringify(body)}`);
      const plan = planQuestionEdit(original, parsed.value);
      assert.ok(!("reason" in plan), `サーバーで反映できない：${JSON.stringify(body)}`);
      const after = plan.value.after;
      assert.equal(after.question, d.question.trim());
      assert.deepEqual(after.options, d.options.map((o) => o.text.trim()));
      const correct = d.options.find((o) => o.key === d.correctKey);
      assert.ok(correct, "ready なのに正解がない");
      assert.equal((after.options as string[])[after.correctIndex], correct.text.trim(), "サーバーの正解が下書きの正解の選択肢と違う");
      assert.deepEqual([...plan.value.changed].sort(), [...out.changed].sort(), "サーバーが変わったとみなす項目と違う");
    }
    assert.ok(ready >= 100, `ready の回数が少ない（検査の前提）：${ready}`);
  });
});

describe("保存の前の確認", () => {
  it("選択肢を変えたときだけ受験中の注意、受験記録が 1 件以上のときだけ過去の受験の注意", () => {
    assert.deepEqual(questionEditConfirmLines(["options"], 0), [OPTIONS_CHANGE_NOTICE]);
    assert.deepEqual(questionEditConfirmLines(["question", "options", "correctIndex"], 3), [OPTIONS_CHANGE_NOTICE, "過去の受験 3 件の点数・合否は変わりません"]);
    assert.deepEqual(questionEditConfirmLines(["correctIndex"], 1), ["過去の受験 1 件の点数・合否は変わりません"]);
    assert.deepEqual(questionEditConfirmLines(["question"], 0), []);
    assert.equal(OPTIONS_CHANGE_NOTICE, "選択肢を変えると、いま受験中の受講生は回答のやり直しになります");
    assert.equal(pastAttemptsNotice(12), "過去の受験 12 件の点数・合否は変わりません");
  });

  it("変わった項目の名前は固定の並び", () => {
    assert.equal(changedFieldsLabel(["correctIndex", "question"]), "問題文・正解");
    assert.equal(changedFieldsLabel(["options", "correctIndex", "question"]), "問題文・選択肢・正解");
    assert.equal(editDialogTitle(3), "問題 3 を編集");
    assert.equal(questionSavedMessage(2, ["options"]), "問題 2 を保存しました（選択肢）");
  });
});

describe("interpretQuestionPatchResponse", () => {
  const ok = (body: unknown, over: Partial<{ ok: boolean; status: number; redirected: boolean }> = {}) =>
    interpretQuestionPatchResponse({ ok: true, status: 200, redirected: false, body, questionId: "qq1", ...over });
  const fail = (status: number, body: unknown = null) => interpretQuestionPatchResponse({ ok: false, status, redirected: false, body, questionId: "qq1" });
  const good = { question: question({ revision: REV2 }), changed: ["question"], inProgressInvalidated: false, attemptCount: 4 };

  it("成功：新しい revision の問題・変わった項目・受験数", () => {
    assert.deepEqual(ok(good), { kind: "success", question: question({ revision: REV2 }), changed: ["question"], attemptCount: 4 });
  });

  it("2xx でも形が違う・別の問題・リダイレクトは結果不明", () => {
    for (const b of [null, "x", {}, { ...good, question: question({ id: "other" }) }, { ...good, changed: ["order"] }, { ...good, attemptCount: -1 }, { ...good, question: { ...good.question, revision: "x" } }]) {
      assert.deepEqual(ok(b), { kind: "uncertain", message: SAVE_UNCERTAIN_MESSAGE }, JSON.stringify(b));
    }
    assert.deepEqual(ok(good, { redirected: true }), { kind: "uncertain", message: SAVE_UNCERTAIN_MESSAGE });
  });

  it("409 は他の講師の更新、404 は問題がない、502〜504 は結果不明", () => {
    assert.deepEqual(fail(409, { reason: "edit_conflict" }), { kind: "conflict", message: EDIT_CONFLICT_MESSAGE });
    assert.equal(EDIT_CONFLICT_MESSAGE, "他の講師が先に更新しました。最新の内容を読み込みます");
    assert.equal(SAVE_UNCERTAIN_MESSAGE, "保存できたか確認できません。読み直してください");
    assert.deepEqual(fail(404), { kind: "gone", message: QUESTION_GONE_MESSAGE });
    for (const s of [502, 503, 504]) assert.deepEqual(fail(s), { kind: "uncertain", message: SAVE_UNCERTAIN_MESSAGE }, String(s));
  });

  it("400 は reason ごとの文言、403・500 などはダイアログに出すエラー", () => {
    const reasons = ["invalid_question", "invalid_options", "invalid_correct_index", "no_changes", "invalid_revision", "unknown_field", "invalid_json", "invalid_id"];
    for (const r of reasons) {
      const out = fail(400, { error: "Invalid request", reason: r });
      assert.equal(out.kind, "error", r);
      assert.equal(out.kind === "error" && out.message, patchReasonMessage(r), r);
      assert.ok(patchReasonMessage(r).length > 0, r);
    }
    assert.notEqual(patchReasonMessage("invalid_question"), patchReasonMessage("invalid_options"), "問題文と選択肢の文言が同じ");
    assert.equal(patchReasonMessage("unknown_reason"), patchReasonMessage("invalid_json"));
    assert.equal(patchReasonMessage(undefined), patchReasonMessage("invalid_json"));
    assert.deepEqual(fail(400, "<html>"), { kind: "error", message: patchReasonMessage("invalid_json") });
    assert.deepEqual(fail(403), { kind: "error", message: SAVE_FORBIDDEN_MESSAGE });
    assert.deepEqual(fail(500), { kind: "error", message: SAVE_SERVER_ERROR_MESSAGE });
    assert.equal(fail(401).kind, "error");
  });
});
