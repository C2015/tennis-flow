import { SCOREBOARD_HEADERS, scoreboardUpdateStatus } from "./adaptive.js";

export const MAX_MATCHES_PER_TICK = 2;
const POLL_MINUTES = 5;
const CORE_API = "https://sports.core.api.espn.com/v2/sports/tennis/leagues";
const MAX_RESOURCE_CHARS = 16_384;

export function beijingDate(date) {
  return new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function playerId(id) {
  const value = String(id || "");
  if (!/^\d+$/.test(value)) throw new Error("Invalid ESPN player ID");
  return `espn-${value}`;
}

function corePlayerOrder(match, competition) {
  if (`espn-${competition.id}` !== match.id) throw new Error("ESPN competition ID mismatch");
  const players = competition.competitors || [];
  if (players.length !== 2 || playerId(players[0].id) === playerId(players[1].id)) throw new Error("Invalid ESPN player pairing");
  const first = players.find((p) => playerId(p.id) === match.player1Id);
  const second = players.find((p) => playerId(p.id) === match.player2Id);
  if (first) return [first, players.find((p) => p !== first)];
  if (second) return [players.find((p) => p !== second), second];
  return [...players].sort((a, b) => Number(a.order || 99) - Number(b.order || 99));
}

export function coreMatchUpdate(match, competition, status, lines) {
  const players = corePlayerOrder(match, competition);
  const nextIds = players.map((p) => playerId(p.id));
  const lineupChanged = nextIds[0] !== match.player1Id || nextIds[1] !== match.player2Id;
  const nextStatus = scoreboardUpdateStatus(status.type);
  // Pre-match snapshots must not clear a score that is already in the database.
  if (!nextStatus && !lineupChanged) return null;

  let score = lineupChanged ? null : (match.score || null);
  let setScores = lineupChanged ? [] : typeof match.setScores === "string" ? JSON.parse(match.setScores || "[]") : (match.setScores || []);
  if (lines) {
    const periods = lines.map((payload) => {
      if (!Array.isArray(payload.items) || Number(payload.pageCount || 1) > 1
          || Number(payload.count) > payload.items.length) throw new Error("Incomplete ESPN linescores");
      const values = new Map();
      for (const item of payload.items) {
        if (!Number.isInteger(item.period) || item.period < 1 || item.period > 5
            || typeof item.value !== "number" || !Number.isFinite(item.value)) {
          throw new Error("Invalid ESPN set score");
        }
        values.set(item.period, item.value);
      }
      return values;
    });
    const nextSets = [...periods[0].keys()].sort((a, b) => a - b)
      .filter((period) => periods[1].has(period))
      .map((period) => ({ p1: periods[0].get(period), p2: periods[1].get(period) }));
    if (!nextSets.length && status.type?.state === "in" && score) {
      throw new Error("Empty live snapshot; retaining existing score");
    }
    if (nextSets.length) {
      setScores = nextSets;
      score = setScores.map((set) => `${set.p1}-${set.p2}`).join(" ");
    }
  }
  const update = {
    status: nextStatus || "scheduled",
    winnerId: players.some((p) => p.winner === true) ? playerId(players.find((p) => p.winner === true).id) : null,
    score,
    setScores
  };
  if (lineupChanged) {
    update.player1Id = nextIds[0];
    update.player2Id = nextIds[1];
    update.newPlayers = players.filter((p) => ![match.player1Id, match.player2Id].includes(playerId(p.id))).map((p) => {
      if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 120) throw new Error("Invalid ESPN replacement player name");
      return { id: playerId(p.id), name: p.name.trim() };
    });
  }
  return update;
}

