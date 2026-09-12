import {
  SCOREBOARD_HEADERS,
  adaptiveDueReason,
  matchDisplayStatus,
  pollingIntervalMinutes,
  scoreboardUpdateStatus
} from "./adaptive.js";
import { broadcastsForMatch } from "./broadcasts.js";
import {
  US_OPEN_HOST,
  fetchUsOpenJson,
  fetchUsOpenCompleteStats,
  fetchUsOpenLiveStats,
  playerPairKey,
  usOpenPlayerName,
  usOpenStats,
  usOpenTournamentDay
} from "./stats.js";

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
          statements.push(env.DB.prepare("INSERT INTO tournaments (id,name,tour,level,surface,city,country,draw_url,featured) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET name=excluded.name,tour=excluded.tour,level=excluded.level,surface=coalesce(excluded.surface,tournaments.surface),city=excluded.city,country=excluded.country,draw_url=coalesce(excluded.draw_url,tournaments.draw_url),featured=excluded.featured").bind(event.tournament.id,event.tournament.name,event.tournament.tour,event.tournament.level,event.tournament.surface||null,event.tournament.city||null,event.tournament.country||null,event.tournament.drawUrl||null,event.tournament.level === "Grand Slam" ? 1 : 0));
          for (const player of event.players) {
            statements.push(env.DB.prepare("INSERT INTO players (id,name,name_zh,country_code) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_zh=coalesce(excluded.name_zh,players.name_zh),country_code=excluded.country_code").bind(player.id,player.name,player.nameZh||null,player.country||null));
          }
          statements.push(env.DB.prepare("INSERT INTO matches (id,tournament_id,match_date,start_time,status,round,court,best_of,player1_id,player2_id,player1_rank,player2_rank,winner_player_id,score,set_scores,stats,source_url,source_updated_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET tournament_id=excluded.tournament_id,match_date=excluded.match_date,start_time=excluded.start_time,status=excluded.status,round=excluded.round,court=excluded.court,best_of=excluded.best_of,player1_id=excluded.player1_id,player2_id=excluded.player2_id,player1_rank=excluded.player1_rank,player2_rank=excluded.player2_rank,winner_player_id=excluded.winner_player_id,score=excluded.score,set_scores=excluded.set_scores,stats=coalesce(excluded.stats,matches.stats),source_url=excluded.source_url,source_updated_at=excluded.source_updated_at,updated_at=CURRENT_TIMESTAMP").bind(event.id,event.tournament.id,event.date,event.time||null,event.status,event.round||null,event.court||null,event.bestOf||3,event.players[0].id,event.players[1].id,event.players[0].rank||null,event.players[1].rank||null,event.winnerId||null,event.score||null,JSON.stringify(event.setScores||[]),event.stats?JSON.stringify(event.stats):null,event.sourceUrl||null,feed.updatedAt));
          imported += 1;
        }
        await env.DB.batch(statements);
      }
      await env.DB.prepare("INSERT INTO sync_runs (started_at,finished_at,status,source,imported_count,message) VALUES (?1,?2,'success',?3,?4,?5)").bind(startedAt,new Date().toISOString(),feed.source,imported,"GitHub Actions incremental sync").run();
      return json({ ok: true, imported, source: feed.source });
    }

    if (url.pathname === "/api/health") {
      const [sync, availability, adaptiveCron, adaptiveRequest] = await Promise.all([
        env.DB.prepare("SELECT finished_at, status, source, imported_count FROM sync_runs ORDER BY id DESC LIMIT 1").first(),
        env.DB.prepare("SELECT min(match_date) AS firstDate, max(match_date) AS latestDate FROM matches WHERE source_url IS NOT NULL").first(),
        env.DB.prepare("SELECT scheduled_at AS scheduledAt,finished_at AS finishedAt,active_groups AS activeGroups,requested_groups AS requestedGroups,successful_groups AS successfulGroups,failed_groups AS failedGroups,updated_count AS updatedCount,status FROM adaptive_cron_runs ORDER BY id DESC LIMIT 1").first(),
        env.DB.prepare("SELECT checked_at AS checkedAt,target_key AS targetKey,interval_minutes AS intervalMinutes,due_reason AS dueReason,status,http_status AS httpStatus,duration_ms AS durationMs,updated_count AS updatedCount,next_check_at AS nextCheckAt FROM adaptive_sync_runs ORDER BY id DESC LIMIT 1").first()
      ]);
      return json({
        ok: true,
        database: "connected",
        lastSync: sync || null,
        availability,
        adaptive: { lastCron: adaptiveCron || null, lastRequest: adaptiveRequest || null }
      });
    }

    if (url.pathname === "/api/matches") {
      const date = url.searchParams.get("date");
      const tour = (url.searchParams.get("tour") || "all").toUpperCase();
      const query = (url.searchParams.get("q") || "").trim().slice(0, 60);

      if (!date || !DATE_RE.test(date)) return json({ error: "日期格式应为 YYYY-MM-DD" }, 400);
      if (!["ALL", "ATP", "WTA", "SLAM"].includes(tour)) return json({ error: "无效的赛事筛选" }, 400);

      const term = `%${query}%`;
      const [result, ruleResult, exactResult] = await Promise.all([
        env.DB.prepare(`
        SELECT
          m.id, m.match_date AS date, m.start_time AS time, m.status,
          m.round, m.court, m.best_of AS bestOf, m.score, m.set_scores AS setScores,
          m.stats, m.source_url AS sourceUrl,
          t.id AS tournamentId, t.name AS tournament, t.tour, t.level, t.surface, t.city, t.country, t.draw_url AS drawUrl,
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
        `).bind(date, tour, query, term).all(),
        env.DB.prepare(`
          SELECT id,platform,platform_name AS platformName,tournament_patterns AS tournamentPatterns,
                 tour,level,exclude_level AS excludeLevel,exclude_country AS excludeCountry,
                 starts_on AS startsOn,ends_on AS endsOn,coverage,watch_url AS watchUrl,
                 mini_program_app_id AS miniProgramAppId,mini_program_path AS miniProgramPath,
                 source_url AS sourceUrl,is_free AS isFree,priority,active,verified_at AS verifiedAt
          FROM broadcast_rules
          WHERE active=1 AND starts_on<=?1 AND ends_on>=?1
          ORDER BY priority DESC
        `).bind(date).all(),
        env.DB.prepare(`
          SELECT b.match_id AS matchId,b.platform,b.platform_name AS platformName,b.watch_url AS watchUrl,
                 b.mini_program_app_id AS miniProgramAppId,b.mini_program_path AS miniProgramPath,
                 b.source_url AS sourceUrl,b.is_free AS isFree,b.verified_at AS verifiedAt,1000 AS priority
          FROM match_broadcasts b JOIN matches m ON m.id=b.match_id
          WHERE m.match_date=?1 AND b.active=1
            AND (b.expires_at IS NULL OR datetime(b.expires_at)>datetime('now'))
        `).bind(date).all()
      ]);

      const matches = result.results.map((row) => {
        const setScores = safeParse(row.setScores, []);
        const match = {
          ...row,
          status: matchDisplayStatus(row.status, setScores, row.score),
          setScores,
          stats: safeParse(row.stats, null),
          winner: row.winnerPlayerId === row.player1Id ? 1 : row.winnerPlayerId === row.player2Id ? 2 : null
        };
        return { ...match, broadcasts: broadcastsForMatch(match, ruleResult.results, exactResult.results) };
      });
      let suggestedDate = null;
      if (!matches.length) {
        const nearest = await env.DB.prepare("SELECT match_date AS date FROM matches WHERE source_url IS NOT NULL ORDER BY abs(julianday(match_date) - julianday(?1)) LIMIT 1").bind(date).first();
        suggestedDate = nearest?.date || null;
      }
      return json({ date, timezone: "Asia/Shanghai", matches, suggestedDate });
    }

    if (url.pathname === "/api/draw") {
      const tournamentId = (url.searchParams.get("tournamentId") || "").trim();
      if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(tournamentId)) return json({ error: "无效的赛事编号" }, 400);

      const [tournament, result] = await Promise.all([
        env.DB.prepare(`
          SELECT id,name,tour,level,surface,city,country,draw_url AS drawUrl
          FROM tournaments WHERE id=?1
        `).bind(tournamentId).first(),
        env.DB.prepare(`
          SELECT
            m.id,m.match_date AS date,m.start_time AS time,m.status,m.round,m.court,m.score,
            m.set_scores AS setScores,m.winner_player_id AS winnerPlayerId,
            m.player1_id AS player1Id,p1.name AS player1,p1.name_zh AS player1Zh,
            p1.country_code AS player1Country,m.player1_rank AS player1Rank,
            m.player2_id AS player2Id,p2.name AS player2,p2.name_zh AS player2Zh,
            p2.country_code AS player2Country,m.player2_rank AS player2Rank
          FROM matches m
          JOIN players p1 ON p1.id=m.player1_id
          JOIN players p2 ON p2.id=m.player2_id
          WHERE m.tournament_id=?1
          ORDER BY m.match_date,m.start_time,m.id
        `).bind(tournamentId).all()
      ]);
      if (!tournament) return json({ error: "没有找到这项赛事" }, 404);

      const matches = result.results.map((row) => {
        const setScores = safeParse(row.setScores, []);
        return {
          ...row,
          status: matchDisplayStatus(row.status, setScores, row.score),
          setScores,
          winner: row.winnerPlayerId === row.player1Id ? 1 : row.winnerPlayerId === row.player2Id ? 2 : null
        };
      });
      return json({ timezone: "Asia/Shanghai", tournament, matches });
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "接口不存在" }, 404);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env) {
    await runAdaptiveSync(env, new Date(controller.scheduledTime));
  }
};

