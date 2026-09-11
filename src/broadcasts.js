const OFFICIAL_HOSTS = Object.freeze({
  cctv: ["cctv.com"],
  migu: ["miguvideo.com"],
  tencent: ["qq.com"],
  youku: ["youku.com"]
});

const MAJOR_BROADCAST_LEVELS = new Set([
  "grand slam",
  "atp 1000",
  "wta 1000",
  "atp finals",
  "wta finals"
]);

export function isMajorBroadcastEvent(match) {
  return MAJOR_BROADCAST_LEVELS.has(String(match?.level || "").trim().toLowerCase());
}

export function safeBroadcastUrl(platform, value) {
  try {
    const url = new URL(value);
    const allowed = OFFICIAL_HOSTS[platform] || [];
    const trusted = allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    return url.protocol === "https:" && trusted ? url.toString() : null;
  } catch {
    return null;
  }
}

export function safeMiniProgramTarget(appIdValue, pathValue) {
  const appId = String(appIdValue || "").trim();
  if (!/^wx[0-9a-f]{16}$/i.test(appId)) return null;

  const rawPath = String(pathValue || "").trim();
  if (!rawPath) return { appId, path: null };
  const path = rawPath.replace(/^\/+/, "");
  if (!path || path.length > 1024 || /[\\\u0000-\u001f]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return { appId, path: null };
  }
  return { appId, path };
}

export function ruleMatchesMatch(rule, match) {
  if (!Number(rule.active)) return false;
  if (rule.startsOn && match.date < rule.startsOn) return false;
  if (rule.endsOn && match.date > rule.endsOn) return false;
  if (rule.tour && rule.tour !== match.tour) return false;
  if (rule.level && rule.level !== match.level) return false;
  if (rule.excludeLevel && rule.excludeLevel === match.level) return false;

  const tournament = String(match.tournament || "").toLowerCase();
  const country = String(match.country || "").toLowerCase();
  const patterns = splitPatterns(rule.tournamentPatterns);
  const excludedCountries = splitPatterns(rule.excludeCountry);
  if (patterns.length && !patterns.some((pattern) => tournament.includes(pattern))) return false;
  if (excludedCountries.some((pattern) => country.includes(pattern))) return false;
  return Boolean(safeBroadcastUrl(rule.platform, rule.watchUrl) || safeMiniProgramTarget(rule.miniProgramAppId, rule.miniProgramPath));
}

export function broadcastsForMatch(match, rules = [], exactRows = []) {
  if (["finished", "cancelled"].includes(match.status) || !isMajorBroadcastEvent(match)) return [];
  // Rights announcements identify possible platforms, but do not prove that a
  // particular court or match is being streamed. Only match-specific records
  // are safe enough to expose as actionable viewing links.
  const candidates = exactRows
    .filter((row) => row.matchId === match.id && Number(row.active ?? 1))
    .map((row) => ({ ...row, exact: true }))
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0));

  const seen = new Set();
  return candidates.flatMap((item) => {
    if (seen.has(item.platform)) return [];
    const watchUrl = safeBroadcastUrl(item.platform, item.watchUrl);
    const miniProgram = safeMiniProgramTarget(item.miniProgramAppId, item.miniProgramPath);
    if (!watchUrl && !miniProgram) return [];
    seen.add(item.platform);
    const confidence = item.exact ? "confirmed" : item.coverage === "all_matches" ? "confirmed" : "event";
    const accessMode = miniProgram ? "mini_program" : "web";
    return [{
      platform: item.platform,
      platformName: item.platformName,
      watchUrl,
      miniProgramAppId: miniProgram?.appId || null,
      miniProgramPath: miniProgram?.path || null,
      accessMode,
      canDirectOpen: accessMode === "mini_program",
      confidence,
      label: accessMode === "mini_program" ? `打开${item.platformName}小程序` : `复制${item.platformName}官方入口`,
      hint: accessMode === "mini_program"
        ? `${miniProgram.path ? "直达相关页面" : "进入平台首页"} · 内容由第三方提供`
        : `${confidence === "confirmed" ? "官方网页入口" : "具体场次以节目单为准"} · 复制后浏览器打开`,
      isFree: item.isFree == null ? null : Boolean(item.isFree),
      verifiedAt: item.verifiedAt || null,
      sourceUrl: safeSourceUrl(item.sourceUrl)
    }];
  });
}

function splitPatterns(value) {
  return String(value || "").toLowerCase().split("|").map((item) => item.trim()).filter(Boolean);
}

function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
