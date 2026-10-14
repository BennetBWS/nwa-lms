import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMPLETE_FORBIDDEN_MESSAGE,
  COMPLETE_LOCKED_MESSAGE,
  COURSE_LOCKED,
  COURSE_LOCKED_DESCRIPTION,
  COURSE_LOCKED_TITLE,
  completeRejection,
  isCourseLockedError,
  isCourseLockedResponse,
  toRequestError,
} from "./course-locked";
import { COURSE_LOCKED_REASON } from "./lesson-access";

// #47 P4 受講生画面で 403 course_locked を扱う純粋関数。DB・DOM なし。

describe("isCourseLockedResponse", () => {
  it("403 で reason が course_locked のときだけ true", () => {
    assert.equal(isCourseLockedResponse(403, { error: "Forbidden", reason: "course_locked" }), true);
    assert.equal(isCourseLockedResponse(403, { reason: "forbidden_role" }), false);
    assert.equal(isCourseLockedResponse(403, { error: "Forbidden" }), false);
    assert.equal(isCourseLockedResponse(403, null), false);
    assert.equal(isCourseLockedResponse(403, "course_locked"), false);
    assert.equal(isCourseLockedResponse(403, ["course_locked"]), false);
    assert.equal(isCourseLockedResponse(404, { reason: "course_locked" }), false);
    assert.equal(isCourseLockedResponse(500, { reason: "course_locked" }), false);
  });

  it("理由の値はサーバー（lesson-access の COURSE_LOCKED_REASON）と同じ", () => {
    assert.equal(COURSE_LOCKED, COURSE_LOCKED_REASON);
  });
});

describe("toRequestError・isCourseLockedError", () => {
  it("403 course_locked は courseLocked: true、メッセージは状態コードだけ", () => {
    const err = toRequestError(403, { error: "Forbidden", reason: "course_locked" });
    assert.ok(err instanceof Error, "Error でない");
    assert.equal(err.message, "Request failed (403)");
    assert.equal(err.status, 403);
    assert.equal(isCourseLockedError(err), true);
  });

  it("ほかの失敗は courseLocked: false（通信エラーとして表示する）", () => {
    for (const [status, body] of [
      [403, { error: "Forbidden" }],
      [404, { error: "Course not found" }],
      [500, null],
    ] as Array<[number, unknown]>) {
      const err = toRequestError(status, body);
      assert.equal(isCourseLockedError(err), false, `status ${status}`);
      assert.equal(err.message, `Request failed (${status})`);
    }
  });

  it("本文の中身をメッセージに入れない", () => {
    const err = toRequestError(500, { error: "dummy-secret-detail" });
    assert.ok(!err.message.includes("dummy-secret-detail"), "本文がメッセージに入っている");
  });

  it("toRequestError 以外（ふつうの Error・null・文字列）は false", () => {
    assert.equal(isCourseLockedError(new Error("Request failed (403)")), false);
    assert.equal(isCourseLockedError(null), false);
    assert.equal(isCourseLockedError(undefined), false);
    assert.equal(isCourseLockedError("course_locked"), false);
    assert.equal(isCourseLockedError({ courseLocked: "true" }), false);
  });
});

describe("completeRejection（POST /api/progress）", () => {
  it("403 course_locked は course_locked、ほかの 403 は forbidden", () => {
    assert.equal(completeRejection(403, { reason: "course_locked" }), "course_locked");
    assert.equal(completeRejection(403, { error: "Forbidden" }), "forbidden");
    assert.equal(completeRejection(403, null), "forbidden");
  });

  it("403 以外は null（楽観更新を戻さない。これまでどおり）", () => {
    for (const status of [200, 400, 401, 404, 500]) {
      assert.equal(completeRejection(status, { reason: "course_locked" }), null, `status ${status}`);
    }
  });
});

describe("文言", () => {
  it("ロック中の表示と、完了できなかったときの文言", () => {
    assert.equal(COURSE_LOCKED_TITLE, "このコースはまだ解放されていません");
    assert.ok(COURSE_LOCKED_DESCRIPTION.length > 0, "説明が空");
    assert.ok(COMPLETE_LOCKED_MESSAGE.includes("解放されていない"), "ロックの文言にロックのことが書かれていない");
    assert.ok(!COMPLETE_FORBIDDEN_MESSAGE.includes("解放"), "ロック以外の 403 の文言にロックのことが書かれている");
  });

  it("このファイルと course-locked.ts に見えない文字・全角空白を直接書いていない", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const re = new RegExp("[\\u00A0\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u3000\\uFEFF]", "u");
    for (const f of [__filename, join(__dirname, "course-locked.ts")]) {
      assert.doesNotMatch(readFileSync(f, "utf8"), re, f);
    }
  });
});
