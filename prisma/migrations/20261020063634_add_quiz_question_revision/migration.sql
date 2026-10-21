-- Edit history of quiz questions for auditing (#81 Q0). Additive only.
--
-- - One row per edit of a QuizQuestion by an instructor: which fields changed,
--   and the question / options / correctIndex before and after the edit.
-- - "questionId" and "quizId" are intentionally NOT foreign keys, so the history
--   remains even if the question or quiz is deleted.
-- - "editorId" references "User" with ON DELETE RESTRICT (users are deactivated
--   logically, not deleted; #7).
-- - "changedFields" is declared as TEXT[] without NOT NULL, matching what Prisma
--   generates for a String[] field (keeps the column definition free of drift).
--   The approved design is TEXT[] NOT NULL with at least one element, so it is
--   enforced by the CHECK constraint "QuizQuestionRevision_changedFields_check"
--   below. Prisma 6 cannot express CHECK constraints in schema.prisma and does
--   not manage them in migrations (db pull only warns that the table "contains
--   check constraints"), so the constraint is not part of the schema diff and
--   generated migrations are not expected to drop it. Review any generated
--   migration for this table and do not remove the constraint.
-- - RLS is enabled in this same file (#2). FORCE is not used and no policies are
--   created. anon / authenticated get no privileges thanks to the default
--   privileges revoked in 20260924050215_revoke_anon_privileges.
-- - No function or view is created in public (#5).
-- - Production order: merge this migration (Q0) to main first, then Tec applies
--   it to production from a checkout of main, and only after that the quiz admin
--   API (Q1) is merged (the reverse order makes the API return 500). After
--   applying, check RLS and the anon privileges with the queries in step 8
--   of docs/dev-db-setup.md.

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

-- AddCheckConstraint
-- changedFields must be non-NULL and non-empty (approved design: TEXT[] NOT NULL).
-- "IS NOT NULL" is required because cardinality(NULL) is NULL, which a CHECK accepts.
ALTER TABLE "QuizQuestionRevision" ADD CONSTRAINT "QuizQuestionRevision_changedFields_check" CHECK ("changedFields" IS NOT NULL AND cardinality("changedFields") > 0);

-- EnableRLS
ALTER TABLE "QuizQuestionRevision" ENABLE ROW LEVEL SECURITY;
