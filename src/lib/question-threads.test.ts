import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addedThreadCount,
  QUESTION_TABS,
  THREADS_PAGE_SIZE,
  answeredLabel,
  decodeThreadCursor,
  encodeThreadCursor,
  firstPageRowCount,
  isAnswered,
  parseThreadListQuery,
  readThreadPage,
  THREAD_SUMMARY_MAX_CHARS,
  threadListUrl,
  threadRowDelay,
  threadSummary,
  threadsAddedMessage,
  threadsEmptyMessage,
  threadsMoreHint,
  toQuestionThreadItems,
  toQuestionThreadView,
  unlockedCourseIds,
  type QuestionThreadRow,
} from "./question-threads";

// #32 質問スレッド一覧の純粋関数。DB・ネットワーク・DOM なし。データはすべてダミー。

const q = (s: string) => new URLSearchParams(s);
const NOW = new Date("2026-10-08T12:00:00.000Z");

describe("encodeThreadCursor / decodeThreadCursor", () => {
  it("<epochMillis>.<id> の往復", () => {
    const d = new Date("2026-10-08T01:02:03.456Z");
    const s = encodeThreadCursor(d, "c_1");
    assert.equal(s, `${d.getTime()}.c_1`);
    const back = decodeThreadCursor(s);
    assert.ok(back);
    assert.equal(back.createdAt.getTime(), d.getTime());
    assert.equal(back.id, "c_1");
  });

  it("id に . があっても最初の . で分ける", () => {
    const back = decodeThreadCursor("1000.a.b");
    assert.deepEqual(back && [back.createdAt.getTime(), back.id], [1000, "a.b"]);
  });

  it("epoch 0 は読める", () => {
    assert.equal(decodeThreadCursor("0.x")?.createdAt.getTime(), 0);
  });

  for (const bad of [
    "",
    "1000",
    ".x",
    "1000.",
    "-1.x",
    "1e3.x",
    " 15.x",
    "0x10.x",
    "１０００.x",
    "9999999999999999.x",
    `1000.${"a".repeat(65)}`,
  ]) {
    it(`不正：${JSON.stringify(bad)} は null`, () => {
      assert.equal(decodeThreadCursor(bad), null);
    });
  }

  it("15 桁（Date の範囲内）までは読める", () => {
    assert.equal(decodeThreadCursor("999999999999999.x")?.createdAt.getTime(), 999999999999999);
  });

  it("文字列以外は null", () => {
    for (const v of [null, undefined, 1000, {}, ["1000.x"]]) assert.equal(decodeThreadCursor(v), null);
  });

  it("64 文字の id は読める", () => {
    assert.equal(decodeThreadCursor(`5.${"a".repeat(64)}`)?.id.length, 64);
  });
});