async function runAdaptiveSync(env, now) {
  const scheduledAt = now.toISOString();
  const runStartedAt = Date.now();
  let activeGroups = 0;
  let requestedGroups = 0;
  let successfulGroups = 0;
  let failedGroups = 0;
  let updated = 0;

  try {
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
    env.DB.prepare("SELECT target_key, last_checked_at, next_check_at FROM adaptive_sync_state").all()
  ]);

  const states = new Map(stateResult.results.map((row) => [row.target_key, row]));
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

  activeGroups = groups.size;
  const due = [...groups.values()].flatMap((group) => {
    const dueReason = adaptiveDueReason(group, states.get(group.key), now.getTime());
    return dueReason ? [{ ...group, dueReason }] : [];
  });
  requestedGroups = due.length;

  for (const group of due) {
    const result = await refreshScoreboardGroup(env, group, now);
    updated += result.updated;
    if (result.status === "success") successfulGroups += 1;
    else failedGroups += 1;
  }
  updated += await refreshMissingUsOpenStats(env, now);
  const status = failedGroups ? "partial_error" : "success";
  await recordAdaptiveCronRun(env, {
    scheduledAt, activeGroups, requestedGroups, successfulGroups, failedGroups, updated, status, message: null
  });
  await pruneAdaptiveHistory(env);
  console.log(JSON.stringify({
    event: "adaptive_sync_complete",
    checkedAt: scheduledAt,
    durationMs: Date.now() - runStartedAt,
    activeGroups,
    requestedGroups,
    successfulGroups,
    failedGroups,
    updated,
    status
  }));
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    await recordAdaptiveCronRun(env, {
      scheduledAt, activeGroups, requestedGroups, successfulGroups, failedGroups, updated, status: "error", message
    }).catch(() => {});
    console.error(JSON.stringify({ event: "adaptive_cron_failed", checkedAt: scheduledAt, error: message }));
    throw error;
  }
}

