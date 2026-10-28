import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_OPTIONS,
  OPTION_MAX_LENGTH,
  QUESTION_MAX_LENGTH,
  parsePatchQuestionBody,
  planQuestionEdit,
  type AdminQuizQuestion,
  type AdminQuizSummary,
} from "./admin-quizzes";
import { MIN_OPTIONS, toAnswerKey } from "./student-quizzes";
import {
  CORRECT_NOT_SELECTED_MESSAGE,
  SAVE_UNCERTAIN_MESSAGE,
  addDraftOption,
  initialQuestionDraft,
  interpretQuestionPatchResponse,
  moveDraftOption,
  patchReasonMessage,
  questionEditConfirmLines,
  questionEditOutcome,
  removeDraftOption,
  setDraftCorrect,
  setDraftOptionText,
  setDraftQuestion,
  tooManyOptionsMessage,
  toAdminQuizGroups,
  type QuestionDraft,
} from "./admin-quiz-view";

// #81 Q2 クイズ管理の画面用の lib の境界（tester 追加）。DB・ネットワーク・DOM なし。データはすべてダミー。
// 見えない文字・結合文字は \u エスケープで書く。

const REV = "a".repeat(64);

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

const keyAt = (d: QuestionDraft, i: number) => d.options[i].key;

/** 決まった種の擬似乱数（xorshift32） */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return (n: number) => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) % n;
  };
}

/** body をサーバーと同じ順（parsePatchQuestionBody → planQuestionEdit）で反映した結果。DB の行は original と同じ内容とみなす */
function applyOnServer(original: AdminQuizQuestion, body: unknown, rawOptions: unknown = original.options) {
  const parsed = parsePatchQuestionBody(body);
  if ("reason" in parsed) return { error: `parse:${parsed.reason}` } as const;
  const plan = planQuestionEdit({ question: original.question, options: rawOptions as never, correctIndex: original.correctIndex }, parsed.value);
  if ("reason" in plan) return { error: `plan:${plan.reason}` } as const;
  return { plan: plan.value } as const;
}