describe("parseThreadListQuery", () => {
  it("何もなければ既定値", () => {
    assert.deepEqual(parseThreadListQuery(q("")), { ok: true, value: { mine: false, status: "all", courseId: null, cursor: null } });
  });

  it("知らないパラメータは無視する", () => {
    const r = parseThreadListQuery(q("foo=bar&userId=x&take=1000"));
    assert.deepEqual(r, { ok: true, value: { mine: false, status: "all", courseId: null, cursor: null } });
  });

  for (const [v, want] of [["1", true], ["true", true], ["0", false], ["false", false]] as Array<[string, boolean]>) {
    it(`mine=${v} は ${want}`, () => {
      const r = parseThreadListQuery(q(`mine=${v}`));
      assert.ok("value" in r);
      assert.equal(r.value.mine, want);
    });
  }

  for (const v of ["", "yes", "TRUE", "2"]) {
    it(`mine=${JSON.stringify(v)} は invalid_mine`, () => {
      assert.deepEqual(parseThreadListQuery(q(`mine=${v}`)), { ok: false, reason: "invalid_mine" });
    });
  }

  for (const v of ["all", "answered", "unanswered"]) {
    it(`status=${v}`, () => {
      const r = parseThreadListQuery(q(`status=${v}`));
      assert.ok("value" in r);
      assert.equal(r.value.status, v);
    });
  }

  for (const v of ["", "open", "ANSWERED", "resolved"]) {
    it(`status=${JSON.stringify(v)} は invalid_status`, () => {
      assert.deepEqual(parseThreadListQuery(q(`status=${v}`)), { ok: false, reason: "invalid_status" });
    });
  }

  it("courseId：64 文字まで。空・65 文字は invalid_course_id", () => {
    const ok = parseThreadListQuery(q(`courseId=${"c".repeat(64)}`));
    assert.ok("value" in ok);
    assert.equal(ok.value.courseId, "c".repeat(64));
    assert.deepEqual(parseThreadListQuery(q("courseId=")), { ok: false, reason: "invalid_course_id" });
    assert.deepEqual(parseThreadListQuery(q(`courseId=${"c".repeat(65)}`)), { ok: false, reason: "invalid_course_id" });
  });

  it("cursor：読めれば値、読めなければ invalid_cursor", () => {
    const ok = parseThreadListQuery(q("cursor=1000.c_9"));
    assert.ok("value" in ok);
    assert.equal(ok.value.cursor?.createdAt.getTime(), 1000);
    assert.equal(ok.value.cursor?.id, "c_9");
    for (const bad of ["", "abc", "1000", "-5.x"]) {
      assert.deepEqual(parseThreadListQuery(q(`cursor=${encodeURIComponent(bad)}`)), { ok: false, reason: "invalid_cursor" }, bad);
    }
  });

  it("同じ名前が複数なら最初の値", () => {
    const r = parseThreadListQuery(q("status=answered&status=bogus"));
    assert.ok("value" in r);
    assert.equal(r.value.status, "answered");
  });

  it("全部の組み合わせ", () => {
    const r = parseThreadListQuery(q("mine=1&status=unanswered&courseId=course_1&cursor=42.c"));
    assert.ok("value" in r);
    assert.equal(r.value.mine, true);
    assert.equal(r.value.status, "unanswered");
    assert.equal(r.value.courseId, "course_1");
    assert.equal(r.value.cursor?.id, "c");
  });
});

describe("unlockedCourseIds（course-lock の isCourseLocked と同じ規則）", () => {
  const course = (id: string, lessonIds: string[][]) => ({
    id,
    sections: lessonIds.map((ls) => ({ lessons: ls.map((l) => ({ id: l })) })),
  });
  const courses = [course("c1", [["l1", "l2"]]), course("c2", [["l3"], ["l4"]]), course("c3", [["l5"]])];

  it("何も終えていなければ最初のコースだけ", () => {
    assert.deepEqual(unlockedCourseIds(courses, new Set()), ["c1"]);
  });

  it("前のコースを全部終えれば次が解放される", () => {
    assert.deepEqual(unlockedCourseIds(courses, new Set(["l1", "l2"])), ["c1", "c2"]);
  });

  it("前のコースが途中でも、このコースを 1 件でも終えていれば解放", () => {
    assert.deepEqual(unlockedCourseIds(courses, new Set(["l1", "l5"])), ["c1", "c3"]);
  });

  it("レッスンのない前のコースは終えたことにならない", () => {
    assert.deepEqual(unlockedCourseIds([course("c1", []), course("c2", [["l1"]])], new Set()), ["c1"]);
  });

  it("コースがなければ空", () => {
    assert.deepEqual(unlockedCourseIds([], new Set(["l1"])), []);
  });
});

// ───────────── toQuestionThreadView ─────────────

const at = (m: number) => new Date(NOW.getTime() - m * 60_000);
const student = { name: "受講生エー", role: "STUDENT", deactivatedAt: null };
const gone = { name: "受講生ゴーン", role: "STUDENT", deactivatedAt: at(10) };
const teacher = { name: "講師ビー", role: "INSTRUCTOR", deactivatedAt: null };

