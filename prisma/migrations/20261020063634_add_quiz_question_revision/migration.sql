-- Edit history of quiz questions for auditing (#81 Q0). Additive only.
--
-- - One row per edit of a QuizQuestion by an instructor: which fields changed,
--   and the question / options / correctIndex before and after the edit.
-- - "questionId" and "quizId" are intentionally NOT foreign keys, so the history
--   remains even if the question or quiz is deleted.
-- - "editorId" references "User" with ON DELETE RESTRICT (users are deactivated
--   logically, not deleted; #7).
-- - "changedFields" is TEXT[] without NOT NULL, matching what Prisma generates
--   for a String[] field (keeps the schema and the migration free of drift).
-- - RLS is enabled in this same file (#2). FORCE is not used and no policies are
--   created. anon / authenticated get no privileges thanks to the default
--   privileges revoked in 20260924050215_revoke_anon_privileges.
-- - No function or view is created in public (#5).
-- - Apply this to production BEFORE merging the quiz admin API (Q1) to main.

-- CreateTable
CREATE TABLE "QuizQuestionRevision" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "editorId" TEXT NOT NULL,
    "changedFields" TEXT[],
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizQuestionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuizQuestionRevision_questionId_createdAt_idx" ON "QuizQuestionRevision"("questionId", "createdAt");

-- CreateIndex
CREATE INDEX "QuizQuestionRevision_quizId_createdAt_idx" ON "QuizQuestionRevision"("quizId", "createdAt");

-- AddForeignKey
ALTER TABLE "QuizQuestionRevision" ADD CONSTRAINT "QuizQuestionRevision_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- EnableRLS
ALTER TABLE "QuizQuestionRevision" ENABLE ROW LEVEL SECURITY;
