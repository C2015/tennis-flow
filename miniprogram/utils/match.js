const STATUS_TEXT = {
  scheduled: "待开赛",
  in_progress: "进行中",
  finished: "已完赛",
  cancelled: "已取消",
  postponed: "已延期"
};

function displayPlayer(name, nameZh) {
  return {
    primary: nameZh || name || "待定",
    secondary: nameZh && nameZh !== name ? name : ""
  };
}

function normalizeMatch(match) {
  const player1 = displayPlayer(match.player1, match.player1Zh);
  const player2 = displayPlayer(match.player2, match.player2Zh);
  const rawSetScores = Array.isArray(match.setScores) ? match.setScores : [];
  const hasScore = rawSetScores.some((set) => Number(set.p1) > 0 || Number(set.p2) > 0) || String(match.score || "").trim();
  const status = match.status === "scheduled" && hasScore ? "in_progress" : match.status;
  const location = [match.city, match.country].filter(Boolean).join(" · ");
  return {
    ...match,
    status,
    player1Primary: player1.primary,
    player1Secondary: player1.secondary,
    player2Primary: player2.primary,
    player2Secondary: player2.secondary,
    player1RankText: match.player1Rank ? `#${match.player1Rank}` : "—",
    player2RankText: match.player2Rank ? `#${match.player2Rank}` : "—",
    statusText: STATUS_TEXT[status] || "赛程",
    timeText: match.time || "待定",
    roundText: match.round || "轮次待定",
    courtText: match.court || location || "场地待公布",
    hasExactCourt: Boolean(match.court),
    setScores: rawSetScores.map((set, index) => ({
      ...set,
      setIndex: index,
      p1Won: Number(set.p1) > Number(set.p2),
      p2Won: Number(set.p2) > Number(set.p1)
    }))
  };
}

function groupMatches(matches) {
  const groups = [];
  const indexes = new Map();
  matches.forEach((raw) => {
    const match = normalizeMatch(raw);
    const key = match.tournament || "其他赛事";
    if (!indexes.has(key)) {
      indexes.set(key, groups.length);
      groups.push({
        id: `group-${groups.length}`,
        name: key,
        tour: match.tour,
        level: match.level,
        meta: [match.surface, match.city].filter(Boolean).join(" · "),
        matches: []
      });
    }
    groups[indexes.get(key)].matches.push(match);
  });
  return groups;
}

module.exports = { STATUS_TEXT, displayPlayer, groupMatches, normalizeMatch };
