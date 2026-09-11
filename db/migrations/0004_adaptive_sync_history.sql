CREATE TABLE IF NOT EXISTS adaptive_cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  active_groups INTEGER NOT NULL DEFAULT 0,
  requested_groups INTEGER NOT NULL DEFAULT 0,
  successful_groups INTEGER NOT NULL DEFAULT 0,
  failed_groups INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  message TEXT
);

CREATE TABLE IF NOT EXISTS adaptive_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at TEXT NOT NULL,
  target_key TEXT NOT NULL,
  match_date TEXT NOT NULL,
  tour TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  due_reason TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT NOT NULL,
  message TEXT
);

CREATE INDEX IF NOT EXISTS idx_adaptive_cron_runs_scheduled_at
  ON adaptive_cron_runs(scheduled_at);

CREATE INDEX IF NOT EXISTS idx_adaptive_sync_runs_checked_at
  ON adaptive_sync_runs(checked_at);

CREATE INDEX IF NOT EXISTS idx_adaptive_sync_runs_target
  ON adaptive_sync_runs(target_key, checked_at);
