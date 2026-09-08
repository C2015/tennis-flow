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
    return serveEmbeddedAsset(request);
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


const EMBEDDED_ASSETS = {"/":{"type":"text/html; charset=utf-8","body":"<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n  <meta name=\"theme-color\" content=\"#071b16\">\n  <meta name=\"description\" content=\"按北京时间浏览 ATP、WTA 与大满贯赛程及完赛比分。\">\n  <title>球序 · 网球赛程时间流</title>\n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n  <link href=\"https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600;700;800&family=Oswald:wght@500;600&display=swap\" rel=\"stylesheet\">\n  <link rel=\"stylesheet\" href=\"./styles.css?v=4\">\n</head>\n<body>\n  <div class=\"court-lines\" aria-hidden=\"true\"></div>\n  <header class=\"site-header\">\n    <a class=\"brand\" href=\"/\" aria-label=\"球序首页\">\n      <span class=\"brand-ball\"></span>\n      <span>球序</span>\n      <small>TENNIS FLOW</small>\n    </a>\n    <div class=\"header-actions\">\n      <span class=\"timezone\">UTC+8 · 北京时间</span>\n      <button class=\"icon-button\" id=\"searchButton\" aria-label=\"搜索球员或赛事\">\n        <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"11\" cy=\"11\" r=\"6.5\"></circle><path d=\"m16 16 4 4\"></path></svg>\n      </button>\n    </div>\n  </header>\n\n  <main>\n    <section class=\"hero\">\n      <div class=\"eyebrow\"><span></span> 每 6 小时更新</div>\n      <h1>今天，<br><em>谁在场上？</em></h1>\n      <p>ATP、WTA 与大满贯赛程，按时间自然展开。</p>\n      <div class=\"hero-orbit\" aria-hidden=\"true\"><i></i></div>\n    </section>\n\n    <section class=\"scoreboard\" aria-label=\"赛事查询\">\n      <div class=\"date-heading\">\n        <div>\n          <span id=\"dateYear\">2026</span>\n          <strong id=\"dateTitle\">9月5日</strong>\n          <small id=\"dateLabel\">星期六 · 今天</small>\n        </div>\n        <button class=\"today-button\" id=\"todayButton\">回到今天</button>\n      </div>\n\n      <div class=\"date-strip-wrap\">\n        <button class=\"date-arrow\" id=\"prevDates\" aria-label=\"前五天\">←</button>\n        <div class=\"date-strip\" id=\"dateStrip\" role=\"tablist\" aria-label=\"选择日期\"></div>\n        <button class=\"date-arrow\" id=\"nextDates\" aria-label=\"后五天\">→</button>\n      </div>\n\n      <div class=\"toolbar\">\n        <div class=\"filters\" id=\"filters\" aria-label=\"赛事类型筛选\">\n          <button class=\"filter active\" data-tour=\"all\">全部</button>\n          <button class=\"filter\" data-tour=\"slam\">大满贯</button>\n          <button class=\"filter\" data-tour=\"ATP\">ATP</button>\n          <button class=\"filter\" data-tour=\"WTA\">WTA</button>\n        </div>\n        <span class=\"match-count\" id=\"matchCount\">读取中…</span>\n      </div>\n\n      <div class=\"search-panel\" id=\"searchPanel\" hidden>\n        <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"11\" cy=\"11\" r=\"6.5\"></circle><path d=\"m16 16 4 4\"></path></svg>\n        <input id=\"searchInput\" type=\"search\" placeholder=\"搜索球员或赛事\" autocomplete=\"off\">\n        <button id=\"clearSearch\" aria-label=\"清除搜索\">×</button>\n      </div>\n\n      <div class=\"timeline\" id=\"timeline\" aria-live=\"polite\"></div>\n      <div class=\"loading\" id=\"loading\"><span></span><span></span><span></span></div>\n      <div class=\"empty-state\" id=\"emptyState\" hidden>\n        <div class=\"empty-ball\"></div>\n        <h2>这一天暂时没有比赛</h2>\n        <p>试试相邻日期，或清除当前筛选。</p>\n      </div>\n    </section>\n  </main>\n\n  <footer>\n    <div><span class=\"status-dot\"></span><span id=\"syncStatus\">正在检查数据状态</span></div>\n    <p>非商业网球数据项目 · 比赛时间可能因现场安排调整</p>\n  </footer>\n\n  <dialog class=\"match-dialog\" id=\"matchDialog\">\n    <button class=\"dialog-close\" id=\"dialogClose\" aria-label=\"关闭\">×</button>\n    <div id=\"dialogContent\"></div>\n  </dialog>\n\n  <template id=\"tournamentTemplate\">\n    <section class=\"tournament-group\">\n      <header class=\"tournament-header\">\n        <div class=\"tour-mark\"></div>\n        <div><span class=\"tour-level\"></span><h2 class=\"tour-name\"></h2></div>\n        <span class=\"tour-meta\"></span>\n      </header>\n      <div class=\"match-list\"></div>\n    </section>\n  </template>\n\n  <script defer src=\"./app.js?v=3\"></script>\n</body>\n</html>\n"},"/index.html":{"type":"text/html; charset=utf-8","body":"<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n  <meta name=\"theme-color\" content=\"#071b16\">\n  <meta name=\"description\" content=\"按北京时间浏览 ATP、WTA 与大满贯赛程及完赛比分。\">\n  <title>球序 · 网球赛程时间流</title>\n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n  <link href=\"https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600;700;800&family=Oswald:wght@500;600&display=swap\" rel=\"stylesheet\">\n  <link rel=\"stylesheet\" href=\"./styles.css?v=4\">\n</head>\n<body>\n  <div class=\"court-lines\" aria-hidden=\"true\"></div>\n  <header class=\"site-header\">\n    <a class=\"brand\" href=\"/\" aria-label=\"球序首页\">\n      <span class=\"brand-ball\"></span>\n      <span>球序</span>\n      <small>TENNIS FLOW</small>\n    </a>\n    <div class=\"header-actions\">\n      <span class=\"timezone\">UTC+8 · 北京时间</span>\n      <button class=\"icon-button\" id=\"searchButton\" aria-label=\"搜索球员或赛事\">\n        <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"11\" cy=\"11\" r=\"6.5\"></circle><path d=\"m16 16 4 4\"></path></svg>\n      </button>\n    </div>\n  </header>\n\n  <main>\n    <section class=\"hero\">\n      <div class=\"eyebrow\"><span></span> 每 6 小时更新</div>\n      <h1>今天，<br><em>谁在场上？</em></h1>\n      <p>ATP、WTA 与大满贯赛程，按时间自然展开。</p>\n      <div class=\"hero-orbit\" aria-hidden=\"true\"><i></i></div>\n    </section>\n\n    <section class=\"scoreboard\" aria-label=\"赛事查询\">\n      <div class=\"date-heading\">\n        <div>\n          <span id=\"dateYear\">2026</span>\n          <strong id=\"dateTitle\">9月5日</strong>\n          <small id=\"dateLabel\">星期六 · 今天</small>\n        </div>\n        <button class=\"today-button\" id=\"todayButton\">回到今天</button>\n      </div>\n\n      <div class=\"date-strip-wrap\">\n        <button class=\"date-arrow\" id=\"prevDates\" aria-label=\"前五天\">←</button>\n        <div class=\"date-strip\" id=\"dateStrip\" role=\"tablist\" aria-label=\"选择日期\"></div>\n        <button class=\"date-arrow\" id=\"nextDates\" aria-label=\"后五天\">→</button>\n      </div>\n\n      <div class=\"toolbar\">\n        <div class=\"filters\" id=\"filters\" aria-label=\"赛事类型筛选\">\n          <button class=\"filter active\" data-tour=\"all\">全部</button>\n          <button class=\"filter\" data-tour=\"slam\">大满贯</button>\n          <button class=\"filter\" data-tour=\"ATP\">ATP</button>\n          <button class=\"filter\" data-tour=\"WTA\">WTA</button>\n        </div>\n        <span class=\"match-count\" id=\"matchCount\">读取中…</span>\n      </div>\n\n      <div class=\"search-panel\" id=\"searchPanel\" hidden>\n        <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"11\" cy=\"11\" r=\"6.5\"></circle><path d=\"m16 16 4 4\"></path></svg>\n        <input id=\"searchInput\" type=\"search\" placeholder=\"搜索球员或赛事\" autocomplete=\"off\">\n        <button id=\"clearSearch\" aria-label=\"清除搜索\">×</button>\n      </div>\n\n      <div class=\"timeline\" id=\"timeline\" aria-live=\"polite\"></div>\n      <div class=\"loading\" id=\"loading\"><span></span><span></span><span></span></div>\n      <div class=\"empty-state\" id=\"emptyState\" hidden>\n        <div class=\"empty-ball\"></div>\n        <h2>这一天暂时没有比赛</h2>\n        <p>试试相邻日期，或清除当前筛选。</p>\n      </div>\n    </section>\n  </main>\n\n  <footer>\n    <div><span class=\"status-dot\"></span><span id=\"syncStatus\">正在检查数据状态</span></div>\n    <p>非商业网球数据项目 · 比赛时间可能因现场安排调整</p>\n  </footer>\n\n  <dialog class=\"match-dialog\" id=\"matchDialog\">\n    <button class=\"dialog-close\" id=\"dialogClose\" aria-label=\"关闭\">×</button>\n    <div id=\"dialogContent\"></div>\n  </dialog>\n\n  <template id=\"tournamentTemplate\">\n    <section class=\"tournament-group\">\n      <header class=\"tournament-header\">\n        <div class=\"tour-mark\"></div>\n        <div><span class=\"tour-level\"></span><h2 class=\"tour-name\"></h2></div>\n        <span class=\"tour-meta\"></span>\n      </header>\n      <div class=\"match-list\"></div>\n    </section>\n  </template>\n\n  <script defer src=\"./app.js?v=3\"></script>\n</body>\n</html>\n"},"/styles.css":{"type":"text/css; charset=utf-8","body":":root {\n  --ink: #071b16;\n  --forest: #0c2d24;\n  --forest-2: #123e31;\n  --lime: #d9ff43;\n  --chalk: #f2f1e9;\n  --paper: #e7e5da;\n  --muted: #8d9a94;\n  --line: rgba(242, 241, 233, .15);\n  --red: #ff775f;\n  --radius: 22px;\n  font-family: \"Noto Sans SC\", sans-serif;\n  color: var(--chalk);\n  background: var(--ink);\n}\n\n* { box-sizing: border-box; }\nhtml { background: var(--ink); scroll-behavior: smooth; }\nbody { margin: 0; min-height: 100vh; background: radial-gradient(circle at 80% -10%, #1f5643 0, transparent 32rem), var(--ink); }\nbutton, input { font: inherit; }\nbutton { color: inherit; }\nbutton:focus-visible, input:focus-visible { outline: 2px solid var(--lime); outline-offset: 3px; }\n\n.court-lines { position: fixed; inset: 0; pointer-events: none; opacity: .055; z-index: 0; background: linear-gradient(90deg, transparent 8%, #fff 8% 8.1%, transparent 8.1% 91.9%, #fff 91.9% 92%, transparent 92%), linear-gradient(0deg, transparent 18%, #fff 18% 18.1%, transparent 18.1% 49.9%, #fff 49.9% 50.1%, transparent 50.1% 81.9%, #fff 81.9% 82%, transparent 82%); }\n.site-header, main, footer { position: relative; z-index: 1; }\n.site-header { height: 74px; max-width: 1180px; margin: auto; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); }\n.brand { color: var(--chalk); text-decoration: none; display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 19px; letter-spacing: .05em; }\n.brand small { color: var(--muted); font: 500 10px/1 \"Oswald\", sans-serif; letter-spacing: .16em; padding-left: 2px; }\n.brand-ball { width: 22px; height: 22px; border-radius: 50%; background: var(--lime); box-shadow: 0 0 22px rgba(217,255,67,.25); position: relative; overflow: hidden; }\n.brand-ball::before { content: \"\"; position: absolute; width: 18px; height: 18px; border: 1px solid var(--ink); border-radius: 50%; left: -12px; top: 1px; box-shadow: 24px 0 0 -1px var(--lime), 24px 0 0 0 var(--ink); }\n.header-actions { display: flex; align-items: center; gap: 18px; }\n.timezone { color: var(--muted); font-size: 12px; letter-spacing: .05em; }\n.icon-button { width: 38px; height: 38px; border: 1px solid var(--line); border-radius: 50%; background: transparent; display: grid; place-items: center; cursor: pointer; }\n.icon-button:hover { background: var(--lime); color: var(--ink); border-color: var(--lime); }\n.icon-button svg, .search-panel svg { width: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; }\n\nmain { max-width: 1180px; margin: auto; padding: 58px 24px 100px; }\n.hero { min-height: 290px; position: relative; }\n.eyebrow { text-transform: uppercase; color: var(--lime); font: 500 12px/1 \"Oswald\", sans-serif; letter-spacing: .16em; display: flex; gap: 9px; align-items: center; }\n.eyebrow span { width: 22px; height: 1px; background: currentColor; }\n.hero h1 { font-size: clamp(52px, 8.4vw, 104px); line-height: .93; letter-spacing: -.07em; margin: 26px 0 22px; max-width: 820px; }\n.hero h1 em { color: var(--lime); font-style: normal; }\n.hero p { color: var(--muted); margin: 0; font-size: 15px; }\n.hero-orbit { position: absolute; right: 2%; top: -22px; width: 250px; aspect-ratio: 1; border: 1px solid rgba(217,255,67,.16); border-radius: 50%; animation: rotate 15s linear infinite; }\n.hero-orbit::before, .hero-orbit::after { content: \"\"; position: absolute; inset: 22%; border: 1px solid rgba(217,255,67,.11); border-radius: 50%; }\n.hero-orbit::after { inset: 44%; background: var(--lime); border: 0; box-shadow: 0 0 70px rgba(217,255,67,.28); }\n.hero-orbit i { position: absolute; width: 9px; height: 9px; background: var(--lime); border-radius: 50%; top: 15%; left: 12%; }\n@keyframes rotate { to { transform: rotate(360deg); } }\n\n.scoreboard { background: var(--chalk); color: var(--ink); border-radius: 34px; padding: 34px; box-shadow: 0 30px 80px rgba(0,0,0,.25); }\n.date-heading { display: flex; align-items: end; justify-content: space-between; padding-bottom: 28px; }\n.date-heading > div { display: grid; grid-template-columns: auto auto; align-items: end; column-gap: 10px; }\n.date-heading span { color: #8b918c; font: 500 15px/1 \"Oswald\", sans-serif; grid-column: 1; }\n.date-heading strong { font-size: clamp(30px, 4vw, 44px); line-height: 1; letter-spacing: -.04em; grid-column: 1; }\n.date-heading small { color: #6f7772; font-size: 12px; grid-column: 2; padding-bottom: 4px; }\n.today-button { border: 1px solid #c7c9c1; background: transparent; padding: 9px 15px; border-radius: 100px; color: #37453f; font-size: 12px; cursor: pointer; }\n.today-button:hover { background: var(--ink); color: var(--chalk); border-color: var(--ink); }\n\n.date-strip-wrap { display: grid; grid-template-columns: 36px minmax(0, 1fr) 36px; gap: 8px; border-top: 1px solid #d1d1c8; border-bottom: 1px solid #d1d1c8; }\n.date-strip { display: grid; grid-template-columns: repeat(7, minmax(52px, 1fr)); overflow: hidden; }\n.date-tab { min-height: 82px; border: 0; border-left: 1px solid #d1d1c8; background: transparent; color: #737a76; cursor: pointer; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 6px; position: relative; }\n.date-tab:last-child { border-right: 1px solid #d1d1c8; }\n.date-tab span { font-size: 11px; }\n.date-tab strong { color: var(--ink); font: 600 20px/1 \"Oswald\", sans-serif; }\n.date-tab.active { background: var(--ink); color: #aab6b0; }\n.date-tab.active strong { color: var(--lime); }\n.date-tab.today::after { content: \"\"; position: absolute; bottom: 9px; width: 4px; height: 4px; border-radius: 50%; background: var(--lime); }\n.date-arrow { border: 0; background: transparent; color: #5c6862; font-size: 18px; cursor: pointer; }\n.date-arrow:hover { color: var(--ink); }\n\n.toolbar { display: flex; justify-content: space-between; align-items: center; padding: 28px 0 18px; }\n.filters { display: flex; gap: 7px; flex-wrap: wrap; }\n.filter { border: 1px solid #c9ccc4; color: #52605a; background: transparent; padding: 8px 14px; border-radius: 100px; font-size: 12px; cursor: pointer; }\n.filter:hover, .filter.active { color: var(--chalk); background: var(--forest); border-color: var(--forest); }\n.match-count { color: #7e8581; font: 500 12px/1 \"Oswald\", sans-serif; letter-spacing: .06em; }\n.search-panel { height: 50px; border: 1px solid #c8cbc3; border-radius: 14px; display: flex; align-items: center; gap: 12px; padding: 0 14px; margin-bottom: 20px; color: #65706a; }\n.search-panel[hidden] { display: none; }\n.search-panel input { border: 0; background: transparent; flex: 1; outline: 0; color: var(--ink); }\n.search-panel button { border: 0; background: transparent; font-size: 24px; color: #76807b; cursor: pointer; }\n\n.timeline { position: relative; }\n.timeline::before { content: \"\"; position: absolute; left: 62px; top: 20px; bottom: 0; width: 1px; background: #ced0c8; }\n.tournament-group { margin: 12px 0 34px; animation: rise .48s both; }\n@keyframes rise { from { opacity: 0; transform: translateY(12px); } }\n.tournament-header { display: grid; grid-template-columns: 46px minmax(0,1fr) auto; gap: 12px; align-items: center; margin: 0 0 11px 40px; position: relative; }\n.tour-mark { width: 46px; height: 46px; border-radius: 50%; background: var(--forest); border: 10px solid var(--chalk); box-shadow: 0 0 0 1px #cfd1ca; position: relative; z-index: 2; }\n.tour-mark::after { content: \"\"; position: absolute; inset: 9px; border-radius: 50%; background: var(--lime); }\n.tour-level { color: #778079; font: 500 10px/1 \"Oswald\", sans-serif; letter-spacing: .12em; text-transform: uppercase; }\n.tour-name { font-size: 16px; margin: 3px 0 0; letter-spacing: -.02em; }\n.tour-meta { color: #778079; font-size: 11px; }\n.match-list { margin-left: 80px; border-top: 1px solid #d5d6cf; }\n.match-card { width: 100%; border: 0; border-bottom: 1px solid #d5d6cf; background: transparent; color: var(--ink); text-align: left; padding: 17px 8px; display: grid; grid-template-columns: 76px minmax(0, 1fr) auto 24px; gap: 14px; align-items: center; cursor: pointer; transition: background .2s, padding .2s; }\n.match-card:hover { background: #e9e9df; padding-left: 14px; padding-right: 14px; }\n.match-time strong { display: block; font: 600 19px/1 \"Oswald\", sans-serif; }\n.match-time small { color: #78827d; font-size: 10px; }\n.player-row { display: grid; grid-template-columns: 30px minmax(0,1fr) 40px; gap: 8px; min-height: 28px; align-items: center; }\n.flag { color: #78827d; font: 500 9px/1 \"Oswald\", sans-serif; letter-spacing: .04em; }\n.player { min-width: 0; overflow: hidden; font-size: 14px; line-height: 1.1; }\n.player-primary, .player-secondary { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.player-secondary { color: #818984; font: 400 9px/1.2 \"Oswald\", sans-serif; letter-spacing: .02em; margin-top: 3px; }\n.player.winner { font-weight: 800; }\n.rank { color: #858d88; font-size: 10px; }\n.sets { display: flex; gap: 4px; align-items: stretch; }\n.set { width: 29px; min-height: 48px; background: #dedfd7; display: grid; grid-template-rows: 1fr 1fr; place-items: center; font: 600 12px/1 \"Oswald\", sans-serif; border-radius: 4px; }\n.set .won { color: var(--chalk); background: var(--forest); width: 100%; height: 100%; display: grid; place-items: center; border-radius: 3px; }\n.scheduled-label { color: #65716b; font-size: 11px; border: 1px solid #c7cac2; border-radius: 100px; padding: 6px 9px; white-space: nowrap; }\n.chevron { color: #87908b; font-size: 20px; }\n.loading { padding: 80px 0; display: flex; justify-content: center; gap: 7px; }\n.loading[hidden] { display: none; }\n.loading span { width: 7px; height: 7px; background: var(--forest); border-radius: 50%; animation: pulse 1s infinite alternate; }\n.loading span:nth-child(2) { animation-delay: .2s; }.loading span:nth-child(3) { animation-delay: .4s; }\n@keyframes pulse { to { opacity: .2; transform: translateY(-6px); } }\n.empty-state { text-align: center; padding: 70px 20px; }\n.empty-ball { width: 54px; height: 54px; border-radius: 50%; background: var(--lime); margin: auto; box-shadow: inset 0 0 0 1px #bfd738; }\n.empty-state h2 { margin: 18px 0 6px; font-size: 20px; }.empty-state p { margin: 0; color: #75807a; font-size: 13px; }\n\nfooter { max-width: 1180px; margin: auto; padding: 0 24px 44px; display: flex; justify-content: space-between; color: #87958e; font-size: 11px; }\nfooter div { display: flex; gap: 8px; align-items: center; }.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--lime); box-shadow: 0 0 12px var(--lime); }\n\n.match-dialog { width: min(560px, calc(100% - 28px)); border: 0; border-radius: 28px; padding: 0; color: var(--ink); background: var(--chalk); box-shadow: 0 30px 100px rgba(0,0,0,.5); }\n.match-dialog::backdrop { background: rgba(2, 14, 11, .78); backdrop-filter: blur(8px); }\n.dialog-close { position: absolute; right: 18px; top: 14px; z-index: 2; border: 0; background: rgba(255,255,255,.12); color: inherit; width: 34px; height: 34px; border-radius: 50%; cursor: pointer; font-size: 23px; }\n.dialog-hero { background: var(--forest); color: var(--chalk); padding: 32px 28px 25px; }\n.dialog-kicker { color: var(--lime); font: 500 10px/1 \"Oswald\", sans-serif; letter-spacing: .12em; }\n.dialog-hero h2 { font-size: 20px; margin: 8px 44px 22px 0; }\n.dialog-players { display: grid; grid-template-columns: 1fr auto 1fr; gap: 14px; align-items: center; }\n.dialog-player:last-child { text-align: right; }.dialog-player strong { display: block; font-size: 16px; }.dialog-player small { display: block; color: #d4ddd8; font: 400 10px/1.2 \"Oswald\", sans-serif; margin: 3px 0; }.dialog-player span { color: #9fb1a9; font-size: 11px; }\n.dialog-score { color: var(--lime); font: 600 26px/1 \"Oswald\", sans-serif; }\n.dialog-body { padding: 26px 28px 30px; }\n.match-facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 24px; }\n.fact { background: var(--paper); border-radius: 12px; padding: 11px; }.fact span { display: block; color: #7c847f; font-size: 9px; }.fact strong { display: block; margin-top: 4px; font-size: 12px; }\n.stats-title { display: flex; justify-content: space-between; align-items: end; border-bottom: 1px solid #cfd1c9; padding-bottom: 10px; }.stats-title h3 { margin: 0; font-size: 14px; }.stats-title span { color: #7d8580; font-size: 10px; }\n.stat-row { display: grid; grid-template-columns: 46px 1fr 46px; gap: 12px; text-align: center; align-items: center; padding: 11px 0; border-bottom: 1px solid #d9dad3; font: 600 13px/1 \"Oswald\", sans-serif; }.stat-row label { color: #707a74; font: 400 11px/1.2 \"Noto Sans SC\", sans-serif; }\n.no-stats { color: #758079; font-size: 13px; text-align: center; padding: 30px 0 10px; }\n.demo-note { background: #f0e8c8; color: #695d2f; font-size: 11px; line-height: 1.6; padding: 10px 14px; border-radius: 10px; margin-top: 18px; }\n.demo-note a { color: inherit; font-weight: 700; text-underline-offset: 2px; }\n\n@media (max-width: 720px) {\n  .site-header { height: 62px; padding: 0 17px; }.brand small, .timezone { display: none; }\n  main { padding: 35px 0 80px; }.hero { min-height: 250px; padding: 0 20px; overflow: hidden; }.hero h1 { font-size: 56px; margin-top: 24px; }.hero-orbit { width: 180px; right: -60px; top: 8px; }\n  .scoreboard { border-radius: 28px 28px 0 0; padding: 25px 16px 32px; }.date-heading { padding: 0 4px 22px; }.date-heading strong { font-size: 32px; }\n  .date-strip-wrap { grid-template-columns: 22px minmax(0,1fr) 22px; }.date-strip { grid-template-columns: repeat(5, minmax(54px, 1fr)); }.date-tab:nth-child(n+6) { display: none; }.date-tab { min-height: 74px; }.date-tab:nth-child(5) { border-right: 1px solid #d1d1c8; }\n  .toolbar { padding-top: 22px; align-items: start; }.filters { gap: 5px; }.filter { padding: 7px 11px; }.match-count { padding-top: 8px; }\n  .timeline::before { left: 22px; }.tournament-header { margin-left: 0; grid-template-columns: 46px minmax(0,1fr); }.tour-meta { grid-column: 2; margin-top: -10px; }.match-list { margin-left: 41px; }\n  .match-card { grid-template-columns: 60px minmax(0,1fr) auto 14px; gap: 8px; padding: 15px 2px; }.match-time strong { font-size: 17px; }.rank { display: none; }.player-row { grid-template-columns: 27px minmax(0,1fr); }.sets { gap: 2px; }.set { width: 23px; }.chevron { font-size: 15px; }\n  footer { padding: 27px 18px 35px; display: block; } footer p { margin-top: 10px; }\n  .dialog-hero, .dialog-body { padding-left: 20px; padding-right: 20px; }.match-facts { grid-template-columns: 1fr 1fr; }.match-facts .fact:last-child { grid-column: 1 / -1; }\n}\n\n@media (max-width: 360px) {\n  .hero h1 { font-size: 49px; }\n  .scoreboard { padding-left: 12px; padding-right: 12px; }\n  .today-button { padding: 8px 10px; }\n  .match-list { margin-left: 35px; }\n  .timeline::before { left: 18px; }\n  .match-card { grid-template-columns: 54px minmax(0,1fr) auto 10px; gap: 5px; }\n  .match-time strong { font-size: 16px; }\n  .flag { display: none; }\n  .player-row { grid-template-columns: minmax(0,1fr); }\n  .set { width: 21px; }\n  .scheduled-label { padding: 5px 7px; }\n}\n\n@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; scroll-behavior: auto !important; } }\n"},"/app.js":{"type":"text/javascript; charset=utf-8","body":"const $ = (selector) => document.querySelector(selector);\nconst prefersChinese = (navigator.languages || [navigator.language || \"\"]).some((language) => language.toLowerCase().startsWith(\"zh\"));\nconst state = {\n  date: localISODate(new Date()),\n  anchor: addDays(new Date(), -3),\n  tour: \"all\",\n  query: \"\",\n  matches: [],\n  initialDateResolved: false\n};\n\nconst els = {\n  strip: $(\"#dateStrip\"), timeline: $(\"#timeline\"), loading: $(\"#loading\"), empty: $(\"#emptyState\"),\n  year: $(\"#dateYear\"), title: $(\"#dateTitle\"), label: $(\"#dateLabel\"), count: $(\"#matchCount\"),\n  searchPanel: $(\"#searchPanel\"), searchInput: $(\"#searchInput\"), dialog: $(\"#matchDialog\"),\n  dialogContent: $(\"#dialogContent\"), sync: $(\"#syncStatus\")\n};\n\nrenderDates();\nloadMatches();\nloadHealth();\n\n$(\"#prevDates\").addEventListener(\"click\", () => shiftDates(-5));\n$(\"#nextDates\").addEventListener(\"click\", () => shiftDates(5));\n$(\"#todayButton\").addEventListener(\"click\", () => {\n  state.date = localISODate(new Date());\n  state.anchor = addDays(new Date(), -3);\n  renderDates(); loadMatches();\n});\n$(\"#filters\").addEventListener(\"click\", (event) => {\n  const button = event.target.closest(\"[data-tour]\");\n  if (!button) return;\n  document.querySelectorAll(\".filter\").forEach((item) => item.classList.toggle(\"active\", item === button));\n  state.tour = button.dataset.tour;\n  loadMatches();\n});\n$(\"#searchButton\").addEventListener(\"click\", () => {\n  els.searchPanel.hidden = !els.searchPanel.hidden;\n  if (!els.searchPanel.hidden) els.searchInput.focus();\n});\n$(\"#clearSearch\").addEventListener(\"click\", () => {\n  els.searchInput.value = \"\"; state.query = \"\"; loadMatches(); els.searchInput.focus();\n});\nlet searchTimer;\nels.searchInput.addEventListener(\"input\", () => {\n  clearTimeout(searchTimer);\n  searchTimer = setTimeout(() => { state.query = els.searchInput.value.trim(); loadMatches(); }, 260);\n});\n$(\"#dialogClose\").addEventListener(\"click\", () => els.dialog.close());\nels.dialog.addEventListener(\"click\", (event) => {\n  if (event.target === els.dialog) els.dialog.close();\n});\n\nfunction shiftDates(amount) {\n  state.anchor = addDays(state.anchor, amount);\n  state.date = localISODate(addDays(parseDate(state.date), amount));\n  renderDates(); loadMatches();\n}\n\nfunction renderDates() {\n  const today = localISODate(new Date());\n  const selected = parseDate(state.date);\n  els.year.textContent = selected.getFullYear();\n  els.title.textContent = `${selected.getMonth() + 1}月${selected.getDate()}日`;\n  const delta = dayDiff(selected, new Date());\n  const relative = delta === 0 ? \"今天\" : delta === -1 ? \"昨天\" : delta === 1 ? \"明天\" : \"北京时间\";\n  els.label.textContent = `${weekday(selected, \"long\")} · ${relative}`;\n  els.strip.replaceChildren();\n\n  for (let i = 0; i < 7; i++) {\n    const date = addDays(state.anchor, i);\n    const iso = localISODate(date);\n    const button = document.createElement(\"button\");\n    button.className = `date-tab${iso === state.date ? \" active\" : \"\"}${iso === today ? \" today\" : \"\"}`;\n    button.type = \"button\";\n    button.role = \"tab\";\n    button.setAttribute(\"aria-selected\", iso === state.date ? \"true\" : \"false\");\n    button.innerHTML = `<span>${weekday(date, \"short\")}</span><strong>${String(date.getDate()).padStart(2, \"0\")}</strong>`;\n    button.addEventListener(\"click\", () => { state.date = iso; renderDates(); loadMatches(); });\n    els.strip.append(button);\n  }\n}\n\nasync function loadMatches() {\n  els.loading.hidden = false;\n  els.empty.hidden = true;\n  els.timeline.replaceChildren();\n  const params = new URLSearchParams({ date: state.date, tour: state.tour, q: state.query });\n  try {\n    const response = await fetch(`/api/matches?${params}`);\n    if (!response.ok) throw new Error(`HTTP ${response.status}`);\n    const payload = await response.json();\n    state.matches = payload.matches || [];\n    if (!state.initialDateResolved && !state.matches.length && payload.suggestedDate) {\n      state.initialDateResolved = true;\n      state.date = payload.suggestedDate;\n      state.anchor = addDays(parseDate(payload.suggestedDate), -3);\n      renderDates();\n      return loadMatches();\n    }\n    state.initialDateResolved = true;\n  } catch {\n    state.matches = demoMatches().filter((match) => {\n      const matchesTour = state.tour === \"all\" || match.tour === state.tour || (state.tour === \"slam\" && match.level === \"Grand Slam\");\n      const haystack = `${match.player1} ${match.player1Zh || \"\"} ${match.player2} ${match.player2Zh || \"\"} ${match.tournament}`.toLowerCase();\n      return match.date === state.date && matchesTour && haystack.includes(state.query.toLowerCase());\n    });\n    els.sync.textContent = \"本地预览 · 演示数据\";\n  } finally {\n    els.loading.hidden = true;\n  }\n  renderTimeline();\n}\n\nfunction renderTimeline() {\n  els.count.textContent = `${state.matches.length} 场比赛`;\n  els.empty.hidden = state.matches.length > 0;\n  if (!state.matches.length) return;\n  const groups = Map.groupBy ? Map.groupBy(state.matches, (m) => m.tournament) : groupBy(state.matches, (m) => m.tournament);\n  let delay = 0;\n  for (const [name, matches] of groups) {\n    const tournament = matches[0];\n    const fragment = $(\"#tournamentTemplate\").content.cloneNode(true);\n    const group = fragment.querySelector(\".tournament-group\");\n    group.style.animationDelay = `${delay++ * 60}ms`;\n    fragment.querySelector(\".tour-level\").textContent = `${tournament.tour} · ${tournament.level}`;\n    fragment.querySelector(\".tour-name\").textContent = name;\n    fragment.querySelector(\".tour-meta\").textContent = [tournament.surface, tournament.city].filter(Boolean).join(\" · \");\n    const list = fragment.querySelector(\".match-list\");\n    matches.forEach((match) => list.append(matchCard(match)));\n    els.timeline.append(fragment);\n  }\n}\n\nfunction matchCard(match) {\n  const card = document.createElement(\"button\");\n  card.type = \"button\";\n  card.className = \"match-card\";\n  const sets = match.status === \"finished\"\n    ? `<div class=\"sets\">${(match.setScores || []).map((set) => `<span class=\"set\"><i class=\"${set.p1 > set.p2 ? \"won\" : \"\"}\">${set.p1}</i><i class=\"${set.p2 > set.p1 ? \"won\" : \"\"}\">${set.p2}</i></span>`).join(\"\")}</div>`\n    : `<span class=\"scheduled-label\">待开赛</span>`;\n  card.innerHTML = `\n    <span class=\"match-time\"><strong>${escapeHTML(match.time || \"待定\")}</strong><small>${match.status === \"finished\" ? \"已完赛\" : escapeHTML(match.round || \"赛程\")}</small></span>\n    <span class=\"players\">\n      ${playerRow(match.player1, match.player1Zh, match.player1Country, match.player1Rank, match.winner === 1)}\n      ${playerRow(match.player2, match.player2Zh, match.player2Country, match.player2Rank, match.winner === 2)}\n    </span>\n    ${sets}<span class=\"chevron\">›</span>`;\n  card.addEventListener(\"click\", () => openMatch(match));\n  return card;\n}\n\nfunction playerRow(name, nameZh, country, rank, winner) {\n  const display = playerDisplay(name, nameZh);\n  return `<span class=\"player-row\"><small class=\"flag\">${escapeHTML(country || \"—\")}</small><span class=\"player ${winner ? \"winner\" : \"\"}\"><span class=\"player-primary\">${escapeHTML(display.primary)}</span>${display.secondary ? `<small class=\"player-secondary\">${escapeHTML(display.secondary)}</small>` : \"\"}</span><small class=\"rank\">${rank ? `#${rank}` : \"—\"}</small></span>`;\n}\n\nfunction openMatch(match) {\n  const stats = match.stats;\n  const player1 = playerDisplay(match.player1, match.player1Zh);\n  const player2 = playerDisplay(match.player2, match.player2Zh);\n  const sourceName = match.sourceUrl?.includes(\"espn.com\") ? \"ESPN Tennis\" : \"开放网球数据\";\n  const sourceNote = match.sourceUrl\n    ? `<p class=\"demo-note\">数据来自 <a href=\"${escapeHTML(match.sourceUrl)}\" target=\"_blank\" rel=\"noreferrer\">${sourceName}</a>。开赛时间、场地、排名和技术统计仅在来源提供时展示。</p>`\n    : `<p class=\"demo-note\">这是一条本地演示记录，仅用于界面预览，不代表真实赛程或赛果。</p>`;\n  els.dialogContent.innerHTML = `\n    <div class=\"dialog-hero\">\n      <span class=\"dialog-kicker\">${escapeHTML(match.tour)} · ${escapeHTML(match.level)} · ${escapeHTML(match.round || \"\")}</span>\n      <h2>${escapeHTML(match.tournament)}</h2>\n      <div class=\"dialog-players\">\n        <div class=\"dialog-player\"><strong>${escapeHTML(player1.primary)}</strong>${player1.secondary ? `<small>${escapeHTML(player1.secondary)}</small>` : \"\"}<span>${escapeHTML(match.player1Country || \"—\")} · ${match.player1Rank ? `世界 #${match.player1Rank}` : \"暂无排名\"}</span></div>\n        <div class=\"dialog-score\">${escapeHTML(match.score || \"VS\")}</div>\n        <div class=\"dialog-player\"><strong>${escapeHTML(player2.primary)}</strong>${player2.secondary ? `<small>${escapeHTML(player2.secondary)}</small>` : \"\"}<span>${escapeHTML(match.player2Country || \"—\")} · ${match.player2Rank ? `世界 #${match.player2Rank}` : \"暂无排名\"}</span></div>\n      </div>\n    </div>\n    <div class=\"dialog-body\">\n      <div class=\"match-facts\">\n        ${fact(\"北京时间\", `${match.date} ${match.time || \"待定\"}`)}\n        ${fact(\"比赛场地\", match.court || \"待公布\")}\n        ${fact(\"场地类型\", match.surface || \"待公布\")}\n      </div>\n      <div class=\"stats-title\"><h3>比赛技术统计</h3><span>${stats ? \"球员 1 / 球员 2\" : \"\"}</span></div>\n      ${stats ? [\n        stat(\"ACE 球\", stats.aces), stat(\"双误\", stats.doubleFaults),\n        stat(\"一发成功率\", stats.firstServe, \"%\"), stat(\"破发成功\", stats.breakPoints)\n      ].join(\"\") : `<p class=\"no-stats\">${match.status === \"finished\" ? \"数据源暂未提供本场技术统计\" : \"比赛结束后，如数据源提供则在这里显示\"}</p>`}\n      ${sourceNote}\n    </div>`;\n  els.dialog.showModal();\n}\n\nconst fact = (label, value) => `<div class=\"fact\"><span>${label}</span><strong>${escapeHTML(value)}</strong></div>`;\nconst stat = (label, values = [\"—\", \"—\"], suffix = \"\") => `<div class=\"stat-row\"><strong>${values?.[0] ?? \"—\"}${suffix}</strong><label>${label}</label><strong>${values?.[1] ?? \"—\"}${suffix}</strong></div>`;\nconst playerDisplay = (name, nameZh) => prefersChinese && nameZh ? { primary: nameZh, secondary: name } : { primary: name, secondary: null };\n\nasync function loadHealth() {\n  try {\n    const response = await fetch(\"/api/health\");\n    if (!response.ok) return;\n    const data = await response.json();\n    if (data.lastSync) els.sync.textContent = `数据已同步 · ${formatSync(data.lastSync.finished_at)} · ${data.lastSync.source}`;\n  } catch { /* static preview */ }\n}\n\nfunction demoMatches() {\n  const today = localISODate(new Date());\n  const yesterday = localISODate(addDays(new Date(), -1));\n  const tomorrow = localISODate(addDays(new Date(), 1));\n  const common = { level: \"Grand Slam\", surface: \"硬地\", city: \"纽约\" };\n  return [\n    { id:\"d1\", date:today, time:\"00:30\", status:\"finished\", round:\"半决赛\", court:\"阿瑟·阿什球场\", tournament:\"美国网球公开赛 · 男单\", tour:\"ATP\", player1:\"扬尼克·辛纳\", player1Country:\"ITA\", player1Rank:1, player2:\"亚历山大·兹维列夫\", player2Country:\"GER\", player2Rank:3, winner:1, score:\"3–1\", setScores:[{p1:6,p2:4},{p1:3,p2:6},{p1:6,p2:3},{p1:6,p2:4}], stats:{aces:[12,9],doubleFaults:[3,5],firstServe:[68,62],breakPoints:[4,2]}, ...common },\n    { id:\"d2\", date:today, time:\"08:10\", status:\"scheduled\", round:\"半决赛\", court:\"阿瑟·阿什球场\", tournament:\"美国网球公开赛 · 男单\", tour:\"ATP\", player1:\"卡洛斯·阿尔卡拉斯\", player1Country:\"ESP\", player1Rank:2, player2:\"诺瓦克·德约科维奇\", player2Country:\"SRB\", player2Rank:7, winner:null, score:null, setScores:[], stats:null, ...common },\n    { id:\"d3\", date:today, time:\"03:00\", status:\"finished\", round:\"半决赛\", court:\"路易斯·阿姆斯特朗球场\", tournament:\"美国网球公开赛 · 女单\", tour:\"WTA\", player1:\"伊加·斯维亚特克\", player1Country:\"POL\", player1Rank:2, player2:\"杰西卡·佩古拉\", player2Country:\"USA\", player2Rank:4, winner:1, score:\"2–0\", setScores:[{p1:6,p2:3},{p1:7,p2:5}], stats:{aces:[5,2],doubleFaults:[2,4],firstServe:[71,64],breakPoints:[5,2]}, ...common },\n    { id:\"d4\", date:today, time:\"09:30\", status:\"scheduled\", round:\"半决赛\", court:\"阿瑟·阿什球场\", tournament:\"美国网球公开赛 · 女单\", tour:\"WTA\", player1:\"阿丽娜·萨巴伦卡\", player1Country:\"—\", player1Rank:1, player2:\"科科·高芙\", player2Country:\"USA\", player2Rank:3, winner:null, score:null, setScores:[], stats:null, ...common },\n    { id:\"d7\", date:today, time:\"11:20\", status:\"finished\", round:\"四分之一决赛\", court:\"中央球场\", tournament:\"亚洲网球公开赛 · 男单\", tour:\"ATP\", level:\"ATP 500\", surface:\"硬地\", city:\"东京\", player1:\"费利克斯·奥热-阿利亚西姆\", player1Country:\"CAN\", player1Rank:18, player2:\"亚历克斯·德米纳尔\", player2Country:\"AUS\", player2Rank:9, winner:2, score:\"1–2\", setScores:[{p1:6,p2:4},{p1:5,p2:7},{p1:3,p2:6}], stats:{aces:[11,7],doubleFaults:[6,2],firstServe:[59,67],breakPoints:[2,4]} },\n    { id:\"d8\", date:today, time:\"13:45\", status:\"scheduled\", round:\"第二轮\", court:\"2号球场\", tournament:\"亚洲网球公开赛 · 男单\", tour:\"ATP\", level:\"ATP 500\", surface:\"硬地\", city:\"东京\", player1:\"张之臻\", player1Country:\"CHN\", player1Rank:47, player2:\"本·谢尔顿\", player2Country:\"USA\", player2Rank:12, winner:null, score:null, setScores:[], stats:null },\n    { id:\"d9\", date:today, time:\"16:00\", status:\"finished\", round:\"第二轮\", court:\"钻石球场\", tournament:\"中国女子网球公开赛\", tour:\"WTA\", level:\"WTA 1000\", surface:\"硬地\", city:\"北京\", player1:\"郑钦文\", player1Country:\"CHN\", player1Rank:6, player2:\"巴博拉·克雷吉茨科娃\", player2Country:\"CZE\", player2Rank:15, winner:1, score:\"2–1\", setScores:[{p1:4,p2:6},{p1:7,p2:5},{p1:6,p2:2}], stats:null },\n    { id:\"d10\", date:today, time:\"19:30\", status:\"scheduled\", round:\"第二轮\", court:\"莲花球场\", tournament:\"中国女子网球公开赛\", tour:\"WTA\", level:\"WTA 1000\", surface:\"硬地\", city:\"北京\", player1:\"米拉·安德列娃\", player1Country:\"—\", player1Rank:8, player2:\"艾玛·拉杜卡努\", player2Country:\"GBR\", player2Rank:31, winner:null, score:null, setScores:[], stats:null },\n    { id:\"d5\", date:yesterday, time:\"14:00\", status:\"finished\", round:\"四分之一决赛\", court:\"17号球场\", tournament:\"美国网球公开赛 · 男单\", tour:\"ATP\", player1:\"示例球员 A\", player1Country:\"CHN\", player1Rank:86, player2:\"示例球员 B\", player2Country:\"JPN\", player2Rank:112, winner:1, score:\"3–2\", setScores:[{p1:6,p2:4},{p1:3,p2:6},{p1:7,p2:5},{p1:4,p2:6},{p1:6,p2:2}], stats:null, ...common },\n    { id:\"d6\", date:tomorrow, time:\"04:00\", status:\"scheduled\", round:\"决赛\", court:\"阿瑟·阿什球场\", tournament:\"美国网球公开赛 · 男单\", tour:\"ATP\", player1:\"待定球员 1\", player1Country:\"—\", player1Rank:null, player2:\"待定球员 2\", player2Country:\"—\", player2Rank:null, winner:null, score:null, setScores:[], stats:null, ...common },\n    { id:\"d11\", date:tomorrow, time:\"14:30\", status:\"scheduled\", round:\"第三轮\", court:\"中央球场\", tournament:\"亚洲网球公开赛 · 男单\", tour:\"ATP\", level:\"ATP 500\", surface:\"硬地\", city:\"东京\", player1:\"待定球员 3\", player1Country:\"—\", player1Rank:null, player2:\"待定球员 4\", player2Country:\"—\", player2Rank:null, winner:null, score:null, setScores:[], stats:null }\n  ];\n}\n\nfunction groupBy(items, getKey) { const result = new Map(); for (const item of items) { const key = getKey(item); result.set(key, [...(result.get(key) || []), item]); } return result; }\nfunction addDays(value, days) { const date = new Date(value); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + days); return date; }\nfunction parseDate(iso) { const [y,m,d] = iso.split(\"-\").map(Number); return new Date(y, m - 1, d, 12); }\nfunction localISODate(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,\"0\")}-${String(date.getDate()).padStart(2,\"0\")}`; }\nfunction dayDiff(a, b) { const x = new Date(a.getFullYear(),a.getMonth(),a.getDate()); const y = new Date(b.getFullYear(),b.getMonth(),b.getDate()); return Math.round((x-y)/86400000); }\nfunction weekday(date, length) { return new Intl.DateTimeFormat(\"zh-CN\", { weekday: length }).format(date); }\nfunction formatSync(value) { try { return new Intl.DateTimeFormat(\"zh-CN\", {month:\"numeric\",day:\"numeric\",hour:\"2-digit\",minute:\"2-digit\",hour12:false,timeZone:\"Asia/Shanghai\"}).format(new Date(value)); } catch { return value; } }\nfunction escapeHTML(value = \"\") { return String(value).replace(/[&<>'\"]/g, (char) => ({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",\"'\":\"&#39;\",'\"':\"&quot;\"}[char])); }\n"}};
function serveEmbeddedAsset(request) {
  const path = new URL(request.url).pathname;
  const asset = EMBEDDED_ASSETS[path] || EMBEDDED_ASSETS["/"];
  return new Response(request.method === "HEAD" ? null : asset.body, { headers: { "content-type": asset.type, "cache-control": path === "/" || path.endsWith(".html") ? "no-cache" : "public, max-age=3600" } });
}
