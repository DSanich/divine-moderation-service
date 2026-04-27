-- Track moderation runs that completed before transcript generation finished.
-- These fields enable cron-based reprocessing once transcript text becomes available.

ALTER TABLE moderation_results ADD COLUMN transcript_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE moderation_results ADD COLUMN transcript_pending_since TEXT;
ALTER TABLE moderation_results ADD COLUMN transcript_last_checked_at TEXT;
ALTER TABLE moderation_results ADD COLUMN transcript_resolved_at TEXT;