async function fetchCoreJson(url) {
  const response = await fetch(url, { headers: SCOREBOARD_HEADERS, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`ESPN core returned ${response.status}`);
  if (Number(response.headers.get("content-length") || 0) > MAX_RESOURCE_CHARS) {
    await response.body?.cancel();
    throw new Error("ESPN single-match resource exceeded size limit");
  }
  const body = await response.text();
  if (body.length > MAX_RESOURCE_CHARS) throw new Error("ESPN single-match resource exceeded size limit");
  return JSON.parse(body);
}

export async function readCoreMatch(match) {
  const competitionId = /^espn-(\d+)$/.exec(match.id)?.[1];
  const tournament = /^espn-(\d+(?:-\d{4})?)-(atp|wta)$/.exec(match.tournamentId);
  if (!competitionId || !tournament) throw new Error("Unsupported ESPN match identifiers");
  const base = `${CORE_API}/${tournament[2]}/events/${tournament[1]}/competitions/${competitionId}`;
  const pairing = await fetchCoreJson(`${base}/competitors`);
  if (!Array.isArray(pairing.items) || pairing.items.length !== 2
      || Number(pairing.pageCount || 1) > 1 || Number(pairing.count) !== 2) {
    throw new Error("Incomplete ESPN competitor list");
  }
  const competition = { id: competitionId, competitors: pairing.items };
  const playerIds = corePlayerOrder(match, competition).map((player) => String(player.id));
  const status = await fetchCoreJson(`${base}/status`);
  if (!scoreboardUpdateStatus(status.type)) return coreMatchUpdate(match, competition, status, null);
  let lines = null;
  if (status.type?.state === "in" || status.type?.state === "post" || status.type?.completed) {
    // Preserve the stored player's side when ESPN replaces an opponent.
    lines = await Promise.all(playerIds.map((id) => fetchCoreJson(`${base}/competitors/${id}/linescores`)));
  }
  return coreMatchUpdate(match, competition, status, lines);
}

export async function runLiveSync(env, now, tour) {
  const checkedAt = now.toISOString();
  const today = beijingDate(now);
  const earliest = beijingDate(new Date(now.getTime() - 18 * 3_600_000));
  const latest = beijingDate(new Date(now.getTime() + 30 * 60_000));
  const result = await env.DB.prepare(`
    SELECT m.id,m.match_date AS date,m.start_time AS time,m.status,m.score,m.set_scores AS setScores,
           m.player1_id AS player1Id,m.player2_id AS player2Id,t.id AS tournamentId,t.tour,
           s.last_checked_at AS lastCheckedAt
    FROM matches m JOIN tournaments t ON t.id=m.tournament_id
    LEFT JOIN adaptive_sync_state s ON s.target_key='match:' || m.id
    WHERE m.status IN ('scheduled','postponed') AND t.tour=?1 AND m.id LIKE 'espn-%'
      AND m.match_date BETWEEN ?2 AND ?3
      AND ((m.start_time IS NOT NULL
        AND datetime(m.match_date || ' ' || m.start_time || ':00','-8 hours')
          BETWEEN datetime(?4,'-18 hours') AND datetime(?4,'+30 minutes'))
        OR (?5=1 AND m.start_time IS NULL AND m.match_date=?6))
      AND (s.next_check_at IS NULL OR s.next_check_at<=?4)
    ORDER BY coalesce(s.last_checked_at,'') ASC,m.match_date,m.start_time,m.id
    LIMIT ?7
  `).bind(tour, earliest, latest, checkedAt, now.getUTCMinutes() < 5 ? 1 : 0, today, MAX_MATCHES_PER_TICK).all();
  const matches = result.results || [];
  let updated = 0;
  let failures = 0;
  const statements = [];
  const updateIndexes = [];
  for (const match of matches) {
    const started = Date.now();
    let update = null;
    let error = null;
    try { update = await readCoreMatch(match); }
    catch (problem) { error = String(problem?.message || problem).slice(0, 240); failures += 1; }
    const nextCheckAt = new Date(now.getTime() + POLL_MINUTES * 60_000).toISOString();
    if (update) {
      for (const player of update.newPlayers || []) {
        statements.push(env.DB.prepare("INSERT INTO players(id,name) VALUES (?1,?2) ON CONFLICT(id) DO NOTHING").bind(player.id, player.name));
      }
      updateIndexes.push(statements.length);
      statements.push(env.DB.prepare(`
      UPDATE matches SET status=?1,winner_player_id=?2,score=?3,set_scores=?4,
        player1_rank=CASE WHEN player1_id<>?7 THEN NULL ELSE player1_rank END,
        player2_rank=CASE WHEN player2_id<>?8 THEN NULL ELSE player2_rank END,
        player1_id=?7,player2_id=?8,
        source_updated_at=?5,updated_at=CURRENT_TIMESTAMP
      WHERE id=?6 AND (status<>'finished' OR ?1='finished')
        AND coalesce(julianday(source_updated_at),0)<=julianday(?5)
        AND (status<>?1 OR player1_id<>?7 OR player2_id<>?8 OR ifnull(winner_player_id,'')<>ifnull(?2,'')
        OR ifnull(score,'')<>ifnull(?3,'') OR ifnull(set_scores,'')<>?4)
    `).bind(update.status, update.winnerId, update.score, JSON.stringify(update.setScores), checkedAt, match.id,
      update.player1Id || match.player1Id, update.player2Id || match.player2Id));
    }
    statements.push(env.DB.prepare(`
      INSERT INTO adaptive_sync_state (target_key,last_checked_at,next_check_at,last_status,updated_count,message)
      VALUES (?1,?2,?3,?4,CASE WHEN EXISTS(SELECT 1 FROM matches WHERE id=?6 AND source_updated_at=?2) THEN 1 ELSE 0 END,?5)
      ON CONFLICT(target_key) DO UPDATE SET
        last_checked_at=excluded.last_checked_at,next_check_at=excluded.next_check_at,
        last_status=excluded.last_status,updated_count=excluded.updated_count,message=excluded.message
    `).bind(`match:${match.id}`, checkedAt, nextCheckAt, error ? "error" : "success", error, match.id));
    statements.push(env.DB.prepare(`
      INSERT INTO adaptive_sync_runs
        (checked_at,target_key,match_date,tour,interval_minutes,due_reason,status,http_status,duration_ms,updated_count,next_check_at,message)
      VALUES (?1,?2,?3,?4,?5,'single_match',?6,?7,?8,
        CASE WHEN EXISTS(SELECT 1 FROM matches WHERE id=?11 AND source_updated_at=?1) THEN 1 ELSE 0 END,?9,?10)
    `).bind(checkedAt, `match:${match.id}`, match.date, tour, POLL_MINUTES,
      error ? "error" : "success", error ? null : 200, Date.now() - started, nextCheckAt, error, match.id));
  }
  if (statements.length) {
    const outcomes = await env.DB.batch(statements);
    updated = updateIndexes.reduce((total, index) => total + Number(outcomes[index]?.meta?.changes || 0), 0);
  }
  const status = failures ? "partial_error" : "success";
  await env.DB.prepare(`
    INSERT INTO adaptive_cron_runs
      (scheduled_at,finished_at,active_groups,requested_groups,successful_groups,failed_groups,updated_count,status,message)
    VALUES (?1,?2,?3,?3,?4,?5,?6,?7,?8)
  `).bind(checkedAt, new Date().toISOString(), matches.length, matches.length - failures,
    failures, updated, status, `ESPN single-match ${tour}; batch limit ${MAX_MATCHES_PER_TICK}`).run();
  if (tour === "WTA" && now.getUTCHours() === 3 && now.getUTCMinutes() === 3) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM adaptive_cron_runs WHERE scheduled_at < datetime('now','-30 days')"),
      env.DB.prepare("DELETE FROM adaptive_sync_runs WHERE checked_at < datetime('now','-30 days')"),
      env.DB.prepare("DELETE FROM adaptive_sync_state WHERE last_checked_at < datetime('now','-30 days')")
    ]);
  }
  console.log(JSON.stringify({ event: "single_match_sync", checkedAt, tour, checked: matches.length, updated, failures, status }));
  return { checked: matches.length, updated, failures };
}

export default {
  async scheduled(controller, env) {
    // Keep the previous schedules working while Cloudflare propagates their removal.
    const legacyTours = { "1-59/5 * * * *": "ATP", "3-59/5 * * * *": "WTA" };
    const tour = legacyTours[controller.cron] || env.LIVE_TOUR;
    if (!["ATP", "WTA"].includes(tour)) {
      throw new Error("Unrecognized live sync schedule or tour");
    }
    await runLiveSync(env, new Date(controller.scheduledTime), tour);
  }
};