async function refreshMissingUsOpenStats(env, now) {
  const earliestDate = beijingDate(new Date(now.getTime() - 3 * 86_400_000));
  const latestDate = beijingDate(now);
  const result = await env.DB.prepare(`
    SELECT m.id,m.match_date AS date,p1.name AS player1,p2.name AS player2
    FROM matches m
    JOIN tournaments t ON t.id=m.tournament_id
    JOIN players p1 ON p1.id=m.player1_id
    JOIN players p2 ON p2.id=m.player2_id
    WHERE lower(t.name) LIKE '%us open%'
      AND m.match_date BETWEEN ?1 AND ?2
      AND m.status='finished'
      AND (m.stats IS NULL OR m.stats NOT LIKE '%"phase":"final"%')
  `).bind(earliestDate, latestDate).all();
  const targets = result.results || [];
  if (!targets.length) return 0;

  const years = new Set(targets.map((match) => match.date.slice(0, 4)));
  const urls = new Set([...years].map((year) => `${US_OPEN_HOST}/en_US/scores/feeds/${year}/matches/live/scores.json`));
  for (const target of targets) {
    for (const offset of [0, -1]) {
      const officialDate = addIsoDays(target.date, offset);
      const day = usOpenTournamentDay(officialDate);
      if (day) urls.add(`${US_OPEN_HOST}/en_US/scores/feeds/${target.date.slice(0, 4)}/completed_matches/days/day_${day}.json`);
    }
  }

  const candidates = new Map();
  const feeds = await Promise.allSettled([...urls].map((url) => fetchUsOpenJson(url)));
  for (const feed of feeds) {
    if (feed.status !== "fulfilled") continue;
    for (const match of Array.isArray(feed.value?.matches) ? feed.value.matches : []) {
      const names = [usOpenPlayerName(match.team1), usOpenPlayerName(match.team2)];
      if (names.every(Boolean)) candidates.set(playerPairKey(names), match);
    }
  }

  const resolved = await Promise.all(targets.map(async (target) => {
    const names = [target.player1, target.player2];
    const officialMatch = candidates.get(playerPairKey(names));
    if (!officialMatch) return null;
    let stats = null;
    try {
      stats = await fetchUsOpenCompleteStats(target.date.slice(0, 4), officialMatch.match_id, names);
    } catch {
      return null;
    }
    return stats ? { id: target.id, stats } : null;
  }));
  const updates = resolved.filter(Boolean);
  if (!updates.length) return 0;
  const outcomes = await env.DB.batch(updates.map((item) => env.DB.prepare(`
    UPDATE matches SET stats=?1,updated_at=CURRENT_TIMESTAMP
    WHERE id=?2 AND ifnull(stats,'')<>?1
  `).bind(JSON.stringify(item.stats), item.id)));
  const changed = outcomes.reduce((total, outcome) => total + Number(outcome.meta?.changes || 0), 0);
  console.log(JSON.stringify({ event: "official_stats_backfill", targets: targets.length, updated: changed }));
  return changed;
}

