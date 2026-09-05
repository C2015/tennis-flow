const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": status === 200 ? "public, max-age=60, s-maxage=300" : "no-store"
  }
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/sync" && request.method === "POST") {
      if (!env.SYNC_TOKEN) return json({ error: "同步功能未配置" }, 503);
      const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
      if (!(await secureEqual(provided, env.SYNC_TOKEN))) return json({ error: "未授权" }, 401);

      const length = Number(request.headers.get("content-length") || 0);
      if (length > 2_000_000) return json({ error: "同步文件超过 2MB" }, 413);
      let feed;
      try { feed = await request.json(); } catch { return json({ error: "无效的 JSON" }, 400); }
      const validationError = validateFeed(feed);
      if (validationError) return json({ error: validationError }, 400);

      const startedAt = new Date().toISOString();
      let imported = 0;
      for (let start = 0; start < feed.matches.length; start += 30) {
        const statements = [];
        for (const event of feed.matches.slice(start, start + 30)) {
          statements.push(env.DB.prepare("INSERT INTO tournaments (id,name,tour,level,surface,city,country,featured) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET name=excluded.name,tour=excluded.tour,level=excluded.level,surface=excluded.surface,city=excluded.city,country=excluded.country,featured=excluded.featured").bind(event.tournament.id,event.tournament.name,event.tournament.tour,event.tournament.level,event.tournament.surface||null,event.tournament.city||null,event.tournament.country||null,event.tournament.level === "Grand Slam" ? 1 : 0));
          for (const player of event.players) {
            statements.push(env.DB.prepare("INSERT INTO players (id,name,country_code) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,country_code=excluded.country_code").bind(player.id,player.name,player.country||null));
          }
          statements.push(env.DB.prepare("INSERT INTO matches (id,tournament_id,match_date,start_time,status,round,court,best_of,player1_id,player2_id,player1_rank,player2_rank,winner_player_id,score,set_scores,stats,source_url,source_updated_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET tournament_id=excluded.tournament_id,match_date=excluded.match_date,start_time=excluded.start_time,status=excluded.status,round=excluded.round,court=excluded.court,best_of=excluded.best_of,player1_id=excluded.player1_id,player2_id=excluded.player2_id,player1_rank=excluded.player1_rank,player2_rank=excluded.player2_rank,winner_player_id=excluded.winner_player_id,score=excluded.score,set_scores=excluded.set_scores,stats=excluded.stats,source_url=excluded.source_url,source_updated_at=excluded.source_updated_at,updated_at=CURRENT_TIMESTAMP").bind(event.id,event.tournament.id,event.date,event.time||null,event.status,event.round||null,event.court||null,event.bestOf||3,event.players[0].id,event.players[1].id,event.players[0].rank||null,event.players[1].rank||null,event.winnerId||null,event.score||null,JSON.stringify(event.setScores||[]),event.stats?JSON.stringify(event.stats):null,event.sourceUrl||null,feed.updatedAt));
          imported += 1;
        }
        await env.DB.batch(statements);
      }
      await env.DB.prepare("INSERT INTO sync_runs (started_at,finished_at,status,source,imported_count,message) VALUES (?1,?2,'success',?3,?4,?5)").bind(startedAt,new Date().toISOString(),feed.source,imported,"GitHub Actions incremental sync").run();
      return json({ ok: true, imported, source: feed.source });
    }

    if (url.pathname === "/api/health") {
      const sync = await env.DB.prepare(
        "SELECT finished_at, status, source, imported_count FROM sync_runs ORDER BY id DESC LIMIT 1"
      ).first();
      return json({ ok: true, database: "connected", lastSync: sync || null });
    }

    if (url.pathname === "/api/matches") {
      const date = url.searchParams.get("date");
      const tour = (url.searchParams.get("tour") || "all").toUpperCase();
      const query = (url.searchParams.get("q") || "").trim().slice(0, 60);

      if (!date || !DATE_RE.test(date)) return json({ error: "日期格式应为 YYYY-MM-DD" }, 400);
      if (!["ALL", "ATP", "WTA", "SLAM"].includes(tour)) return json({ error: "无效的赛事筛选" }, 400);

      const term = `%${query}%`;
      const result = await env.DB.prepare(`
        SELECT
          m.id, m.match_date AS date, m.start_time AS time, m.status,
          m.round, m.court, m.best_of AS bestOf, m.score, m.set_scores AS setScores,
          m.stats, m.source_url AS sourceUrl,
          t.name AS tournament, t.tour, t.level, t.surface, t.city, t.country,
          p1.name AS player1, p1.country_code AS player1Country, m.player1_rank AS player1Rank,
          p2.name AS player2, p2.country_code AS player2Country, m.player2_rank AS player2Rank,
          m.winner_player_id AS winnerPlayerId, m.player1_id AS player1Id, m.player2_id AS player2Id
        FROM matches m
        JOIN tournaments t ON t.id = m.tournament_id
        JOIN players p1 ON p1.id = m.player1_id
        JOIN players p2 ON p2.id = m.player2_id
        WHERE m.match_date = ?1
          AND (?2 = 'ALL' OR t.tour = ?2 OR (?2 = 'SLAM' AND t.level = 'Grand Slam'))
          AND (?3 = '' OR p1.name LIKE ?4 OR p2.name LIKE ?4 OR t.name LIKE ?4)
        ORDER BY t.featured DESC, t.name, m.start_time, m.id
      `).bind(date, tour, query, term).all();

      const matches = result.results.map((row) => ({
        ...row,
        setScores: safeParse(row.setScores, []),
        stats: safeParse(row.stats, null),
        winner: row.winnerPlayerId === row.player1Id ? 1 : row.winnerPlayerId === row.player2Id ? 2 : null
      }));
      return json({ date, timezone: "Asia/Shanghai", matches });
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "接口不存在" }, 404);
    return env.ASSETS.fetch(request);
  }
};

function safeParse(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function validateFeed(feed) {
  if (!feed || !Array.isArray(feed.matches) || !feed.source || !feed.updatedAt) return "数据必须包含 source、updatedAt 和 matches[]";
  if (feed.matches.length > 300) return "单次最多同步 300 场比赛";
  for (const [index, item] of feed.matches.entries()) {
    if (!item.id || !/^\d{4}-\d{2}-\d{2}$/.test(item.date || "") || !item.tournament?.id || !["ATP","WTA"].includes(item.tournament?.tour) || item.players?.length !== 2) return `第 ${index + 1} 场比赛格式无效`;
  }
  return null;
}

async function secureEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}
