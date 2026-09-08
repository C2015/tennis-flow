const { normalizeMatch } = require("../../utils/match");

Page({
  data: {
    match: null,
    facts: [],
    stats: []
  },

  onLoad() {
    const stored = wx.getStorageSync("tennis-flow:selected-match");
    if (!stored || !stored.id) {
      wx.showToast({ title: "比赛信息已失效", icon: "none" });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    const match = normalizeMatch(stored);
    this.setData({
      match,
      facts: [
        { label: "北京时间", value: `${match.date} ${match.time || "待定"}` },
        { label: "比赛场地", value: match.court || "待公布" },
        { label: "场地类型", value: match.surface || "待公布" },
        { label: "赛制", value: match.bestOf ? `${match.bestOf} 盘制` : "待公布" }
      ],
      stats: this.buildStats(match.stats)
    });
  },

  buildStats(stats) {
    if (!stats) return [];
    const rows = [
      ["ACE 球", stats.aces],
      ["双误", stats.doubleFaults],
      ["一发成功率", stats.firstServe, "%"],
      ["破发成功", stats.breakPoints]
    ];
    return rows.filter((row) => Array.isArray(row[1])).map(([label, values, suffix = ""]) => ({
      label,
      left: `${values[0] ?? "—"}${values[0] == null ? "" : suffix}`,
      right: `${values[1] ?? "—"}${values[1] == null ? "" : suffix}`
    }));
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
