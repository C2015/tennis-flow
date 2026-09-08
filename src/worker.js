const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": status === 200 ? "public, max-age=60, s-maxage=300" : "no-store"
  }
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE_WINDOW_MS = 18 * 60 * 60 * 1000;
const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/tennis";

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
            statements.push(env.DB.prepare("INSERT INTO players (id,name,name_zh,country_code) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_zh=coalesce(excluded.name_zh,players.name_zh),country_code=excluded.country_code").bind(player.id,player.name,player.nameZh||null,player.country||null));
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
      const [sync, availability] = await Promise.all([
        env.DB.prepare("SELECT finished_at, status, source, imported_count FROM sync_runs ORDER BY id DESC LIMIT 1").first(),
        env.DB.prepare("SELECT min(match_date) AS firstDate, max(match_date) AS latestDate FROM matches WHERE source_url IS NOT NULL").first()
      ]);
      return json({ ok: true, database: "connected", lastSync: sync || null, availability });
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
          p1.name AS player1, p1.name_zh AS player1Zh, p1.country_code AS player1Country, m.player1_rank AS player1Rank,
          p2.name AS player2, p2.name_zh AS player2Zh, p2.country_code AS player2Country, m.player2_rank AS player2Rank,
          m.winner_player_id AS winnerPlayerId, m.player1_id AS player1Id, m.player2_id AS player2Id
        FROM matches m
        JOIN tournaments t ON t.id = m.tournament_id
        JOIN players p1 ON p1.id = m.player1_id
        JOIN players p2 ON p2.id = m.player2_id
        WHERE m.match_date = ?1
          AND (?2 = 'ALL' OR t.tour = ?2 OR (?2 = 'SLAM' AND t.level = 'Grand Slam'))
          AND (?3 = '' OR p1.name LIKE ?4 OR p2.name LIKE ?4 OR p1.name_zh LIKE ?4 OR p2.name_zh LIKE ?4 OR t.name LIKE ?4)
        ORDER BY t.featured DESC, t.name, m.start_time, m.id
      `).bind(date, tour, query, term).all();

      const matches = result.results.map((row) => ({
        ...row,
        setScores: safeParse(row.setScores, []),
        stats: safeParse(row.stats, null),
        winner: row.winnerPlayerId === row.player1Id ? 1 : row.winnerPlayerId === row.player2Id ? 2 : null
      }));
      let suggestedDate = null;
      if (!matches.length) {
        const nearest = await env.DB.prepare("SELECT match_date AS date FROM matches WHERE source_url IS NOT NULL ORDER BY abs(julianday(match_date) - julianday(?1)) LIMIT 1").bind(date).first();
        suggestedDate = nearest?.date || null;
      }
      return json({ date, timezone: "Asia/Shanghai", matches, suggestedDate });
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "接口不存在" }, 404);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env) {
    await runAdaptiveSync(env, new Date(controller.scheduledTime));
  }
};

async function runAdaptiveSync(env, now) {
  const today = beijingDate(now);
  const earliestDate = beijingDate(new Date(now.getTime() - ACTIVE_WINDOW_MS));
  const [pendingResult, stateResult] = await Promise.all([
    env.DB.prepare(`
      SELECT m.id, m.match_date AS date, m.start_time AS time,
             t.name AS tournament, t.level, t.tour
      FROM matches m
      JOIN tournaments t ON t.id = m.tournament_id
      WHERE m.status IN ('scheduled', 'postponed')
        AND m.start_time IS NOT NULL
        AND m.match_date BETWEEN ?1 AND ?2
    `).bind(earliestDate, today).all(),
    env.DB.prepare("SELECT target_key, next_check_at FROM adaptive_sync_state").all()
  ]);

  const states = new Map(stateResult.results.map((row) => [row.target_key, row.next_check_at]));
  const groups = new Map();
  for (const match of pendingResult.results) {
    const startAt = Date.parse(`${match.date}T${match.time}:00+08:00`);
    const elapsed = now.getTime() - startAt;
    if (!Number.isFinite(startAt) || elapsed < 0 || elapsed > ACTIVE_WINDOW_MS) continue;
    const interval = pollingIntervalMinutes(match.level, match.tournament);
    const key = `${match.date}|${match.tour}`;
    const current = groups.get(key);
    if (!current || interval < current.interval) {
      groups.set(key, { key, date: match.date, tour: match.tour, interval });
    }
  }

  const due = [...groups.values()].filter((group) => {
    const nextCheck = Date.parse(states.get(group.key) || "");
    return !Number.isFinite(nextCheck) || nextCheck <= now.getTime();
  });

  let updated = 0;
  for (const group of due) {
    updated += await refreshScoreboardGroup(env, group, now);
  }
  console.log(JSON.stringify({
    event: "adaptive_sync_complete",
    checkedAt: now.toISOString(),
    activeGroups: groups.size,
    requestedGroups: due.length,
    updated
  }));
}

async function refreshScoreboardGroup(env, group, now) {
  const checkedAt = now.toISOString();
  const nextCheckAt = new Date(now.getTime() + group.interval * 60_000).toISOString();
  const compactDate = group.date.replaceAll("-", "");
  const url = `${ESPN_SCOREBOARD}/${group.tour.toLowerCase()}/scoreboard?dates=${compactDate}`;
  let status = "success";
  let message = null;
  let updated = 0;

  try {
    const response = await fetch(url, {
      headers: { "accept": "application/json", "user-agent": "TennisFlow/0.4 (scores.tennisdrills.org)" },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`ESPN returned ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > 5_000_000) throw new Error("ESPN response exceeded 5MB");
    const payload = await response.json();
    const updates = extractTerminalUpdates(payload, group.tour, group.date, checkedAt);
    if (updates.length) {
      const results = await env.DB.batch(updates.map((item) => env.DB.prepare(`
        UPDATE matches
        SET status=?1, winner_player_id=?2, score=?3, set_scores=?4,
            source_updated_at=?5, updated_at=CURRENT_TIMESTAMP
        WHERE id=?6
          AND (status<>?1
            OR ifnull(winner_player_id,'')<>ifnull(?2,'')
            OR ifnull(score,'')<>ifnull(?3,'')
            OR ifnull(set_scores,'')<>ifnull(?4,''))
      `).bind(item.status, item.winnerId, item.score, JSON.stringify(item.setScores), checkedAt, item.id)));
      updated = results.reduce((total, result) => total + Number(result.meta?.changes || 0), 0);
    }
  } catch (error) {
    status = "error";
    message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    console.error(JSON.stringify({ event: "adaptive_sync_failed", target: group.key, error: message }));
  }

  await env.DB.prepare(`
    INSERT INTO adaptive_sync_state
      (target_key,last_checked_at,next_check_at,last_status,updated_count,message)
    VALUES (?1,?2,?3,?4,?5,?6)
    ON CONFLICT(target_key) DO UPDATE SET
      last_checked_at=excluded.last_checked_at,
      next_check_at=excluded.next_check_at,
      last_status=excluded.last_status,
      updated_count=excluded.updated_count,
      message=excluded.message
  `).bind(group.key, checkedAt, nextCheckAt, status, updated, message).run();
  return updated;
}

