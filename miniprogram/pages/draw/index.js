const api = require("../../utils/api");
const { normalizeMatch } = require("../../utils/match");

const ROUND_NAMES = [
  [/qual/i, "资格赛"],
  [/(round of 128|round 1|1st round|first round|r128)/i, "第一轮"],
  [/(round of 64|round 2|2nd round|second round|r64)/i, "第二轮"],
  [/(round of 32|round 3|3rd round|third round|r32)/i, "第三轮"],
  [/(round of 16|round 4|4th round|fourth round|r16)/i, "第四轮"],
  [/(quarter|qf)/i, "四分之一决赛"],
  [/(semi|sf)/i, "半决赛"],
  [/(^|\s)(final|f)($|\s)/i, "决赛"]
];

function roundLabel(value) {
  const raw = String(value || "轮次待定");
  const match = ROUND_NAMES.find(([pattern]) => pattern.test(raw));
  return match ? match[1] : raw;
}

function roundWeight(value) {
  const label = roundLabel(value);
  const weights = {
    "资格赛": 0, "第一轮": 10, "第二轮": 20, "第三轮": 30, "第四轮": 40,
    "四分之一决赛": 50, "半决赛": 60, "决赛": 70, "轮次待定": 80
  };
  return weights[label] ?? 45;
}

function playerRows(match) {
  return [
    {
      id: match.player1Id,
      primary: match.player1Primary,
      secondary: match.player1Secondary,
      country: match.player1Country || "—",
      rank: match.player1Rank ? `#${match.player1Rank}` : "",
      winner: match.winner === 1,
      scores: match.setScores.map((set) => set.p1)
    },
    {
      id: match.player2Id,
      primary: match.player2Primary,
      secondary: match.player2Secondary,
      country: match.player2Country || "—",
      rank: match.player2Rank ? `#${match.player2Rank}` : "",
      winner: match.winner === 2,
      scores: match.setScores.map((set) => set.p2)
    }
  ];
}

Page({
  data: {
    tournament: null,
    rounds: [],
    activeRoundIndex: 0,
    activeRoundAnchor: "round-0",
    visibleMatches: [],
    focusMatchId: "",
    loading: true,
    error: ""
  },

  onLoad(options) {
    this.tournamentId = decodeURIComponent(options.tournamentId || "");
    this.focusMatchId = decodeURIComponent(options.matchId || "");
    if (!this.tournamentId) {
      this.setData({ loading: false, error: "赛事信息已失效" });
      return;
    }
    this.loadDraw();
  },

  onPullDownRefresh() {
    this.loadDraw().finally(() => wx.stopPullDownRefresh());
  },

  async loadDraw() {
    this.setData({ loading: true, error: "" });
    try {
      const payload = await api.getDraw(this.tournamentId);
      const matches = (Array.isArray(payload.matches) ? payload.matches : []).map((raw) => {
        const match = normalizeMatch(raw);
        return {
          ...match,
          isFocus: match.id === this.focusMatchId,
          players: playerRows(match)
        };
      });
      const roundMap = new Map();
      matches.forEach((match) => {
        const key = match.round || "轮次待定";
        if (!roundMap.has(key)) roundMap.set(key, []);
        roundMap.get(key).push(match);
      });
      const rounds = [...roundMap.entries()]
        .map(([raw, items], index) => ({ raw, label: roundLabel(raw), matches: items, id: `round-${index}` }))
        .sort((left, right) => roundWeight(left.raw) - roundWeight(right.raw))
        .map((round, index) => ({ ...round, id: `round-${index}`, count: round.matches.length }));
      let activeRoundIndex = rounds.findIndex((round) => round.matches.some((match) => match.isFocus));
      if (activeRoundIndex < 0) {
        activeRoundIndex = rounds.findIndex((round) => round.matches.some((match) => match.status === "in_progress"));
      }
      if (activeRoundIndex < 0) activeRoundIndex = Math.max(0, rounds.length - 1);
      const tournament = payload.tournament || {};
      wx.setNavigationBarTitle({ title: roundLabel(tournament.name || "赛事签表") });
      this.setData({
        tournament,
        rounds,
        activeRoundIndex,
        activeRoundAnchor: `round-${activeRoundIndex}`,
        visibleMatches: rounds[activeRoundIndex]?.matches || [],
        focusMatchId: this.focusMatchId,
        loading: false
      });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "签表暂时无法加载" });
    }
  },

  selectRound(event) {
    const index = Number(event.currentTarget.dataset.index);
    const round = this.data.rounds[index];
    if (!round || index === this.data.activeRoundIndex) return;
    this.setData({ activeRoundIndex: index, visibleMatches: round.matches });
  },

  retry() {
    this.loadDraw();
  },

  openOfficialDraw() {
    const drawUrl = this.data.tournament && this.data.tournament.drawUrl;
    if (!drawUrl) return;
    wx.setClipboardData({
      data: drawUrl,
      success: () => wx.showModal({
        title: "官方签表地址已复制",
        content: "请在浏览器中打开。小程序内展示以已采集的比赛数据为准。",
        showCancel: false,
        confirmText: "知道了"
      })
    });
  },

  onShareAppMessage() {
    const tournament = this.data.tournament;
    return {
      title: tournament ? `${tournament.name}签表 · 球序` : "网球赛事签表 · 球序",
      path: "/pages/timeline/index"
    };
  }
});