describe("送る body：乱数で元の問題の形（壊れた選択肢・範囲外の正解・前後の空白・10 件）も変えて照合（tester 追加）", () => {
  it("ready の body はサーバーで通り、反映後は下書きどおり。選択肢か正解を送れば、反映後の問題は受験できる形になる", () => {
    const rand = rng(0x81_0a02);
    const words = ["甲", "乙", "丙", "丁", " 戊 ", "己", "庚", "\u200B", "甲\u200B", "か\u3099", "が"];
    let ready = 0;
    let fromBroken = 0;
    let fromOutOfRange = 0;
    const counts = { unchanged: 0, invalid: 0 };
    for (let round = 0; round < 600; round++) {
      const kind = rand(5);
      const n = kind === 4 ? MAX_OPTIONS : 2 + rand(5);
      const base = Array.from({ length: n }, (_, i) => (rand(3) === 0 ? ` 元${i} ` : `元${i}`));
      let original: AdminQuizQuestion;
      if (kind === 0) original = question({ options: null, correctIndex: rand(4), valid: false });
      else if (kind === 1) original = question({ options: base, correctIndex: n + rand(3), valid: false });
      else if (kind === 2) original = question({ options: base, correctIndex: -1, valid: false });
      else original = question({ options: base, correctIndex: rand(n), question: rand(2) === 0 ? " 元の問題 " : "元の問題" });
      let d = initialQuestionDraft(original);
      const steps = 1 + rand(7);
      for (let step = 0; step < steps; step++) {
        const k = d.options[rand(d.options.length)].key;
        switch (rand(7)) {
          case 0: d = moveDraftOption(d, k, rand(2) === 0 ? -1 : 1); break;
          case 1: d = removeDraftOption(d, k); break;
          case 2: { const next = d.nextKey; d = addDraftOption(d); d = setDraftOptionText(d, next, `追加${round}-${step}`); break; }
          case 3: d = setDraftOptionText(d, k, words[rand(words.length)] + (rand(2) === 0 ? round : "")); break;
          case 4:
          case 5: d = setDraftCorrect(d, k); break;
          default: d = setDraftQuestion(d, rand(2) === 0 ? original.question : `問題${round}`);
        }
      }
      // 壊れた元の問題は、空の選択肢を埋めないと送れないので、半分は埋める
      if (kind === 0 && rand(2) === 0) d.options.forEach((o, i) => { if (o.text.trim() === "") d = setDraftOptionText(d, o.key, `埋めた${i}`); });

      const out = questionEditOutcome(original, d);
      if (out.kind !== "ready") {
        counts[out.kind]++;
        if (out.kind === "unchanged") {
          assert.ok(original.options !== null, `壊れた選択肢の問題が unchanged になった：${JSON.stringify(d)}`);
          assert.equal(d.question.trim(), original.question.trim(), "問題文が違うのに unchanged");
          assert.deepEqual(d.options.map((o) => o.text.trim()), original.options!.map((o) => o.trim()), "選択肢が違うのに unchanged");
        }
        continue;
      }
      ready++;
      if (kind === 0) fromBroken++;
      if (kind === 1 || kind === 2) fromOutOfRange++;
      const r = applyOnServer(original, out.body);
      assert.ok(!("error" in r), `サーバーで通らない（${"error" in r ? r.error : ""}）：${JSON.stringify({ original, body: out.body })}`);
      const after = r.plan.after;
      assert.deepEqual([...r.plan.changed], out.changed, `サーバーが変わったとみなす項目が違う：${JSON.stringify(out.body)}`);
      assert.equal((after.question as string).trim(), d.question.trim(), "反映後の問題文が下書きと違う");
      const touched = out.body.options !== undefined || out.body.correctIndex !== undefined;
      if (touched) {
        const correct = d.options.find((o) => o.key === d.correctKey);
        assert.ok(correct, `選択肢・正解を送るのに正解がない：${JSON.stringify(d)}`);
        assert.equal((after.options as string[])[after.correctIndex].trim(), correct.text.trim(), "反映後の正解が下書きの正解の選択肢と違う");
        assert.ok(toAnswerKey([{ options: after.options, correctIndex: after.correctIndex }]) !== null, `反映後も受験できない形：${JSON.stringify(after)}`);
      }
      if (out.body.options !== undefined) {
        assert.deepEqual(after.options, d.options.map((o) => o.text.trim()), "反映後の選択肢が下書きと違う");
      } else {
        assert.deepEqual(
          (after.options as string[] | null)?.map((o) => o.trim()) ?? null,
          d.options.map((o) => o.text.trim()),
          "選択肢を送らなかったのに、反映後の選択肢（前後の空白を除く）が下書きと違う"
        );
      }
    }
    assert.ok(ready >= 150, `ready の回数が少ない（検査の前提）：${ready}`);
    assert.ok(fromBroken >= 10 && fromOutOfRange >= 10, `壊れた問題からの ready が少ない（検査の前提）：${fromBroken} / ${fromOutOfRange}`);
    assert.ok(counts.unchanged >= 5 && counts.invalid >= 20, `unchanged / invalid の回数が少ない（検査の前提）：${JSON.stringify(counts)}`);
  });

  it("10 件で追加・削除・並べ替えを組み合わせる：正解の選択肢を末尾へ動かしたあと 1 つ消しても、正解の位置は詰めて送る", () => {
    const original = question({ options: Array.from({ length: MAX_OPTIONS }, (_, i) => `元${i}`), correctIndex: 0 });
    let d = initialQuestionDraft(original);
    assert.equal(addDraftOption(d), d, "10 件で追加できた");
    const correctKey = keyAt(d, 0);
    for (let i = 0; i < MAX_OPTIONS; i++) d = moveDraftOption(d, correctKey, 1);
    assert.equal(d.options[MAX_OPTIONS - 1].key, correctKey, "末尾まで動いていない");
    d = removeDraftOption(d, keyAt(d, 3));
    d = addDraftOption(d);
    d = setDraftOptionText(d, d.options[d.options.length - 1].key, "追加");
    // 並び：元1, 元2, 元3, 元5, ..., 元9, 元0（正解）, 追加
    const out = questionEditOutcome(original, d);
    assert.equal(out.kind, "ready");
    if (out.kind !== "ready") return;
    assert.deepEqual(out.body.options, ["元1", "元2", "元3", "元5", "元6", "元7", "元8", "元9", "元0", "追加"]);
    assert.equal(out.body.correctIndex, 8);
    const r = applyOnServer(original, out.body);
    assert.ok(!("error" in r), "サーバーで通らない");
    assert.equal((r.plan.after.options as string[])[r.plan.after.correctIndex], "元0", "正解が元の正解の選択肢でない");
  });
});

