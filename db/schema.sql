PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tour TEXT NOT NULL CHECK (tour IN ('ATP', 'WTA')),
  level TEXT NOT NULL,
  surface TEXT,
  city TEXT,
  country TEXT,
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

CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(match_date);
CREATE INDEX IF NOT EXISTS idx_matches_tournament_date ON matches(tournament_id, match_date);
CREATE INDEX IF NOT EXISTS idx_matches_adaptive_sync ON matches(status, match_date, start_time);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
