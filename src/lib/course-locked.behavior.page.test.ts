import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAuthFailure, makeAuthFetch, type SessionView } from "./client-session";
import {
  COMPLETE_FORBIDDEN_MESSAGE,
  COMPLETE_LOCKED_MESSAGE,
  completeRejection,
  isCourseLockedError,
  toRequestError,
} from "./course-locked";

// #47 P4 のテスト担当による追加。page.tsx（// @ts-nocheck）の swrFetcher と LessonView の handleComplete を、
// ソースの文字列から取り出して偽物（fetch・setState・トースト）を渡して実際に動かす（レンダリングはしない）。
// - makeAuthFetch（403 で /api/auth/session を確かめる）を通しても本文が読め、403 course_locked を区別できる
// - 500・ロック以外の 403・通信エラーは course_locked と取り違えない
// - セッション切れ（401、403 で失効）の既存の扱いを壊していない
// - handleComplete は 403 で楽観更新を戻し、次のレッスンへ進まない
// DB・ネットワークなし。データはすべてダミー。

const src = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

function slice(startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} が見つからない`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} が見つからない`);
  return src.slice(start, end);
}

/** page.tsx の swrFetcher（モジュールの最上位） */
const swrFetcherSrc = slice("const swrFetcher = async (url) => {", "\n};\n") + "\n};";
/** page.tsx の LessonView の handleComplete */
const handleCompleteSrc = slice("const handleComplete = async (lessonId) => {", "const isCompleted = (id) =>");

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function buildSwrFetcher(authFetch: Fetch): (url: string) => Promise<unknown> {
  const factory = new Function("authFetch", "classifyAuthFailure", "toRequestError", `${swrFetcherSrc}\nreturn swrFetcher;`);
  return factory(authFetch, classifyAuthFailure, toRequestError);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** page.tsx と同じ組み立ての authFetch（fetch と /api/auth/session の結果は偽物） */
function authFetchWith(res: () => Response | Promise<Response>, view: SessionView) {
  const log = { expired: 0, checked: 0, fetched: [] as string[] };
  const authFetch = makeAuthFetch({
    fetch: (async (input: string) => {
      log.fetched.push(input);
      return res();
    }) as unknown as typeof fetch,
    onExpired: async () => {
      log.expired++;
    },
    checkSession: async () => {
      log.checked++;
      return view;
    },
  });
  return { authFetch, log };
}

const AUTHED: SessionView = { kind: "authenticated", role: "STUDENT" };
const LOCKED_BODY = { error: "Forbidden", reason: "course_locked" };

async function rejectsWith(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  assert.fail("例外が投げられなかった");
}

describe("swrFetcher（page.tsx のソースを実行）", () => {
  it("403 course_locked は、/api/auth/session の確認を経ても本文を読めて、courseLocked のエラーになる（サインアウトしない）", async () => {
    const { authFetch, log } = authFetchWith(() => json(403, LOCKED_BODY), AUTHED);
    const err = await rejectsWith(buildSwrFetcher(authFetch)("/api/courses/c_2"));
    assert.ok(isCourseLockedError(err), `course_locked と判定されない: ${String(err)}`);
    assert.equal((err as Error).message, "Request failed (403)", "メッセージに本文が入っている");
    assert.equal(log.checked, 1, "403 で /api/auth/session を確かめていない");
    assert.equal(log.expired, 0, "有効なセッションでサインアウトした");
  });

  const notLocked: Array<[string, () => Response]> = [
    ["500", () => json(500, { error: "Internal server error" })],
    ["ロック以外の 403", () => json(403, { error: "Forbidden" })],
    ["本文が JSON でない 403", () => new Response("<html>forbidden</html>", { status: 403 })],
    ["404", () => json(404, { error: "Course not found", reason: "course_locked" })],
  ];
  for (const [label, res] of notLocked) {
    it(`${label} は course_locked と取り違えない（状態コードは残す）`, async () => {
      const { authFetch } = authFetchWith(res, AUTHED);
      const err = await rejectsWith(buildSwrFetcher(authFetch)("/api/courses/c_2"));
      assert.ok(err instanceof Error, "Error でない");
      assert.equal(isCourseLockedError(err), false, `${label} が course_locked と判定された`);
      assert.match((err as Error).message, /^Request failed \(\d{3}\)$/);
    });
  }

  it("通信エラーはそのまま投げる（course_locked にしない）", async () => {
    const { authFetch } = authFetchWith(() => {
      throw new TypeError("Failed to fetch");
    }, AUTHED);
    const err = await rejectsWith(buildSwrFetcher(authFetch)("/api/courses/c_2"));
    assert.ok(err instanceof TypeError, `TypeError でない: ${String(err)}`);
    assert.equal(isCourseLockedError(err), false);
  });

  it("401 はこれまでどおりサインアウトし、Not authenticated を投げる（本文を読まない）", async () => {
    const { authFetch, log } = authFetchWith(() => json(401, LOCKED_BODY), AUTHED);
    const err = await rejectsWith(buildSwrFetcher(authFetch)("/api/courses/c_2"));
    assert.equal((err as Error).message, "Not authenticated");
    assert.equal(isCourseLockedError(err), false);
    assert.equal(log.expired, 1, "401 でサインアウトしていない");
  });

  it("403 で /api/auth/session が失効を返したら、これまでどおりサインアウトする", async () => {
    const { authFetch, log } = authFetchWith(() => json(403, LOCKED_BODY), { kind: "expired" });
    await rejectsWith(buildSwrFetcher(authFetch)("/api/courses/c_2"));
    assert.equal(log.expired, 1, "失効したセッションでサインアウトしていない");
  });

  it("200 は本文をそのまま返す", async () => {
    const { authFetch } = authFetchWith(() => json(200, { id: "c_1" }), AUTHED);
    assert.deepEqual(await buildSwrFetcher(authFetch)("/api/courses/c_1"), { id: "c_1" });
  });
});

// ───────────── handleComplete ─────────────

type Harness = {
  run: (lessonId: string) => Promise<void>;
  completed: () => Set<string>;
  toasts: string[];
  active: unknown[];
  revalidated: () => number;
  completing: boolean[];
};

function buildHandleComplete(authFetch: Fetch, initial: string[]): Harness {
  let completedIds = new Set<string>(initial);
  const toasts: string[] = [];
  const active: unknown[] = [];
  const completing: boolean[] = [];
  let revalidated = 0;
  const courseData = {
    sections: [
      { lessons: [{ id: "l1" }, { id: "l2" }] },
      { lessons: [{ id: "l3" }] },
    ],
  };
  const allLessons = courseData.sections.flatMap((s) => s.lessons);
  const deps: Record<string, unknown> = {
    setCompletedIds: (f: (prev: Set<string>) => Set<string>) => {
      completedIds = f(completedIds);
    },
    setCompleting: (v: boolean) => completing.push(v),
    authFetch,
    completeRejection,
    showToast: (m: string) => toasts.push(m),
    COMPLETE_LOCKED_MESSAGE,
    COMPLETE_FORBIDDEN_MESSAGE,
    revalidateCourse: () => {
      revalidated++;
    },
    allLessons,
    setActiveLesson: (l: unknown) => active.push(l),
    courseData,
    setExpanded: () => {},
  };
  const names = Object.keys(deps);
  const factory = new Function(...names, `${handleCompleteSrc}\nreturn handleComplete;`);
  const handleComplete = factory(...names.map((n) => deps[n])) as (id: string) => Promise<void>;
  return { run: handleComplete, completed: () => completedIds, toasts, active, revalidated: () => revalidated, completing };
}

describe("handleComplete（page.tsx のソースを実行）", () => {
  it("403 course_locked：楽観更新を戻し、ロックの文言を出し、次のレッスンへ進まない（他の完了は残す）", async () => {
    const { authFetch } = authFetchWith(() => json(403, LOCKED_BODY), AUTHED);
    const h = buildHandleComplete(authFetch, ["l1"]);
    await h.run("l2");
    assert.deepEqual(Array.from(h.completed()), ["l1"], "楽観更新が戻っていない、または他の完了まで消えた");
    assert.deepEqual(h.toasts, [COMPLETE_LOCKED_MESSAGE]);
    assert.deepEqual(h.active, [], "断られたのに次のレッスンへ進んだ");
    assert.equal(h.revalidated(), 1, "コースを読み直していない");
    assert.deepEqual(h.completing, [true, false], "completing が戻っていない");
  });

  it("ロック以外の 403：楽観更新を戻し、別の文言を出す", async () => {
    const { authFetch } = authFetchWith(() => json(403, { error: "Forbidden" }), AUTHED);
    const h = buildHandleComplete(authFetch, []);
    await h.run("l1");
    assert.deepEqual(Array.from(h.completed()), []);
    assert.deepEqual(h.toasts, [COMPLETE_FORBIDDEN_MESSAGE]);
    assert.deepEqual(h.active, []);
  });

  it("本文が読めない 403 も、ロック以外として戻す（例外にしない）", async () => {
    const { authFetch } = authFetchWith(() => new Response("not json", { status: 403 }), AUTHED);
    const h = buildHandleComplete(authFetch, []);
    await h.run("l1");
    assert.deepEqual(Array.from(h.completed()), []);
    assert.deepEqual(h.toasts, [COMPLETE_FORBIDDEN_MESSAGE]);
  });

  it("200：完了を残して次のレッスンへ進む（これまでどおり）", async () => {
    const { authFetch } = authFetchWith(() => json(200, { id: "p1" }), AUTHED);
    const h = buildHandleComplete(authFetch, []);
    await h.run("l2");
    assert.deepEqual(Array.from(h.completed()), ["l2"]);
    assert.deepEqual(h.active, [{ id: "l3" }]);
    assert.deepEqual(h.toasts, []);
    assert.deepEqual(h.completing, [true, false]);
  });

  it("最後のレッスンの 200 は、完了のトーストを出す（これまでどおり）", async () => {
    const { authFetch } = authFetchWith(() => json(200, { id: "p1" }), AUTHED);
    const h = buildHandleComplete(authFetch, []);
    await h.run("l3");
    assert.deepEqual(h.toasts, ["コース完了！おめでとうございます！"]);
  });
});

describe("見えない文字", () => {
  it("このファイルのソースに見えない文字・全角空白を直接書いていない", () => {
    const text = readFileSync(__filename, "utf8");
    assert.doesNotMatch(text, new RegExp("[\\u00A0\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u3000\\uFEFF]", "u"));
  });
});