describe("元のデータが今の規則の外にある問題（tester 追加）", () => {
  it("選択肢が 11 件（旧 API で入りうる）：削除して 10 件にすれば保存できる", () => {
    const original = question({ options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => `元${i}`), correctIndex: 2 });
    let d = initialQuestionDraft(original);
    assert.equal(d.options.length, MAX_OPTIONS + 1);
    // 文を 1 つ直すだけでは、いまの件数を添えて 10 件以下にするよう知らせる
    const textOnly = questionEditOutcome(original, setDraftOptionText(d, keyAt(d, 0), "直した"));
    assert.deepEqual(textOnly, { kind: "invalid", message: "選択肢を 10 件以下にしてください（いま 11 件）" });
    assert.equal(tooManyOptionsMessage(13), "選択肢を 10 件以下にしてください（いま 13 件）");
    // 選択肢を変えない（問題文だけ）なら、件数は確かめずに送る（サーバーも選択肢を送らなければ件数を見ない）
    assert.deepEqual(questionEditOutcome(original, setDraftQuestion(d, "直した問題文")), { kind: "ready", body: { revision: REV, question: "直した問題文" }, changed: ["question"] });
    // 正解が範囲外（正解を選んでいない）でも、件数の文言を先に出す
    const outOfRange = { ...original, correctIndex: 99, valid: false };
    const od = initialQuestionDraft(outOfRange);
    assert.equal(od.correctKey, null);
    assert.deepEqual(questionEditOutcome(outOfRange, setDraftOptionText(od, keyAt(od, 0), "直した")), { kind: "invalid", message: tooManyOptionsMessage(MAX_OPTIONS + 1) });
    d = removeDraftOption(d, keyAt(d, MAX_OPTIONS));
    const out = questionEditOutcome(original, d);
    assert.equal(out.kind, "ready");
    if (out.kind === "ready") assert.ok(!("error" in applyOnServer(original, out.body)), "10 件に減らしてもサーバーで通らない");
  });

  it("選択肢の文に前後の空白がある問題：空白だけを直す変更は unchanged（保存は押せない）。ほかを直せば空白を除いて送る", () => {
    const original = question({ options: [" 選択肢A", "選択肢B ", "選択肢C"], correctIndex: 0 });
    const d = initialQuestionDraft(original);
    assert.deepEqual(questionEditOutcome(original, setDraftOptionText(d, keyAt(d, 0), "選択肢A")), { kind: "unchanged" });
    const out = questionEditOutcome(original, setDraftOptionText(d, keyAt(d, 2), "選択肢D"));
    assert.deepEqual(out, { kind: "ready", body: { revision: REV, options: ["選択肢A", "選択肢B", "選択肢D"] }, changed: ["options"] });
  });

  it("元の選択肢どうしが前後の空白を除くと重複する問題：正解だけを直すなら選択肢を送らずに保存できる", () => {
    const original = question({ options: ["同じ", "同じ ", "別"], correctIndex: 0 });
    const d = initialQuestionDraft(original);
    const out = questionEditOutcome(original, setDraftCorrect(d, keyAt(d, 2)));
    assert.deepEqual(out, { kind: "ready", body: { revision: REV, correctIndex: 2 }, changed: ["correctIndex"] });
    // 選択肢の文を直すと、重複は保存の前に断る
    assert.deepEqual(questionEditOutcome(original, setDraftOptionText(d, keyAt(d, 2), "別2")), { kind: "invalid", message: patchReasonMessage("invalid_options") });
  });

  it("壊れた選択肢の問題：空の選択肢を埋めずに正解だけ選んでも送らない（選択肢の誤り）", () => {
    const broken = question({ options: null, correctIndex: 3, valid: false });
    let d = initialQuestionDraft(broken);
    assert.deepEqual(d.options.map((o) => o.text), Array.from({ length: MIN_OPTIONS }, () => ""));
    assert.equal(d.correctKey, null, "壊れた問題で正解が選ばれている");
    d = setDraftCorrect(d, keyAt(d, 0));
    assert.deepEqual(questionEditOutcome(broken, d), { kind: "invalid", message: patchReasonMessage("invalid_options") });
    d = setDraftOptionText(setDraftOptionText(d, keyAt(d, 0), "A"), keyAt(d, 1), "B");
    const out = questionEditOutcome(broken, d);
    assert.deepEqual(out, { kind: "ready", body: { revision: REV, options: ["A", "B"], correctIndex: 0 }, changed: ["options", "correctIndex"] });
  });

  it("正解が範囲外の問題：選択肢を並べ替えただけ（正解を選んでいない）は、正解を選ぶよう知らせる", () => {
    const out = question({ correctIndex: 7, valid: false });
    const d = moveDraftOption(initialQuestionDraft(out), 0, 1);
    assert.deepEqual(questionEditOutcome(out, d), { kind: "invalid", message: CORRECT_NOT_SELECTED_MESSAGE });
  });
});

