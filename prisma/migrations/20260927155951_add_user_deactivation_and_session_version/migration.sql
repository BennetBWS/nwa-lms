-- Soft deactivation (#7) and session revocation (#11). Additive only; no table rewrite.
--
-- - "deactivatedAt": NULL = active. Deactivated students keep all their data
--   (progress, quiz attempts, comments, ...); login and password reset are refused.
-- - "sessionVersion": incremented when a student is deactivated; JWT sessions
--   will be checked against it in a follow-up change (#11).
-- - No new table, function or view. RLS on "User" stays enabled (#2).

-- AlterTable
ALTER TABLE "User" ADD COLUMN "deactivatedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
