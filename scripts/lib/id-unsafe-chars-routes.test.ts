import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeAuth, INSTRUCTOR_SESSION, STUDENT_SESSION, type FakeSession } from "./student-routes.test-helpers";

// #86 id の形の検証（isValidId）で NUL・対になっていないサロゲートを断ることを、isValidId を使うすべての route で確かめる。
// prisma は globalThis.prisma に置く Proxy で、どのプロパティに触れても記録して例外を投げる（= DB に一度も触れないことを確かめる）。
// NextAuth は installFakeAuth で差し替える。DB・ネットワークなし。見えない文字は \u エスケープで書く。
// URL の path・query は Next / URL がデコードするため、対になっていないサロゲートは %ED%A0%80 などの形では届かない
// （U+FFFD への置き換えか URIError）。path の値は params に直接入れ、query は NUL だけを確かめる。

const BAD_IDS: Array<[string, string]> = [
  ["NUL", "x\u0000"],
  ["上位サロゲートだけ", "x\uD800"],
  ["下位サロゲートだけ", "\uDC00x"],
  ["逆順のサロゲート", "x\uDE00\uD83D"],
];

let session: FakeSession;
let touched: string[];

function dbTrap(): unknown {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      touched.push(String(prop));
      throw new Error(`DB に触れた：${String(prop)}`);
    },
  };
  return new Proxy({}, handler);
}

type Ctx<K extends string> = { params: Promise<Record<K, string>> };
type Handler<K extends string> = (req: Request, ctx: Ctx<K>) => Promise<Response>;

let commentsPOST: (req: Request) => Promise<Response>;
let commentsGET: (req: Request) => Promise<Response>;
let progressPOST: (req: Request) => Promise<Response>;
let notificationsReadPOST: (req: Request) => Promise<Response>;
let lessonCommentsGET: Handler<"lessonId">;
let quizGET: Handler<"quizId">;
let quizSubmitPOST: Handler<"quizId">;
let adminQuestionPATCH: Handler<"id">;
let adminQuizGET: Handler<"id">;
let adminCommentDELETE: Handler<"id">;
let adminRepliesPOST: Handler<"id">;

before(async () => {
  (globalThis as unknown as { prisma: unknown }).prisma = dbTrap();
  installFakeAuth(() => session);
  ({ POST: commentsPOST, GET: commentsGET } = await import("../../src/app/api/comments/route"));
  ({ POST: progressPOST } = await import("../../src/app/api/progress/route"));
  ({ POST: notificationsReadPOST } = await import("../../src/app/api/notifications/read/route"));
  ({ GET: lessonCommentsGET } = await import("../../src/app/api/comments/[lessonId]/route"));
  ({ GET: quizGET } = await import("../../src/app/api/quizzes/[quizId]/route"));
  ({ POST: quizSubmitPOST } = await import("../../src/app/api/quizzes/[quizId]/submit/route"));
  ({ PATCH: adminQuestionPATCH } = await import("../../src/app/api/admin/questions/[id]/route"));
  ({ GET: adminQuizGET } = await import("../../src/app/api/admin/quizzes/[id]/route"));
  ({ DELETE: adminCommentDELETE } = await import("../../src/app/api/admin/comments/[id]/route"));
  ({ POST: adminRepliesPOST } = await import("../../src/app/api/admin/comments/[id]/replies/route"));
});

beforeEach(() => {
  touched = [];
  session = STUDENT_SESSION;
});

