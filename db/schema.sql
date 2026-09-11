PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tour TEXT NOT NULL CHECK (tour IN ('ATP', 'WTA')),
  level TEXT NOT NULL,
  surface TEXT,
  city TEXT,
  country TEXT,
  draw_url TEXT,
  featured INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_zh TEXT,
  country_code TEXT
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id),
  match_date TEXT NOT NULL,
  start_time TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'finished', 'cancelled', 'postponed')),
  round TEXT,
  court TEXT,
  best_of INTEGER NOT NULL DEFAULT 3,
  player1_id TEXT NOT NULL REFERENCES players(id),
  player2_id TEXT NOT NULL REFERENCES players(id),
  player1_rank INTEGER,
  player2_rank INTEGER,
  winner_player_id TEXT REFERENCES players(id),
  score TEXT,
  set_scores TEXT,
  stats TEXT,
  source_url TEXT,
  source_updated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  imported_count INTEGER NOT NULL DEFAULT 0,
  message TEXT
);

CREATE TABLE IF NOT EXISTS adaptive_sync_state (
  target_key TEXT PRIMARY KEY,
  last_checked_at TEXT NOT NULL,
  next_check_at TEXT NOT NULL,
  last_status TEXT NOT NULL,
  updated_count INTEGER NOT NULL DEFAULT 0,
  message TEXT
);

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

CREATE TABLE IF NOT EXISTS broadcast_rules (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('cctv', 'migu', 'tencent', 'youku')),
  platform_name TEXT NOT NULL,
  tournament_patterns TEXT,
  tour TEXT CHECK (tour IS NULL OR tour IN ('ATP', 'WTA')),
  level TEXT,
  exclude_level TEXT,
  exclude_country TEXT,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  coverage TEXT NOT NULL CHECK (coverage IN ('event', 'all_matches')),
  watch_url TEXT NOT NULL,
  mini_program_app_id TEXT,
  mini_program_path TEXT,
  source_url TEXT NOT NULL,
  is_free INTEGER CHECK (is_free IS NULL OR is_free IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  verified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('cctv', 'migu', 'tencent', 'youku')),
  platform_name TEXT NOT NULL,
  watch_url TEXT NOT NULL,
  mini_program_app_id TEXT,
  mini_program_path TEXT,
  is_free INTEGER CHECK (is_free IS NULL OR is_free IN (0, 1)),
  source_url TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE(match_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(match_date);
CREATE INDEX IF NOT EXISTS idx_matches_tournament_date ON matches(tournament_id, match_date);
CREATE INDEX IF NOT EXISTS idx_matches_adaptive_sync ON matches(status, match_date, start_time);
CREATE INDEX IF NOT EXISTS idx_adaptive_cron_runs_scheduled_at ON adaptive_cron_runs(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_adaptive_sync_runs_checked_at ON adaptive_sync_runs(checked_at);
CREATE INDEX IF NOT EXISTS idx_adaptive_sync_runs_target ON adaptive_sync_runs(target_key, checked_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_rules_active_dates ON broadcast_rules(active, starts_on, ends_on);
CREATE INDEX IF NOT EXISTS idx_match_broadcasts_match ON match_broadcasts(match_id, active);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