function row(over: Partial<QuestionThreadRow> = {}): QuestionThreadRow {
  return {
    id: "c1",
    content: "質問本文",
    createdAt: at(300),
    userId: "stu_a",
    user: student,
    lesson: { id: "l1", title: "レッスン1", section: { course: { id: "co1", name: "STEP1" } } },
    replies: [],
    ...over,
  };
}

describe("toQuestionThreadView", () => {
  it("返信なし：未回答・0 件・lastReplyAt は null。lesson / course を足す", () => {
    const v = toQuestionThreadView(row(), "stu_a");
    assert.deepEqual(v, {
      id: "c1",
      content: "質問本文",
      createdAt: at(300).toISOString(),
      author: { name: "受講生エー", isInstructor: false },
      mine: true,
      replies: [],
      lesson: { id: "l1", title: "レッスン1" },
      course: { id: "co1", name: "STEP1" },
      replyCount: 0,
      lastReplyAt: null,
      answered: false,
    });
  });

  it("講師の返信があれば回答済み。lastReplyAt は最も新しい返信", () => {
    const v = toQuestionThreadView(
      row({
        replies: [
          { id: "r1", content: "回答", createdAt: at(100), userId: "ins", user: teacher, lessonId: "l1" },
          { id: "r2", content: "追記", createdAt: at(50), userId: "stu_g", user: gone, lessonId: "l1" },
        ],
      }),
      "other"
    );
    assert.equal(v.answered, true);
    assert.equal(v.replyCount, 2);
    assert.equal(v.lastReplyAt, at(50).toISOString());
    assert.equal(v.mine, false);
    assert.deepEqual(v.replies.map((r) => [r.id, r.author]), [
      ["r1", { name: "講師ビー", isInstructor: true }],
      ["r2", { name: null, isInstructor: false }],
    ]);
  });

  it("受講生の返信だけなら未回答", () => {
    const v = toQuestionThreadView(
      row({ replies: [{ id: "r1", content: "追記", createdAt: at(100), userId: "stu_a", user: student, lessonId: "l1" }] }),
      "stu_a"
    );
    assert.equal(v.answered, false);
    assert.equal(v.replyCount, 1);
  });

  it("別レッスンの返信は数えず・表示せず・回答済みにもしない", () => {
    const r = row({ replies: [{ id: "rx", content: "別レッスンの回答", createdAt: at(1), userId: "ins", user: teacher, lessonId: "l2" }] });
    const v = toQuestionThreadView(r, "stu_a");
    assert.equal(v.answered, false);
    assert.equal(v.replyCount, 0);
    assert.equal(v.lastReplyAt, null);
    assert.deepEqual(v.replies, []);
    assert.equal(isAnswered(r), false);
  });

  it("無効化された受講生の質問は name: null", () => {
    assert.deepEqual(toQuestionThreadView(row({ user: gone }), "x").author, { name: null, isInstructor: false });
  });

  it("応答に userId・role・deactivatedAt・section を含めない", () => {
    const text = JSON.stringify(
      toQuestionThreadView(
        row({ replies: [{ id: "r1", content: "回答", createdAt: at(100), userId: "ins", user: teacher, lessonId: "l1" }] }),
        "x"
      )
    );
    for (const k of ["userId", "role", "deactivatedAt", "section", "lessonId", "stu_a", "INSTRUCTOR", "STUDENT"]) {
      assert.doesNotMatch(text, new RegExp(k), k);
    }
  });
});

// ───────────── 画面側 ─────────────

