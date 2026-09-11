import fs from "node:fs";
import vm from "node:vm";

const required = [
  "public/index.html", "public/styles.css", "public/app.js", "src/worker.js", "db/schema.sql", ".github/workflows/sync.yml",
  "project.config.json", "miniprogram/app.json", "miniprogram/app.js", "miniprogram/app.wxss",
  "miniprogram/pages/timeline/index.js", "miniprogram/pages/timeline/index.wxml", "miniprogram/pages/timeline/index.wxss",
  "miniprogram/pages/match/index.js", "miniprogram/pages/match/index.wxml", "miniprogram/pages/match/index.wxss",
  "miniprogram/pages/draw/index.js", "miniprogram/pages/draw/index.wxml", "miniprogram/pages/draw/index.wxss"
];
for (const file of required) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`Missing or empty: ${file}`);
}
const worker = await import(new URL("../src/worker.js", import.meta.url));
if (typeof worker.default?.fetch !== "function") throw new Error("Worker fetch handler missing");
if (typeof worker.default?.scheduled !== "function") throw new Error("Worker scheduled handler missing");
const adaptive = await import(new URL("../src/adaptive.js", import.meta.url));
const broadcasts = await import(new URL("../src/broadcasts.js", import.meta.url));
const stats = await import(new URL("../src/stats.js", import.meta.url));
if (adaptive.SCOREBOARD_HEADERS["user-agent"] !== "curl/8.7.1") throw new Error("ESPN-compatible user agent missing");
if (adaptive.pollingIntervalMinutes("Grand Slam", "US Open") !== 10) throw new Error("Major interval mismatch");
if (adaptive.pollingIntervalMinutes("WTA 500", "Test") !== 30) throw new Error("500 interval mismatch");
if (adaptive.pollingIntervalMinutes("Tour", "Test") !== 60) throw new Error("Tour interval mismatch");
if (adaptive.scoreboardUpdateStatus({ state: "in", description: "In Progress" }) !== "scheduled") throw new Error("Live scoreboard update status mismatch");
if (adaptive.matchDisplayStatus("scheduled", [{ p1: 1, p2: 2 }], "1-2") !== "in_progress") throw new Error("Live display status mismatch");
const nowMs = Date.parse("2026-09-09T15:40:00Z");
const escalation = adaptive.adaptiveDueReason(
  { interval: 10 },
  { last_checked_at: "2026-09-09T15:20:00Z", next_check_at: "2026-09-09T16:20:00Z" },
  nowMs
);
if (escalation !== "priority_escalation") throw new Error("Adaptive priority escalation failed");
const broadcastResult = broadcasts.broadcastsForMatch(
  { id: "match-1", date: "2026-09-10", status: "in_progress", tournament: "US Open · 男单", tour: "ATP", level: "Grand Slam", country: "USA" },
  [{ active: 1, platform: "migu", platformName: "咪咕视频", tournamentPatterns: "us open|美国网球公开赛", startsOn: "2026-08-23", endsOn: "2026-09-13", coverage: "event", watchUrl: "https://www.miguvideo.com/", sourceUrl: "https://www.usopen.org/", priority: 10 }],
  []
);
if (broadcastResult.length !== 0) throw new Error("Event-level rights must not create match broadcast buttons");
if (broadcasts.safeBroadcastUrl("migu", "https://example.com/watch")) throw new Error("Broadcast host allowlist failed");
const directBroadcastResult = broadcasts.broadcastsForMatch(
  { id: "match-2", date: "2026-09-10", status: "in_progress", tournament: "Test Masters", tour: "ATP", level: "ATP 1000", country: "USA" },
  [],
  [{ active: 1, matchId: "match-2", platform: "youku", platformName: "优酷体育", watchUrl: "https://sports.youku.com/", miniProgramAppId: "wx0123456789abcdef", miniProgramPath: "/pages/live/index?id=1", sourceUrl: "https://sports.youku.com/" }]
);
if (directBroadcastResult[0]?.accessMode !== "mini_program" || directBroadcastResult[0]?.miniProgramPath !== "pages/live/index?id=1" || !directBroadcastResult[0]?.canDirectOpen) {
  throw new Error("Mini Program broadcast target normalization failed");
}
if (broadcasts.safeMiniProgramTarget("not-an-app-id", "pages/live/index")) throw new Error("Mini Program AppID validation failed");
const officialStats = stats.usOpenStats({
  match_id: "1504",
  team1: { firstNameA: "Ben", lastNameA: "Shelton" },
  team2: { firstNameA: "Carlos", lastNameA: "Alcaraz" },
  base_stats: { match: {
    team_1: { t_ace: 7, df: 2, f_srv_pct: 66, w_pct_f_srv: 70, w_pct_s_srv: 57, t_bp_w: 5, t_bp: 16, t_np_w: 29, t_na: 41, t_w: 34, t_ue: 35, t_f_srv_w: 73, t_s_srv_w: 30, t_p_w_opp_srv: 66 },
    team_2: { t_ace: 3, df: 7, f_srv_pct: 64, w_pct_f_srv: 69, w_pct_s_srv: 51, t_bp_w: 3, t_bp: 11, t_np_w: 27, t_na: 35, t_w: 38, t_ue: 53, t_f_srv_w: 77, t_s_srv_w: 32, t_p_w_opp_srv: 55 }
  } },
  serve_stats: { match: { team_1: { t_f_spd: ["240 KMH", "149 MPH"] }, team_2: { t_f_spd: ["208 KMH", "129 MPH"] } } }
}, ["Carlos Alcaraz", "Ben Shelton"]);
if (officialStats?.aces?.join(",") !== "3,7" || officialStats.breakPoints?.[1] !== "5/16" || officialStats.totalPointsWon?.[0] !== 164) {
  throw new Error("US Open technical statistics normalization failed");
}
if (stats.usOpenTournamentDay("2026-09-08") !== 17 || stats.usOpenTournamentDay("2025-08-24") !== 8) {
  throw new Error("US Open tournament day calculation failed");
}
const nonMajorBroadcastResult = broadcasts.broadcastsForMatch(
  { id: "match-3", date: "2026-09-10", status: "in_progress", tournament: "Test Open", tour: "ATP", level: "ATP 500", country: "USA" },
  [],
  [{ active: 1, matchId: "match-3", platform: "youku", platformName: "优酷体育", watchUrl: "https://sports.youku.com/", sourceUrl: "https://sports.youku.com/" }]
);
if (nonMajorBroadcastResult.length !== 0) throw new Error("Non-major events must not expose broadcast buttons");
JSON.parse(fs.readFileSync("data/sample-feed.json", "utf8"));
const project = JSON.parse(fs.readFileSync("project.config.json", "utf8"));
if (project.appid !== "wxf575cca5dce6ff34") throw new Error("Mini Program AppID mismatch");
for (const file of ["miniprogram/app.json", "miniprogram/sitemap.json", "miniprogram/pages/timeline/index.json", "miniprogram/pages/match/index.json", "miniprogram/pages/draw/index.json"]) {
  JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadMiniProgramModule(file) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { module, exports: module.exports, Date, Map, Array, Number, String });
  return module.exports;
}

const dateUtils = loadMiniProgramModule("miniprogram/utils/date.js");
if (dateUtils.addDays("2026-12-31", 1) !== "2027-01-01") throw new Error("Mini Program date navigation failed");
const matchUtils = loadMiniProgramModule("miniprogram/utils/match.js");
const groups = matchUtils.groupMatches([
  { id: "1", tournament: "Test Open", status: "scheduled", player1: "A", player1Zh: "甲", player2: "B", setScores: [{ p1: 6, p2: 4 }] }
]);
if (groups.length !== 1 || groups[0].matches[0].player1Primary !== "甲" || !groups[0].matches[0].setScores[0].p1Won || groups[0].matches[0].status !== "in_progress") {
  throw new Error("Mini Program match normalization failed");
}
console.log(`OK: ${required.length} project files and feed schema are present.`);
