CREATE TABLE IF NOT EXISTS adaptive_sync_state (
  target_key TEXT PRIMARY KEY,
  last_checked_at TEXT NOT NULL,
  next_check_at TEXT NOT NULL,
  last_status TEXT NOT NULL,
  updated_count INTEGER NOT NULL DEFAULT 0,
  message TEXT
);

CREATE INDEX IF NOT EXISTS idx_matches_adaptive_sync
  ON matches(status, match_date, start_time);