describe("タブ・URL・文言", () => {
  it("タブは すべて / 自分の質問 / 未回答", () => {
    assert.deepEqual(QUESTION_TABS.map((t) => t.label), ["すべて", "自分の質問", "未回答"]);
  });

  it("threadListUrl", () => {
    assert.equal(threadListUrl("all", null), "/api/comments");
    assert.equal(threadListUrl("mine", null), "/api/comments?mine=1");
    assert.equal(threadListUrl("unanswered", null), "/api/comments?status=unanswered");
    assert.equal(threadListUrl("all", "1000.c/1&x"), "/api/comments?cursor=1000.c%2F1%26x");
    assert.equal(threadListUrl("mine", "5.a"), "/api/comments?mine=1&cursor=5.a");
  });

  it("threadListUrl の結果は parseThreadListQuery で読める", () => {
    for (const t of QUESTION_TABS) {
      const url = new URL(threadListUrl(t.key, encodeThreadCursor(new Date(1000), "c.1")), "https://nwa-lms.example.com");
      const r = parseThreadListQuery(url.searchParams);
      assert.ok("value" in r, t.key);
      assert.equal(r.value.mine, t.key === "mine");
      assert.equal(r.value.status, t.key === "unanswered" ? "unanswered" : "all");
      assert.equal(r.value.cursor?.id, "c.1");
    }
  });

  it("空の文言", () => {
    assert.equal(threadsEmptyMessage("all"), "まだ質問はありません");
    assert.equal(threadsEmptyMessage("unanswered"), "未回答の質問はありません");
    assert.equal(threadsEmptyMessage("mine"), "まだ質問していません");
  });

  it("0 件で続きがあるときの説明（タブごと）", () => {
    assert.equal(threadsMoreHint("all"), "ここまでに表示できる質問はありません。古い質問を続けて確認できます");
    assert.equal(threadsMoreHint("unanswered"), "ここまでに未回答の質問はありません。古い質問を続けて確認できます");
    assert.equal(threadsMoreHint("mine"), "ここまでに自分の質問はありません。古い質問を続けて確認できます");
    const hints = QUESTION_TABS.map((t) => threadsMoreHint(t.key));
    assert.equal(new Set(hints).size, hints.length, "タブごとに文言が違うはず");
    for (const t of QUESTION_TABS) {
      assert.notEqual(threadsMoreHint(t.key), threadsEmptyMessage(t.key), `${t.key}：空の案内と同じ文言になっている`);
    }
  });

  it("読み足した結果の知らせ", () => {
    assert.equal(threadsAddedMessage(1), "1 件を追加しました");
    assert.equal(threadsAddedMessage(20), "20 件を追加しました");
    assert.equal(threadsAddedMessage(0), "追加できる質問はありませんでした");
  });

  it("addedThreadCount：増えた表示の行の数（壊れた要素と、前のページとの重複を除く）", () => {
    const row = (id: unknown) => ({ id, content: "本文", createdAt: new Date(0).toISOString(), author: { name: "受講生エー", isInstructor: false } });
    assert.equal(addedThreadCount([], []), 0);
    assert.equal(addedThreadCount([], [row("a"), row("b")]), 2);
    assert.equal(addedThreadCount([row("a")], [row("a"), row("b"), null, row("")]), 1);
    assert.equal(addedThreadCount([row("a"), row("b")], [row("b")]), 0);
  });

  it("answeredLabel", () => {
    assert.equal(answeredLabel(true), "回答済み");
    assert.equal(answeredLabel(false), "未回答");
  });

  it("1 ページは 20 件", () => {
    assert.equal(THREADS_PAGE_SIZE, 20);
  });
});

describe("readThreadPage", () => {
  it("threads が配列なら読む。nextCursor は空でない文字列だけ", () => {
    assert.deepEqual(readThreadPage({ threads: [], nextCursor: "1.a" }), { threads: [], nextCursor: "1.a" });
    assert.deepEqual(readThreadPage({ threads: [1] }), { threads: [1], nextCursor: null });
    assert.deepEqual(readThreadPage({ threads: [], nextCursor: "" }), { threads: [], nextCursor: null });
    assert.deepEqual(readThreadPage({ threads: [], nextCursor: 5 }), { threads: [], nextCursor: null });
  });

  it("壊れた応答は null", () => {
    for (const v of [null, undefined, [], "x", {}, { threads: "x" }, { threads: null }]) assert.equal(readThreadPage(v), null);
  });
});