describe("入力の境界と文言（tester 追加）", () => {
  const q = question();
  const d = initialQuestionDraft(q);

  it("問題文の長さ：前後の空白は数えない。サロゲートペアは 1 字、結合文字は別の 1 字", () => {
    const padded = " \n" + "\u{20BB7}".repeat(QUESTION_MAX_LENGTH) + "\u3000 ";
    const ok = questionEditOutcome(q, setDraftQuestion(d, padded));
    assert.equal(ok.kind, "ready", "前後の空白を除いて 1000 字なのに断った");
    if (ok.kind === "ready") assert.equal(ok.body.question, "\u{20BB7}".repeat(QUESTION_MAX_LENGTH), "前後の空白を除いて送っていない");
    assert.equal(questionEditOutcome(q, setDraftQuestion(d, "\u{1F600}".repeat(QUESTION_MAX_LENGTH + 1))).kind, "invalid", "1001 字（サロゲートペア）を通した");
    // 「か」+ 濁点の結合文字は 2 字と数える（サーバーと同じ。見た目は 1000 字でも 2000 字）
    assert.equal(questionEditOutcome(q, setDraftQuestion(d, "か\u3099".repeat(QUESTION_MAX_LENGTH / 2))).kind, "ready");
    assert.equal(questionEditOutcome(q, setDraftQuestion(d, "か\u3099".repeat(QUESTION_MAX_LENGTH / 2) + "か")).kind, "invalid");
  });

  it("選択肢の長さ：300 字（サロゲートペア）は通り、301 字は断る", () => {
    assert.equal(questionEditOutcome(q, setDraftOptionText(d, keyAt(d, 0), "\u{1F600}".repeat(OPTION_MAX_LENGTH))).kind, "ready");
    assert.deepEqual(
      questionEditOutcome(q, setDraftOptionText(d, keyAt(d, 0), "\u{1F600}".repeat(OPTION_MAX_LENGTH + 1))),
      { kind: "invalid", message: patchReasonMessage("invalid_options") }
    );
  });

  it("使えない文字：NUL・対になっていないサロゲート（上位だけ・下位だけ・逆順）は、問題文でも選択肢でも断る", () => {
    for (const bad of ["A\u0000B", "\u0000", "A\uD83D", "\uDE00A", "\uDE00\uD83D"]) {
      assert.deepEqual(questionEditOutcome(q, setDraftQuestion(d, bad)), { kind: "invalid", message: patchReasonMessage("invalid_question") }, `問題文 ${JSON.stringify(bad)}`);
      assert.deepEqual(questionEditOutcome(q, setDraftOptionText(d, keyAt(d, 0), bad)), { kind: "invalid", message: patchReasonMessage("invalid_options") }, `選択肢 ${JSON.stringify(bad)}`);
    }
    // 正しいサロゲートペアは通る
    assert.equal(questionEditOutcome(q, setDraftQuestion(d, "A😀")).kind, "ready");
  });

  it("見えない文字だけ（ゼロ幅・BOM・ワードジョイナー・全角空白・ソフトハイフン）は断る", () => {
    for (const bad of ["\u200B", "\uFEFF", "\u2060\u200D", "\u3000\u200B", "\u00AD", "\u200E\u200F"]) {
      assert.deepEqual(questionEditOutcome(q, setDraftQuestion(d, bad)), { kind: "invalid", message: patchReasonMessage("invalid_question") }, `問題文 ${JSON.stringify(bad)}`);
      assert.deepEqual(questionEditOutcome(q, setDraftOptionText(d, keyAt(d, 0), bad)), { kind: "invalid", message: patchReasonMessage("invalid_options") }, `選択肢 ${JSON.stringify(bad)}`);
    }
  });

  it("見た目が同じ選択肢の重複：ゼロ幅・異体字セレクタ・ソフトハイフン・NFC と NFD・前後の空白を同じとみなす", () => {
    const pairs: Array<[string, string]> = [
      ["選択肢B\u200B", "ゼロ幅スペース"],
      ["\u200B選択肢B", "先頭のゼロ幅スペース"],
      ["選択肢B\uFE0F", "異体字セレクタ"],
      ["選択\u00AD肢B", "ソフトハイフン"],
      ["選択肢B\u2060", "ワードジョイナー"],
      [" 選択肢B\u3000", "前後の空白・全角空白"],
    ];
    for (const [text, label] of pairs) {
      assert.deepEqual(questionEditOutcome(q, setDraftOptionText(d, keyAt(d, 0), text)), { kind: "invalid", message: patchReasonMessage("invalid_options") }, label);
    }
    const nfc = setDraftOptionText(setDraftOptionText(d, keyAt(d, 0), "が"), keyAt(d, 2), "か\u3099");
    assert.deepEqual(questionEditOutcome(q, nfc), { kind: "invalid", message: patchReasonMessage("invalid_options") }, "NFC と NFD");
  });

  it("問題文を NFD に書き換えただけ（見た目は同じ）は、変更として送る（サーバーも別の値として保存する）", () => {
    const nfcOriginal = question({ question: "がっこう" });
    const out = questionEditOutcome(nfcOriginal, setDraftQuestion(initialQuestionDraft(nfcOriginal), "か\u3099っこう"));
    assert.equal(out.kind, "ready", "NFD の問題文を unchanged とみなした");
    if (out.kind === "ready") {
      const r = applyOnServer(nfcOriginal, out.body);
      assert.ok(!("error" in r) && r.plan.changed.includes("question"), "サーバーが変わったとみなさない");
    }
  });
});

