-- Track AI-detection policy decisions and outcomes for cost and moderation reporting.
CREATE TABLE IF NOT EXISTS ai_detection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  event_type TEXT NOT NULL,
  policy_reason TEXT,
  c2pa_state TEXT,
  ai_detection_ran INTEGER NOT NULL DEFAULT 0,
  ai_detection_forced INTEGER NOT NULL DEFAULT 0,
  ai_score REAL,
  action TEXT,
  report_type TEXT,
  metadata_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_detection_events_created_at ON ai_detection_events(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_detection_events_sha256 ON ai_detection_events(sha256);
CREATE INDEX IF NOT EXISTS idx_ai_detection_events_type ON ai_detection_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ai_detection_events_reason ON ai_detection_events(policy_reason);