const ORIGIN = "https://nwa-lms.example.com";
const jsonReq = (path: string, method: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const getReq = (path: string) => new Request(`${ORIGIN}${path}`);
const ctx = <K extends string>(key: K, value: string): Ctx<K> => ({ params: Promise.resolve({ [key]: value } as Record<K, string>) });

async function expect400(res: Response, label: string, reason?: string) {
  assert.equal(res.status, 400, `400 でない：${label}`);
  if (reason !== undefined) assert.equal((await res.json()).reason, reason, `reason が違う：${label}`);
  assert.deepEqual(touched, [], `DB に触れた：${label}`);
}

describe("isValidId を使う route：id に NUL・対になっていないサロゲートがあれば 400 で、DB に触れない（#86）", () => {
  for (const [label, bad] of BAD_IDS) {
    describe(label, () => {
      it("POST /api/comments の lessonId は invalid_lesson_id、parentId は invalid_parent_id", async () => {
        await expect400(await commentsPOST(jsonReq("/api/comments", "POST", { lessonId: bad, content: "質問" })), "lessonId", "invalid_lesson_id");
        await expect400(
          await commentsPOST(jsonReq("/api/comments", "POST", { lessonId: "l1", content: "質問", parentId: bad })),
          "parentId",
          "invalid_parent_id",
        );
      });

      it("POST /api/admin/comments/[id]/replies の URL の id は invalid_id", async () => {
        session = INSTRUCTOR_SESSION;
        await expect400(await adminRepliesPOST(jsonReq("/api/admin/comments/x/replies", "POST", { content: "回答" }), ctx("id", bad)), "replies", "invalid_id");
      });

      it("DELETE /api/admin/comments/[id] は invalid_id", async () => {
        session = INSTRUCTOR_SESSION;
        await expect400(await adminCommentDELETE(new Request(`${ORIGIN}/api/admin/comments/x`, { method: "DELETE" }), ctx("id", bad)), "delete", "invalid_id");
      });

      it("PATCH /api/admin/questions/[id] は invalid_id", async () => {
        session = INSTRUCTOR_SESSION;
        await expect400(await adminQuestionPATCH(jsonReq("/api/admin/questions/x", "PATCH", { revision: "r" }), ctx("id", bad)), "admin question", "invalid_id");
      });

      it("GET /api/admin/quizzes/[id] は invalid_id", async () => {
        session = INSTRUCTOR_SESSION;
        await expect400(await adminQuizGET(getReq("/api/admin/quizzes/x"), ctx("id", bad)), "admin quiz", "invalid_id");
      });

      it("POST /api/progress の lessonId", async () => {
        await expect400(await progressPOST(jsonReq("/api/progress", "POST", { lessonId: bad, completed: true })), "progress");
      });

      it("POST /api/notifications/read の ids は invalid_ids", async () => {
        await expect400(await notificationsReadPOST(jsonReq("/api/notifications/read", "POST", { ids: ["n1", bad] })), "notifications", "invalid_ids");
      });

      it("GET /api/comments/[lessonId]", async () => {
        await expect400(await lessonCommentsGET(getReq("/api/comments/x"), ctx("lessonId", bad)), "lesson comments");
      });

      it("GET /api/quizzes/[quizId]", async () => {
        await expect400(await quizGET(getReq("/api/quizzes/x"), ctx("quizId", bad)), "quiz");
      });

      it("POST /api/quizzes/[quizId]/submit の quizId、questionIds は invalid_question_ids", async () => {
        await expect400(
          await quizSubmitPOST(jsonReq("/api/quizzes/x/submit", "POST", { answers: [0], questionIds: ["q1"], attemptToken: "v1.a.b" }), ctx("quizId", bad)),
          "submit quizId",
        );
        await expect400(
          await quizSubmitPOST(jsonReq("/api/quizzes/q/submit", "POST", { answers: [0], questionIds: ["q1", bad], attemptToken: "v1.a.b" }), ctx("quizId", "quiz_1")),
          "submit questionIds",
          "invalid_question_ids",
        );
      });
    });
  }

  it("GET /api/comments の query：courseId は invalid_course_id、cursor の id は invalid_cursor（NUL。%00 で届く）", async () => {
    await expect400(await commentsGET(getReq("/api/comments?courseId=c%00")), "courseId", "invalid_course_id");
    await expect400(await commentsGET(getReq("/api/comments?cursor=1700000000000.c%00")), "cursor", "invalid_cursor");
  });

  it("前提：仕掛けた prisma は、正しい id なら触れられる（DB に触れないことの確かめが空振りしていない）", async () => {
    const res = await lessonCommentsGET(getReq("/api/comments/l1"), ctx("lessonId", "l1"));
    assert.equal(res.status, 500, "正しい id で DB に進んでいない");
    assert.ok(touched.length > 0, "正しい id でも prisma に触れていない");
  });
});
