import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickInitialLesson } from "./initial-lesson";

// #32 レッスン画面で最初に表示するレッスンの選び方。DB・ネットワークなし。データはすべてダミー。

type L = { id: string; completed: boolean };
const done = (id: string): L => ({ id, completed: true });
const todo = (id: string): L => ({ id, completed: false });
const isCompleted = (l: L) => l.completed;
const pick = (sections: Parameters<typeof pickInitialLesson<L>>[0]) => pickInitialLesson(sections, isCompleted)?.id ?? null;

describe("pickInitialLesson", () => {
  it("未完了のレッスンがあれば、並び順で最初の未完了（セクションをまたぐ）", () => {
    assert.equal(pick([{ lessons: [done("a"), todo("b"), todo("c")] }]), "b");
    assert.equal(pick([{ lessons: [done("a")] }, { lessons: [done("b"), todo("c")] }, { lessons: [todo("d")] }]), "c");
  });

  it("すべて完了済みなら、最初のレッスン", () => {
    assert.equal(pick([{ lessons: [done("a"), done("b")] }, { lessons: [done("c")] }]), "a");
  });

  it("すべて完了済みで最初のセクションが空なら、2 番目のセクションの最初のレッスン", () => {
    assert.equal(pick([{ lessons: [] }, { lessons: [done("b"), done("c")] }]), "b");
    assert.equal(pick([{}, { lessons: null }, { lessons: [done("c")] }]), "c");
  });

  it("レッスンが 0 件なら null", () => {
    assert.equal(pick([]), null);
    assert.equal(pick([{ lessons: [] }, {}]), null);
    assert.equal(pick(null), null);
    assert.equal(pick(undefined), null);
  });

  it("完了の判定は渡した関数に従う", () => {
    const lessons = [{ lessons: [todo("a"), todo("b")] }];
    assert.equal(pickInitialLesson(lessons, (l) => l.id === "a")?.id, "b");
  });
});

describe("page.tsx の LessonView が pickInitialLesson で初期レッスンを選ぶ", () => {
  const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");
  const start = src.indexOf("const LessonView = (");
  const end = src.indexOf("\nconst AdminDashboard = (");
  assert.ok(start >= 0 && end > start, "LessonView が見つからない");
  const lessonView = src.slice(start, end);

  it("pickInitialLesson を import して呼び、sections[0].lessons[0] だけを最後の手段にしていない", () => {
    assert.match(src, /import \{ pickInitialLesson \} from "@\/lib\/initial-lesson";/);
    assert.match(lessonView, /pickInitialLesson\(courseData\.sections, l => !!l\.completed\)/);
    assert.doesNotMatch(lessonView, /sections\[0\]\.lessons\[0\]/);
  });
});