describe("threadRowDelay", () => {
  it("1 ページ目（20 件）は 50ms ずつ、最大 500ms", () => {
    assert.deepEqual([0, 1, 5, 10, 11, 19].map((i) => threadRowDelay(i, THREADS_PAGE_SIZE)), [0, 50, 250, 500, 500, 500]);
  });

  it("1 ページ目が 20 件なら、足した行（20 行目以降）は 0", () => {
    for (const i of [THREADS_PAGE_SIZE, THREADS_PAGE_SIZE + 1, THREADS_PAGE_SIZE * 2 + 5, 1000]) {
      assert.equal(threadRowDelay(i, THREADS_PAGE_SIZE), 0, String(i));
    }
  });

  it("1 ページ目が 3 件なら、3 行目以降（足した行）は 0", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 19, 20].map((i) => threadRowDelay(i, 3)), [0, 50, 100, 0, 0, 0, 0]);
  });

  it("1 ページ目が 0 件なら、すべての行（足した行）が 0", () => {
    for (const i of [0, 1, 5, 19, 20]) assert.equal(threadRowDelay(i, 0), 0, String(i));
  });
});

describe("firstPageRowCount", () => {
  const row = (id: unknown) => ({ id, content: "本文", createdAt: new Date(0).toISOString(), author: { name: "受講生エー", isInstructor: false } });

  it("表示される行の数（壊れた要素と重複を除く）", () => {
    assert.equal(firstPageRowCount([]), 0);
    assert.equal(firstPageRowCount([row("a"), row("b"), row("c")]), 3);
    assert.equal(firstPageRowCount([row("a"), null, row(5), row(""), row("a"), row("b")]), 2);
  });

  it("toQuestionThreadItems の行数と同じ", () => {
    const rows = [row("a"), "x", row("a"), row("b")];
    assert.equal(firstPageRowCount(rows), toQuestionThreadItems(rows, new Date()).length);
  });
});

describe("threadSummary", () => {
  it("3 行以内・上限以内ならそのまま", () => {
    assert.equal(threadSummary("1行目\n2行目\n3行目"), "1行目\n2行目\n3行目");
    assert.equal(threadSummary(""), "");
  });

  it("4 行目以降は切って「…」を付ける", () => {
    assert.equal(threadSummary("1行目\n2行目\n3行目\n4行目"), "1行目\n2行目\n3行目…");
    assert.equal(threadSummary("a\nb\n\n\nc"), "a\nb…");
  });

  it("上限の文字数で切る（2000 字でも上限まで）", () => {
    const long = "あ".repeat(2000);
    const s = threadSummary(long);
    assert.equal(s, `${"あ".repeat(THREAD_SUMMARY_MAX_CHARS)}…`);
    assert.equal(threadSummary("あ".repeat(THREAD_SUMMARY_MAX_CHARS)), "あ".repeat(THREAD_SUMMARY_MAX_CHARS));
  });

  it("サロゲートペアを途中で分けない", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const s = threadSummary(emoji.repeat(THREAD_SUMMARY_MAX_CHARS + 5));
    assert.equal(s, `${emoji.repeat(THREAD_SUMMARY_MAX_CHARS)}…`);
  });
});

