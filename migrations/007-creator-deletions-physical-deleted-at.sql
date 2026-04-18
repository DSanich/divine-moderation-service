-- Stamped by scripts/sweep-creator-deletes.mjs only.
-- The live creator-delete pipeline (process.mjs) does not write this column;
-- newly-produced success rows show NULL here until the next sweep run picks
-- them up, calls Blossom (idempotent if bytes already gone), and stamps.
-- Semantic: "the validation sweep confirmed bytes were destroyed for this row."
--
-- Run exactly once per environment. SQLite (and therefore D1) does not support
-- "ADD COLUMN IF NOT EXISTS"; a re-run errors with "duplicate column name".
-- That's the expected signal — treat the error as "already applied" and move on.

ALTER TABLE creator_deletions
  ADD COLUMN physical_deleted_at TEXT;
