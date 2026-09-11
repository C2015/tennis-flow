const US_OPEN_HOST = "https://www.usopen.org";

export function normalizePlayerName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function playerPairKey(names) {
  return names.map(normalizePlayerName).filter(Boolean).sort().join("|");
}

export function usOpenPlayerName(team = {}) {
  return [team.firstNameA, team.lastNameA].filter(Boolean).join(" ").trim();
}

export function usOpenStats(match, requestedNames = []) {
  const base = match?.base_stats?.match;
  if (!base?.team_1 || !base?.team_2) return null;

  const officialNames = [usOpenPlayerName(match.team1), usOpenPlayerName(match.team2)];
  const requested = requestedNames.map(normalizePlayerName);
  const official = officialNames.map(normalizePlayerName);
  const order = requested.length === 2
    ? requested.map((name) => official.indexOf(name))
    : [0, 1];
  if (order.some((index) => index < 0) || new Set(order).size !== 2) return null;

  const teams = order.map((index) => base[`team_${index + 1}`]);
  const serve = order.map((index) => match?.serve_stats?.match?.[`team_${index + 1}`] || {});
  const pair = (reader) => teams.map((team, index) => reader(team, serve[index]));
  const ratio = (won, total) => Number.isFinite(Number(won)) && Number.isFinite(Number(total))
    ? `${Number(won)}/${Number(total)}`
    : null;
  const fastestServe = (_team, serveTeam) => {
    const value = Array.isArray(serveTeam?.t_f_spd) ? serveTeam.t_f_spd[0] : null;
    const match = String(value || "").match(/\d+/);
    return match ? `${match[0]} km/h` : null;
  };
  const totalPoints = (team) => {
    const values = [team.t_f_srv_w, team.t_s_srv_w, team.t_p_w_opp_srv].map(Number);
    return values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) : null;
  };

  return {
    source: "US Open 官方数据",
    sourceUrl: `${US_OPEN_HOST}/en_US/scores/stats/${match.match_id}.html`,
    aces: pair((team) => team.t_ace),
    doubleFaults: pair((team) => team.df),
    firstServe: pair((team) => team.f_srv_pct),
    firstServePointsWon: pair((team) => team.w_pct_f_srv),
    secondServePointsWon: pair((team) => team.w_pct_s_srv),
    breakPoints: pair((team) => ratio(team.t_bp_w, team.t_bp)),
    netPoints: pair((team) => ratio(team.t_np_w, team.t_na)),
    winners: pair((team) => team.t_w),
    unforcedErrors: pair((team) => team.t_ue),
    totalPointsWon: pair(totalPoints),
    fastestServe: pair(fastestServe)
  };
}

export async function fetchUsOpenLiveStats(year, fetcher = fetch) {
  const url = `${US_OPEN_HOST}/en_US/scores/feeds/${year}/matches/live/scores.json`;
  const response = await fetcher(url, {
    headers: { accept: "application/json", "user-agent": "TennisFlow/0.4" },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`US Open stats returned ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 5_000_000) throw new Error("US Open stats response exceeded 5MB");
  const payload = await response.json();
  const result = new Map();
  for (const match of Array.isArray(payload?.matches) ? payload.matches : []) {
    const names = [usOpenPlayerName(match.team1), usOpenPlayerName(match.team2)];
    const stats = usOpenStats(match, names);
    if (stats) result.set(playerPairKey(names), { match, stats });
  }
  return result;
}
