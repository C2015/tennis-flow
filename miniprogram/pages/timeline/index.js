const api = require("../../utils/api");
const dates = require("../../utils/date");
const { groupMatches } = require("../../utils/match");

Page({
  data: {
    selectedDate: "",
    selectedMeta: {},
    anchorDate: "",
    dateStrip: [],
    filters: [
      { value: "all", label: "全部" },
      { value: "slam", label: "大满贯" },
      { value: "ATP", label: "ATP" },
      { value: "WTA", label: "WTA" }
    ],
    currentTour: "all",
    query: "",
    groups: [],
    matchCount: 0,
    loading: true,
    error: "",
    syncText: "正在检查数据状态"
  },

  onLoad() {
    const today = dates.beijingToday();
    const anchor = dates.addDays(today, -2);
    this._requestId = 0;
    this._initialDateResolved = false;
    this.setDateState(today, anchor);
    this.loadMatches();
    this.loadHealth();
  },

  onUnload() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
  },

  onPullDownRefresh() {
    Promise.all([this.loadMatches(), this.loadHealth()]).finally(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    return { title: `${this.data.selectedMeta.month}月${this.data.selectedMeta.day}日网球赛程 · 球序`, path: "/pages/timeline/index" };
  },

  setDateState(selectedDate, anchorDate) {
    this.setData({
      selectedDate,
      anchorDate,
      selectedMeta: dates.dateMeta(selectedDate),
      dateStrip: dates.buildDateStrip(anchorDate)
    });
  },

  selectDate(event) {
    const selectedDate = event.currentTarget.dataset.date;
    if (!selectedDate || selectedDate === this.data.selectedDate) return;
    this.setDateState(selectedDate, this.data.anchorDate);
    this.loadMatches();
  },

  shiftDates(event) {
    const amount = Number(event.currentTarget.dataset.amount || 0);
    const selectedDate = dates.addDays(this.data.selectedDate, amount);
    const anchorDate = dates.addDays(this.data.anchorDate, amount);
    this.setDateState(selectedDate, anchorDate);
    this.loadMatches();
  },

  returnToday() {
    const today = dates.beijingToday();
    this.setDateState(today, dates.addDays(today, -2));
    this.loadMatches();
  },

  selectTour(event) {
    const value = event.currentTarget.dataset.value;
    if (!value || value === this.data.currentTour) return;
    this.setData({ currentTour: value });
    this.loadMatches();
  },

  handleSearchInput(event) {
    const query = String(event.detail.value || "").trim();
    this.setData({ query });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.loadMatches(), 320);
  },

  clearSearch() {
    this.setData({ query: "" });
    this.loadMatches();
  },

  retry() {
    this.loadMatches();
  },

  async loadMatches() {
    const requestId = ++this._requestId;
    this.setData({ loading: true, error: "" });
    try {
      const payload = await api.getMatches({
        date: this.data.selectedDate,
        tour: this.data.currentTour,
        query: this.data.query
      });
      if (requestId !== this._requestId) return;
      const matches = Array.isArray(payload.matches) ? payload.matches : [];
      if (!this._initialDateResolved && !matches.length && payload.suggestedDate) {
        this._initialDateResolved = true;
        this.setDateState(payload.suggestedDate, dates.addDays(payload.suggestedDate, -2));
        await this.loadMatches();
        return;
      }
      this._initialDateResolved = true;
      this.setData({ groups: groupMatches(matches), matchCount: matches.length });
    } catch (error) {
      if (requestId !== this._requestId) return;
      this.setData({ groups: [], matchCount: 0, error: error.message || "暂时无法获取比赛数据" });
    } finally {
      if (requestId === this._requestId) this.setData({ loading: false });
    }
  },

  async loadHealth() {
    try {
      const health = await api.getHealth();
      if (health.lastSync) {
        this.setData({ syncText: `数据已同步 · ${dates.formatSyncTime(health.lastSync.finished_at)}` });
      }
    } catch (error) {
      this.setData({ syncText: "数据状态暂不可用" });
    }
  },

  openMatch(event) {
    const groupIndex = Number(event.currentTarget.dataset.group);
    const matchIndex = Number(event.currentTarget.dataset.match);
    const match = this.data.groups[groupIndex] && this.data.groups[groupIndex].matches[matchIndex];
    if (!match) return;
    wx.setStorageSync("tennis-flow:selected-match", match);
    wx.navigateTo({ url: "/pages/match/index" });
  }
});