describe("確認文・応答の境界（tester 追加）", () => {
  it("確認文：受験 0 件で選択肢を変えると受験中の注意だけ。受験数が不正（負・小数）なら過去の受験の注意を出さない", () => {
    assert.deepEqual(questionEditConfirmLines(["options", "correctIndex"], 0), ["選択肢を変えると、いま受験中の受講生は回答のやり直しになります"]);
    assert.deepEqual(questionEditConfirmLines(["question", "correctIndex"], 0), []);
    assert.deepEqual(questionEditConfirmLines(["question"], -1), []);
    assert.deepEqual(questionEditConfirmLines(["question"], 1.5), []);
    assert.deepEqual(questionEditConfirmLines(["question"], 1), ["過去の受験 1 件の点数・合否は変わりません"]);
  });

  it("PATCH の応答：204（本文なし）・2xx の配列・3xx は結果不明。401 は（呼び出し側が先に扱うが）保存されていない扱い", () => {
    const base = { redirected: false, questionId: "qq1" };
    assert.deepEqual(interpretQuestionPatchResponse({ ...base, ok: true, status: 204, body: null }), { kind: "uncertain", message: SAVE_UNCERTAIN_MESSAGE });
    assert.deepEqual(interpretQuestionPatchResponse({ ...base, ok: true, status: 200, body: [] }), { kind: "uncertain", message: SAVE_UNCERTAIN_MESSAGE });
    assert.deepEqual(interpretQuestionPatchResponse({ ...base, ok: true, status: 200, body: { question: question(), changed: [], attemptCount: 0 }, redirected: true }), { kind: "uncertain", message: SAVE_UNCERTAIN_MESSAGE });
    // 変わった項目が重複・不明なら結果不明
    assert.equal(interpretQuestionPatchResponse({ ...base, ok: true, status: 200, body: { question: question(), changed: ["revision"], attemptCount: 0 } }).kind, "uncertain");
  });
});

