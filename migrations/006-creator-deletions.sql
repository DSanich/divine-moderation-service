-- Audit table for creator-initiated deletions (kind 5 events from Funnelcake).
-- Composite PRIMARY KEY ensures idempotency across concurrent invocations
-- (sync endpoint + cron colliding on the same kind 5).
--
-- status taxonomy:
--   accepted                              - claimed by a worker, in-progress
--   success                               - terminal success
--   failed:transient:{subcategory}        - retryable by cron (retry_count < 5)
--   failed:permanent:{subcategory}        - terminal, manual intervention required

CREATE TABLE IF NOT EXISTS creator_deletions (
  kind5_id TEXT NOT NULL,
  target_event_id TEXT NOT NULL,
  creator_pubkey TEXT NOT NULL,
  blob_sha256 TEXT,
  status TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  completed_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (kind5_id, target_event_id)
);

CREATE INDEX IF NOT EXISTS idx_creator_deletions_target ON creator_deletions(target_event_id);
CREATE INDEX IF NOT EXISTS idx_creator_deletions_creator ON creator_deletions(creator_pubkey);
CREATE INDEX IF NOT EXISTS idx_creator_deletions_sha256 ON creator_deletions(blob_sha256);
CREATE INDEX IF NOT EXISTS idx_creator_deletions_status ON creator_deletions(status);
