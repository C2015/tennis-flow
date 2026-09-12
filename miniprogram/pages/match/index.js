const { normalizeMatch } = require("../../utils/match");
const api = require("../../utils/api");

Page({
  data: {
    match: null,
    facts: [],
    stats: [],
    statsSource: "",
    broadcasts: []
  },

  onLoad() {
    const stored = wx.getStorageSync("tennis-flow:selected-match");
    if (!stored || !stored.id) {
      wx.showToast({ title: "比赛信息已失效", icon: "none" });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.applyMatch(stored);
  },

  onPullDownRefresh() {
    this.refreshMatch().finally(() => wx.stopPullDownRefresh());
  },

  applyMatch(rawMatch) {
    const match = normalizeMatch(rawMatch);
    this.setData({
      match,
      broadcasts: Array.isArray(match.broadcasts) ? match.broadcasts : [],
      facts: [
        { label: "北京时间", value: `${match.date} ${match.time || "待定"}` },
        { label: "比赛场地", value: match.courtText },
        { label: "场地类型", value: match.surface || "待公布" },
        { label: "赛制", value: match.bestOf ? `${match.bestOf} 盘制` : "待公布" }
      ],
      stats: this.buildStats(match.stats),
      statsSource: match.stats && match.stats.source ? match.stats.source : ""
    });
    wx.setStorageSync("tennis-flow:selected-match", rawMatch);
  },

  async refreshMatch() {
    const current = this.data.match;
    if (!current || !current.id || !current.date) return;
    try {
      const payload = await api.getMatches({ date: current.date, tour: "all" });
      const matches = Array.isArray(payload.matches) ? payload.matches : [];
      const latest = matches.find((match) => match.id === current.id);
      if (!latest) throw new Error("暂未找到这场比赛的最新数据");
      this.applyMatch(latest);
      wx.showToast({ title: "比赛数据已刷新", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error.message || "刷新失败，请稍后重试", icon: "none" });
    }
  },

  openBroadcast(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.broadcasts && this.data.broadcasts[index];
    if (!item) return;
    if (item.accessMode === "mini_program" && item.miniProgramAppId) {
      const options = {
        appId: item.miniProgramAppId,
        envVersion: "release",
        fail: () => this.handleMiniProgramFailure(item)
      };
      if (item.miniProgramPath) options.path = item.miniProgramPath;
      wx.navigateToMiniProgram(options);
      return;
    }
    this.copyBroadcast(item);
  },

  handleMiniProgramFailure(item) {
    if (item.watchUrl) {
      this.copyBroadcast(item, true);
      return;
    }
    wx.showToast({ title: "平台小程序暂时无法打开", icon: "none" });
  },

  copyBroadcast(item, fromMiniProgram = false) {
    if (!item.watchUrl) {
      wx.showToast({ title: "暂无可用入口", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: item.watchUrl,
      success: () => wx.showModal({
        title: `前往${item.platformName}`,
        content: fromMiniProgram
          ? "平台小程序暂时无法打开，官方网站地址已复制，请在浏览器中打开。"
          : "官方网站地址已复制，请在浏览器中打开。具体场次以平台节目单为准。",
        showCancel: false,
        confirmText: "知道了"
      })
    });
  },

  openDraw() {
    const match = this.data.match;
    if (!match || !match.tournamentId) {
      wx.showToast({ title: "本场签表暂不可用", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/draw/index?tournamentId=${encodeURIComponent(match.tournamentId)}&matchId=${encodeURIComponent(match.id)}`
    });
  },

  buildStats(stats) {
    if (!stats) return [];
    const rows = [
      ["ACE 球", stats.aces],
      ["双误", stats.doubleFaults],
      ["一发成功率", stats.firstServe, "%"],
      ["一发得分率", stats.firstServePointsWon, "%"],
      ["二发得分率", stats.secondServePointsWon, "%"],
      ["破发成功", stats.breakPoints],
      ["网前得分", stats.netPoints],
      ["制胜分", stats.winners],
      ["非受迫性失误", stats.unforcedErrors],
      ["总得分", stats.totalPointsWon],
      ["最快发球", stats.fastestServe]
    ];
    return rows.filter((row) => Array.isArray(row[1]) && row[1].some((value) => value != null)).map(([label, values, suffix = ""]) => ({
      label,
      left: `${values[0] ?? "—"}${values[0] == null ? "" : suffix}`,
      right: `${values[1] ?? "—"}${values[1] == null ? "" : suffix}`
    }));
  },

  copyStatsSource() {
    const stats = this.data.match && this.data.match.stats;
    if (!stats || !stats.sourceUrl) return;
    wx.setClipboardData({ data: stats.sourceUrl, success: () => wx.showToast({ title: "官方统计链接已复制" }) });
  },

  copySource() {
    const url = this.data.match && this.data.match.sourceUrl;
    if (!url) return;
    wx.setClipboardData({ data: url, success: () => wx.showToast({ title: "来源链接已复制" }) });
  },

  onShareAppMessage() {
    const match = this.data.match;
    return {
      title: match ? `${match.player1Primary} vs ${match.player2Primary} · 球序` : "球序 · 网球赛程",
      path: "/pages/timeline/index"
    };
  }
});
