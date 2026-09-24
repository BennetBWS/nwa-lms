-- Enable Row Level Security on every table in the public schema.
--
-- Intent:
-- - No policies are created, so for the Supabase API roles (anon, authenticated)
--   reads via PostgREST / supabase-js return zero rows and writes fail with an
--   RLS violation.
-- - Prisma connects as "postgres", which owns these tables and has BYPASSRLS,
--   so application queries are unaffected.
-- - FORCE ROW LEVEL SECURITY is intentionally NOT used: it would apply RLS to
--   the table owner as well, leaving BYPASSRLS as Prisma's only safeguard.
-- - Rollback policy: never DISABLE RLS; roll forward with policies or GRANTs.

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PasswordReset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Course" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Section" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Lesson" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Progress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Quiz" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuizQuestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuizAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Assignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;

-- Prisma's migration history table.
ALTER TABLE IF EXISTS "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