describe("一覧の並び（tester 追加）", () => {
  const s = (id: string, courseId: string | null, over: Partial<AdminQuizSummary> = {}): AdminQuizSummary => ({
    id,
    title: `タイトル${id}`,
    type: "MINI",
    courseId,
    courseName: courseId === null ? null : `コース${courseId}`,
    lessonTitle: "レッスン",
    questionCount: 1,
    attemptCount: 0,
    status: courseId === null ? "no_course" : "ok",
    ...over,
  });

  it("コースが交互に来ても最初に出た順でまとめ、行はサーバーの順。コースなしは途中にあっても最後", () => {
    const groups = toAdminQuizGroups([s("1", "a"), s("2", null), s("3", "b"), s("4", "a"), s("5", null), s("6", "b")]);
    assert.deepEqual(groups.map((g) => [g.courseName, g.rows.map((r) => r.id)]), [
      ["コースa", ["1", "4"]],
      ["コースb", ["3", "6"]],
      ["コースなし", ["2", "5"]],
    ]);
    assert.equal(new Set(groups.map((g) => g.key)).size, groups.length, "まとまりの key が重複している");
  });

  it("コースの id が \"no-course\" でも、コースなしのまとまりと key が重ならない", () => {
    const groups = toAdminQuizGroups([s("1", "no-course"), s("2", null)]);
    assert.equal(new Set(groups.map((g) => g.key)).size, 2, "key が重なった");
  });

  it("修了テストはレッスン名を出さない（lessonTitle があっても）。ミニテストでレッスン名が空文字なら —", () => {
    const groups = toAdminQuizGroups([s("1", "a", { type: "FINAL", lessonTitle: "レッスン" }), s("2", "a", { lessonTitle: "" })]);
    assert.deepEqual(groups[0].rows.map((r) => r.lessonLabel), ["—", "—"]);
  });

  it("コースなしだけの一覧・0 件の一覧", () => {
    assert.deepEqual(toAdminQuizGroups([s("1", null)]).map((g) => [g.noCourse, g.courseName]), [[true, "コースなし"]]);
    assert.deepEqual(toAdminQuizGroups([]), []);
  });
});