function addIsoDays(value, amount) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

async function refreshScoreboardGroup(env, group, now) {
  const startedAt = Date.now();
  const checkedAt = now.toISOString();
  const nextCheckAt = new Date(now.getTime() + group.interval * 60_000).toISOString();
  const compactDate = group.date.replaceAll("-", "");
  const url = `${ESPN_SCOREBOARD}/${group.tour.toLowerCase()}/scoreboard?dates=${compactDate}`;
  let status = "success";
  let message = null;
  let updated = 0;
  let httpStatus = null;

  try {
    const response = await fetch(url, {
      headers: SCOREBOARD_HEADERS,
      signal: AbortSignal.timeout(15_000)
    });
    httpStatus = response.status;
    if (!response.ok) throw new Error(`ESPN returned ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > 5_000_000) throw new Error("ESPN response exceeded 5MB");
    const payload = await response.json();
    const updates = extractScoreboardUpdates(payload, group.tour, group.date, checkedAt);
    if (updates.some((item) => item.isUsOpen)) {
      try {
        const official = await fetchUsOpenLiveStats(group.date.slice(0, 4));
        for (const item of updates) {
          if (!item.isUsOpen) continue;
          const officialMatch = official.get(playerPairKey(item.playerNames))?.match;
          if (!officialMatch) {
            item.stats = null;
          } else if (item.status === "finished") {
            item.stats = await fetchUsOpenCompleteStats(
              group.date.slice(0, 4),
              officialMatch.match_id,
              item.playerNames
            );
          } else {
            item.stats = usOpenStats(officialMatch, item.playerNames, { phase: "live" });
          }
        }
      } catch (error) {
        console.warn(JSON.stringify({
          event: "official_stats_unavailable",
          target: group.key,
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)
        }));
      }
    }
    if (updates.length) {
      const results = await env.DB.batch(updates.map((item) => env.DB.prepare(`
        UPDATE matches
        SET status=?1, winner_player_id=?2, score=?3, set_scores=?4,
            stats=coalesce(?5,stats), source_updated_at=?6, updated_at=CURRENT_TIMESTAMP
        WHERE id=?7
          AND (status<>?1
            OR ifnull(winner_player_id,'')<>ifnull(?2,'')
            OR ifnull(score,'')<>ifnull(?3,'')
            OR ifnull(set_scores,'')<>ifnull(?4,'')
            OR (?5 IS NOT NULL AND ifnull(stats,'')<>?5))
      `).bind(item.status, item.winnerId, item.score, JSON.stringify(item.setScores), item.stats ? JSON.stringify(item.stats) : null, checkedAt, item.id)));
      updated = results.reduce((total, result) => total + Number(result.meta?.changes || 0), 0);
    }
  } catch (error) {
    status = "error";
    message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    console.error(JSON.stringify({ event: "adaptive_sync_failed", target: group.key, error: message }));
  }

  const durationMs = Math.max(0, Date.now() - startedAt);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO adaptive_sync_state
      (target_key,last_checked_at,next_check_at,last_status,updated_count,message)
      VALUES (?1,?2,?3,?4,?5,?6)
      ON CONFLICT(target_key) DO UPDATE SET
        last_checked_at=excluded.last_checked_at,
        next_check_at=excluded.next_check_at,
        last_status=excluded.last_status,
        updated_count=excluded.updated_count,
        message=excluded.message
    `).bind(group.key, checkedAt, nextCheckAt, status, updated, message),
    env.DB.prepare(`
      INSERT INTO adaptive_sync_runs
        (checked_at,target_key,match_date,tour,interval_minutes,due_reason,status,http_status,duration_ms,updated_count,next_check_at,message)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
    `).bind(checkedAt, group.key, group.date, group.tour, group.interval, group.dueReason, status, httpStatus, durationMs, updated, nextCheckAt, message)
  ]);
  console.log(JSON.stringify({
    event: "adaptive_scoreboard_request",
    target: group.key,
    intervalMinutes: group.interval,
    dueReason: group.dueReason,
    status,
    httpStatus,
    durationMs,
    updated
  }));
  return { updated, status };
}

