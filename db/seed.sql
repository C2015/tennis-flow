INSERT OR REPLACE INTO tournaments (id, name, tour, level, surface, city, country, featured) VALUES
  ('us-open-men-2026', '美国网球公开赛 · 男单', 'ATP', 'Grand Slam', '硬地', '纽约', '美国', 1),
  ('us-open-women-2026', '美国网球公开赛 · 女单', 'WTA', 'Grand Slam', '硬地', '纽约', '美国', 1),
  ('atp-demo-2026', 'ATP 巡回赛', 'ATP', 'ATP 250', '硬地', '示例城市', '—', 0),
  ('asia-open-men-2026', '亚洲网球公开赛 · 男单', 'ATP', 'ATP 500', '硬地', '东京', '日本', 0),
  ('china-open-women-2026', '中国女子网球公开赛', 'WTA', 'WTA 1000', '硬地', '北京', '中国', 0);

INSERT OR REPLACE INTO players (id, name, country_code) VALUES
  ('p-sinner', '扬尼克·辛纳', 'ITA'), ('p-alcaraz', '卡洛斯·阿尔卡拉斯', 'ESP'),
  ('p-djokovic', '诺瓦克·德约科维奇', 'SRB'), ('p-zverev', '亚历山大·兹维列夫', 'GER'),
  ('p-swiatek', '伊加·斯维亚特克', 'POL'), ('p-sabalenka', '阿丽娜·萨巴伦卡', '—'),
  ('p-gauff', '科科·高芙', 'USA'), ('p-pegula', '杰西卡·佩古拉', 'USA'),
  ('p-demo-a', '示例球员 A', 'CHN'), ('p-demo-b', '示例球员 B', 'JPN'),
  ('p-felix', '费利克斯·奥热-阿利亚西姆', 'CAN'), ('p-deminaur', '亚历克斯·德米纳尔', 'AUS'),
  ('p-zhang', '张之臻', 'CHN'), ('p-shelton', '本·谢尔顿', 'USA'),
  ('p-zheng', '郑钦文', 'CHN'), ('p-krejcikova', '巴博拉·克雷吉茨科娃', 'CZE'),
  ('p-andreeva', '米拉·安德列娃', '—'), ('p-raducanu', '艾玛·拉杜卡努', 'GBR');

INSERT OR REPLACE INTO matches
  (id, tournament_id, match_date, start_time, status, round, court, best_of, player1_id, player2_id, player1_rank, player2_rank, winner_player_id, score, set_scores, stats, source_url)
VALUES
  ('m1', 'us-open-men-2026', '2026-09-05', '00:30', 'finished', '半决赛', '阿瑟·阿什球场', 5, 'p-sinner', 'p-zverev', 1, 3, 'p-sinner', '3–1', '[{"p1":6,"p2":4},{"p1":3,"p2":6},{"p1":6,"p2":3},{"p1":6,"p2":4}]', '{"aces":[12,9],"doubleFaults":[3,5],"firstServe":[68,62],"breakPoints":[4,2]}', NULL),
  ('m2', 'us-open-men-2026', '2026-09-05', '08:10', 'scheduled', '半决赛', '阿瑟·阿什球场', 5, 'p-alcaraz', 'p-djokovic', 2, 7, NULL, NULL, '[]', NULL, NULL),
  ('m3', 'us-open-women-2026', '2026-09-05', '03:00', 'finished', '半决赛', '路易斯·阿姆斯特朗球场', 3, 'p-swiatek', 'p-pegula', 2, 4, 'p-swiatek', '2–0', '[{"p1":6,"p2":3},{"p1":7,"p2":5}]', '{"aces":[5,2],"doubleFaults":[2,4],"firstServe":[71,64],"breakPoints":[5,2]}', NULL),
  ('m4', 'us-open-women-2026', '2026-09-05', '09:30', 'scheduled', '半决赛', '阿瑟·阿什球场', 3, 'p-sabalenka', 'p-gauff', 1, 3, NULL, NULL, '[]', NULL, NULL),
  ('m5', 'atp-demo-2026', '2026-09-04', '14:00', 'finished', '决赛', '中央球场', 3, 'p-demo-a', 'p-demo-b', 86, 112, 'p-demo-a', '2–1', '[{"p1":4,"p2":6},{"p1":6,"p2":3},{"p1":6,"p2":2}]', NULL, NULL),
  ('m6', 'us-open-men-2026', '2026-09-06', '04:00', 'scheduled', '决赛', '阿瑟·阿什球场', 5, 'p-sinner', 'p-alcaraz', 1, 2, NULL, NULL, '[]', NULL, NULL),
  ('m7', 'asia-open-men-2026', '2026-09-05', '11:20', 'finished', '四分之一决赛', '中央球场', 3, 'p-felix', 'p-deminaur', 18, 9, 'p-deminaur', '1–2', '[{"p1":6,"p2":4},{"p1":5,"p2":7},{"p1":3,"p2":6}]', '{"aces":[11,7],"doubleFaults":[6,2],"firstServe":[59,67],"breakPoints":[2,4]}', NULL),
  ('m8', 'asia-open-men-2026', '2026-09-05', '13:45', 'scheduled', '第二轮', '2号球场', 3, 'p-zhang', 'p-shelton', 47, 12, NULL, NULL, '[]', NULL, NULL),
  ('m9', 'china-open-women-2026', '2026-09-05', '16:00', 'finished', '第二轮', '钻石球场', 3, 'p-zheng', 'p-krejcikova', 6, 15, 'p-zheng', '2–1', '[{"p1":4,"p2":6},{"p1":7,"p2":5},{"p1":6,"p2":2}]', NULL, NULL),
  ('m10', 'china-open-women-2026', '2026-09-05', '19:30', 'scheduled', '第二轮', '莲花球场', 3, 'p-andreeva', 'p-raducanu', 8, 31, NULL, NULL, '[]', NULL, NULL);

INSERT INTO sync_runs (started_at, finished_at, status, source, imported_count, message)
VALUES ('2026-09-05T06:17:00+08:00', '2026-09-05T06:17:08+08:00', 'success', '演示数据', 10, '用于界面预览，不代表真实赛果');
