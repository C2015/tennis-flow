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

CREATE INDEX IF NOT EXISTS idx_broadcast_rules_active_dates
  ON broadcast_rules(active, starts_on, ends_on);
CREATE INDEX IF NOT EXISTS idx_match_broadcasts_match
  ON match_broadcasts(match_id, active);

INSERT OR REPLACE INTO broadcast_rules
  (id,platform,platform_name,tournament_patterns,tour,level,exclude_level,exclude_country,starts_on,ends_on,coverage,watch_url,source_url,is_free,priority,active,verified_at)
VALUES
  ('2026-us-open-cctv','cctv','央视体育','us open|美国网球公开赛',NULL,'Grand Slam',NULL,NULL,'2026-08-23','2026-09-13','event','https://sports.cctv.com/','https://www.usopen.org/en_US/about/tv_intl.html',NULL,100,1,'2026-09-10T00:00:00Z'),
  ('2026-us-open-migu','migu','咪咕视频','us open|美国网球公开赛',NULL,'Grand Slam',NULL,NULL,'2026-08-23','2026-09-13','event','https://www.miguvideo.com/','https://www.usopen.org/en_US/about/tv_intl.html',NULL,95,1,'2026-09-10T00:00:00Z'),
  ('2026-2028-roland-garros-tencent','tencent','腾讯体育','roland garros|french open|法国网球公开赛|法网',NULL,'Grand Slam',NULL,NULL,'2026-01-01','2028-12-31','all_matches','https://sports.qq.com/','https://www.rolandgarros.com/en-us/article/broadcasters-tencent-digital-platforms-china-2026-2028',NULL,100,1,'2026-09-10T00:00:00Z'),
  ('2025-2027-wimbledon-tencent','tencent','腾讯体育','wimbledon|温布尔登网球锦标赛|温网',NULL,'Grand Slam',NULL,NULL,'2025-01-01','2027-12-31','event','https://sports.qq.com/','https://www.weibo.com/5500545510/PdUZG80Gl',NULL,100,1,'2026-09-10T00:00:00Z'),
  ('2026-australian-open-cctv','cctv','央视体育','australian open|澳大利亚网球公开赛|澳网',NULL,'Grand Slam',NULL,NULL,'2026-01-01','2026-12-31','event','https://sports.cctv.com/','https://ausopen.com/articles/news/multi-year-broadcast-extension-ao-on-cctv-sports',NULL,100,1,'2026-09-10T00:00:00Z'),
  ('2026-wta-migu','migu','咪咕视频',NULL,'WTA',NULL,'Grand Slam','china|中国','2026-01-01','2026-12-31','event','https://www.miguvideo.com/','https://www.wtatennis.com/news/4432513/wta-renews-china-rights-deals-for-2026-as-fan-engagement-soars',NULL,80,1,'2026-09-10T00:00:00Z'),
  ('2026-wta-tencent','tencent','腾讯体育',NULL,'WTA',NULL,'Grand Slam','china|中国','2026-01-01','2026-12-31','event','https://sports.qq.com/','https://www.wtatennis.com/news/4432513/wta-renews-china-rights-deals-for-2026-as-fan-engagement-soars',NULL,75,1,'2026-09-10T00:00:00Z'),
  ('2026-wta-youku','youku','优酷体育',NULL,'WTA',NULL,'Grand Slam','china|中国','2026-01-01','2026-12-31','event','https://sports.youku.com/','https://www.wtatennis.com/news/4432513/wta-renews-china-rights-deals-for-2026-as-fan-engagement-soars',NULL,70,1,'2026-09-10T00:00:00Z'),
  ('2026-atp500-youku','youku','优酷体育',NULL,'ATP','ATP 500',NULL,NULL,'2026-01-01','2026-12-31','event','https://sports.youku.com/','https://www.atptour.com/en/tournaments/tv-schedule',NULL,70,1,'2026-09-10T00:00:00Z');