describe("toQuestionThreadItems", () => {
  const api = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    content: "質問本文",
    createdAt: at(120).toISOString(),
    author: { name: "受講生エー", isInstructor: false },
    mine: true,
    replies: [],
    lesson: { id: "l1", title: "レッスン1" },
    course: { id: "co1", name: "STEP1" },
    replyCount: 0,
    lastReplyAt: null,
    answered: false,
    ...over,
  });

  it("画面の行にする", () => {
    const [x] = toQuestionThreadItems([api()], NOW);
    assert.deepEqual(x, {
      id: "c1",
      name: "受講生エー",
      initial: "受",
      isInstructor: false,
      time: "2時間前",
      content: "質問本文",
      mine: true,
      summary: "質問本文",
      courseName: "STEP1",
      lessonTitle: "レッスン1",
      replyCount: 0,
      answered: false,
      answeredLabel: "未回答",
      replies: [],
    });
  });

  it("回答済み・返信・名前のない投稿者", () => {
    const [x] = toQuestionThreadItems(
      [
        api({
          answered: true,
          replyCount: 2,
          author: { name: null, isInstructor: false },
          replies: [
            { id: "r1", content: "回答", createdAt: at(30).toISOString(), author: { name: "講師ビー", isInstructor: true }, mine: false },
            { id: "r2", content: "追記", createdAt: at(10).toISOString(), author: { name: null, isInstructor: true }, mine: false },
          ],
        }),
      ],
      NOW
    );
    assert.equal(x.answered, true);
    assert.equal(x.answeredLabel, "回答済み");
    assert.equal(x.name, "受講生");
    assert.equal(x.initial, null);
    assert.deepEqual(x.replies.map((r) => [r.id, r.name, r.isInstructor, r.time]), [
      ["r1", "講師ビー", true, "30分前"],
      ["r2", "講師", true, "10分前"],
    ]);
  });

  it("answered は true のときだけ。replyCount が不正なら表示する返信の数", () => {
    const items = toQuestionThreadItems(
      [
        api({ id: "a", answered: "true", replyCount: -1, replies: [{ id: "ra", content: "x", author: {} }] }),
        api({ id: "b", answered: 1, replyCount: 1.5 }),
        api({ id: "c", replyCount: "3" }),
      ],
      NOW
    );
    assert.deepEqual(items.map((i) => [i.id, i.answered, i.replyCount]), [["a", false, 1], ["b", false, 0], ["c", false, 0]]);
  });

  it("course / lesson が壊れていれば空文字", () => {
    const [x] = toQuestionThreadItems([api({ course: null, lesson: { title: 1 } })], NOW);
    assert.equal(x.courseName, "");
    assert.equal(x.lessonTitle, "");
  });

  it("壊れた要素・空の id・重複した id（親・返信・ページをまたいで）を飛ばす（lesson-comments の toCommentItems と同じく親を先に見る）", () => {
    const items = toQuestionThreadItems(
      [
        null,
        "x",
        [],
        api({ id: "" }),
        api({ id: 5 }),
        api({ id: "noc", content: null }),
        api({
          id: "c1",
          replies: [{ id: "r1", content: "a" }, { id: "r1", content: "b" }, { id: "c1", content: "c" }, { id: "rz", content: "d" }, null, { id: "", content: "e" }],
        }),
        api({ id: "c1", content: "重複" }),
        api({ id: "rz", content: "返信と同じ id の親" }),
        api({ id: "c2" }),
      ],
      NOW
    );
    assert.deepEqual(items.map((i) => [i.id, i.content]), [["c1", "質問本文"], ["rz", "返信と同じ id の親"], ["c2", "質問本文"]]);
    assert.deepEqual(items[0].replies.map((r) => [r.id, r.content]), [["r1", "a"]]);
  });

  it("配列でなければ空", () => {
    for (const v of [null, undefined, {}, "x"]) assert.deepEqual(toQuestionThreadItems(v, NOW), []);
  });

  it("__proto__ などの id も通常の id として扱う", () => {
    const items = toQuestionThreadItems([api({ id: "__proto__" }), api({ id: "constructor" })], NOW);
    assert.deepEqual(items.map((i) => i.id), ["__proto__", "constructor"]);
  });
});
