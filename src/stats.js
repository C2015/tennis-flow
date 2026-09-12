export const US_OPEN_HOST = "https://www.usopen.org";

export function normalizePlayerName(value) {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized.split(/\s+/).filter(Boolean).sort().join(" ");
}

export function playerPairKey(names) {
  return names.map(normalizePlayerName).filter(Boolean).sort().join("|");
}

export function usOpenPlayerName(team = {}) {
  return [team.firstNameA, team.lastNameA].filter(Boolean).join(" ").trim();
}

export function usOpenTournamentDay(dateValue) {
  const match = String(dateValue || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const septemberFirst = new Date(Date.UTC(year, 8, 1));
  const daysToMonday = (8 - septemberFirst.getUTCDay()) % 7;
  const laborDay = new Date(septemberFirst.getTime() + daysToMonday * 86_400_000);
  const fanWeekStart = new Date(laborDay.getTime() - 15 * 86_400_000);
  const target = new Date(Date.UTC(year, month - 1, day));
  const tournamentDay = Math.round((target.getTime() - fanWeekStart.getTime()) / 86_400_000) + 1;
  return tournamentDay >= 1 && tournamentDay <= 22 ? tournamentDay : null;
}

export async function fetchUsOpenJson(url, fetcher = fetch) {
  const response = await fetcher(url, {
    headers: { accept: "application/json", "user-agent": "TennisFlow/0.4" },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`US Open stats returned ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 5_000_000) throw new Error("US Open stats response exceeded 5MB");
  return response.json();
}

export function usOpenStats(match, requestedNames = [], { phase = "live" } = {}) {
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
    phase,
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

export function isCompleteUsOpenStats(stats) {
  if (!stats || stats.phase !== "final") return false;
  const totals = Array.isArray(stats.totalPointsWon) ? stats.totalPointsWon.map(Number) : [];
  const firstServe = Array.isArray(stats.firstServe) ? stats.firstServe.map(Number) : [];
  return totals.length === 2
    && totals.every((value) => Number.isFinite(value) && value > 0)
    && totals[0] + totals[1] >= 24
    && firstServe.length === 2
    && firstServe.every((value) => Number.isFinite(value) && value > 0 && value <= 100);
}

export async function fetchUsOpenCompleteStats(year, matchId, requestedNames, fetcher = fetch) {
  if (!matchId) return null;
  const url = `${US_OPEN_HOST}/en_US/scores/feeds/${year}/matches/complete/${matchId}.json`;
  const payload = await fetchUsOpenJson(url, fetcher);
  const match = Array.isArray(payload?.matches) ? payload.matches[0] : null;
  const stats = match ? usOpenStats(match, requestedNames, { phase: "final" }) : null;
  return isCompleteUsOpenStats(stats) ? stats : null;
}

export async function fetchUsOpenLiveStats(year, fetcher = fetch) {
  const url = `${US_OPEN_HOST}/en_US/scores/feeds/${year}/matches/live/scores.json`;
  const payload = await fetchUsOpenJson(url, fetcher);
  const result = new Map();
  for (const match of Array.isArray(payload?.matches) ? payload.matches : []) {
    const names = [usOpenPlayerName(match.team1), usOpenPlayerName(match.team2)];
    const stats = usOpenStats(match, names, { phase: "live" });
    if (stats) result.set(playerPairKey(names), { match, stats });
  }
  return result;
}