async function recordAdaptiveCronRun(env, run) {
  await env.DB.prepare(`
    INSERT INTO adaptive_cron_runs
      (scheduled_at,finished_at,active_groups,requested_groups,successful_groups,failed_groups,updated_count,status,message)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
  `).bind(
    run.scheduledAt,
    new Date().toISOString(),
    run.activeGroups,
    run.requestedGroups,
    run.successfulGroups,
    run.failedGroups,
    run.updated,
    run.status,
    run.message
  ).run();
}

async function pruneAdaptiveHistory(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM adaptive_cron_runs WHERE scheduled_at < datetime('now','-30 days')"),
    env.DB.prepare("DELETE FROM adaptive_sync_runs WHERE checked_at < datetime('now','-30 days')")
  ]);
}

function extractScoreboardUpdates(payload, requestedTour, requestedDate, checkedAt) {
  const updates = [];
  for (const event of Array.isArray(payload?.events) ? payload.events : []) {
    const isUsOpen = /\bus open\b/i.test(String(event?.name || event?.shortName || ""));
    for (const group of Array.isArray(event?.groupings) ? event.groupings : []) {
      const slug = group?.grouping?.slug;
      const tour = slug === "mens-singles" ? "ATP" : slug === "womens-singles" ? "WTA" : null;
      if (tour !== requestedTour) continue;
      for (const competition of Array.isArray(group?.competitions) ? group.competitions : []) {
        const id = String(competition?.id || "");
        const competitionDate = localCompetitionDate(competition?.date);
        const status = scoreboardUpdateStatus(competition?.status?.type);
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
          isUsOpen,
          playerNames: competitors.map((competitor) => competitor?.athlete?.displayName || competitor?.athlete?.fullName || ""),
          stats: null,
          checkedAt
        });
      }
    }
  }
  return updates;
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