function extractTerminalUpdates(payload, requestedTour, requestedDate, checkedAt) {
  const updates = [];
  for (const event of Array.isArray(payload?.events) ? payload.events : []) {
    for (const group of Array.isArray(event?.groupings) ? event.groupings : []) {
      const slug = group?.grouping?.slug;
      const tour = slug === "mens-singles" ? "ATP" : slug === "womens-singles" ? "WTA" : null;
      if (tour !== requestedTour) continue;
      for (const competition of Array.isArray(group?.competitions) ? group.competitions : []) {
        const id = String(competition?.id || "");
        const competitionDate = localCompetitionDate(competition?.date);
        const status = terminalStatus(competition);
        const competitors = [...(Array.isArray(competition?.competitors) ? competition.competitors : [])]
          .sort((left, right) => Number(left?.order ?? 99) - Number(right?.order ?? 99));
        if (!id || competitionDate !== requestedDate || !status || competitors.length !== 2) continue;
        const { score, setScores } = scoreData(competitors);
        const winnerIndex = competitors.findIndex((competitor) => competitor?.winner === true);
        updates.push({
          id: `espn-${id}`,
          status,
          winnerId: winnerIndex >= 0 ? playerId(competitors[winnerIndex]) : null,
          score,
          setScores,
          checkedAt
        });
      }
    }
  }
  return updates;
}

function terminalStatus(competition) {
  const type = competition?.status?.type || {};
  const description = String(type.description || "").toLowerCase();
  if (type.state === "post" || type.completed === true) return "finished";
  if (description.includes("cancel") || description.includes("abandon")) return "cancelled";
  if (description.includes("postpon") || description.includes("suspend")) return "postponed";
  return null;
}

function scoreData(competitors) {
  const maximum = Math.max(...competitors.map((item) => Array.isArray(item?.linescores) ? item.linescores.length : 0), 0);
  const setScores = [];
  for (let index = 0; index < maximum; index += 1) {
    const values = competitors.map((item) => item?.linescores?.[index]?.value);
    if (values.every((value) => Number.isFinite(Number(value)))) {
      setScores.push({ p1: Number(values[0]), p2: Number(values[1]) });
    }
  }
  return {
    score: setScores.length ? setScores.map((set) => `${set.p1}-${set.p2}`).join(" ") : null,
    setScores
  };
}

function playerId(competitor) {
  const rawId = String(competitor?.id || competitor?.athlete?.id || "");
  return rawId && !rawId.startsWith("-") ? `espn-${rawId}` : null;
}

function localCompetitionDate(value) {
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.getTime()) ? beijingDate(parsed) : null;
}

function beijingDate(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function pollingIntervalMinutes(level, tournament) {
  const value = `${level || ""} ${tournament || ""}`.toLowerCase();
  if (/grand slam|1000|finals|olympic|australian open|roland garros|french open|wimbledon|us open/.test(value)) return 10;
  if (/\b500\b/.test(value)) return 30;
  return 60;
}

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
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b))
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}
