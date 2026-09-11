const API_BASE = "https://scores.tennisdrills.org";

function request(path, data = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${API_BASE}${path}`,
      data,
      method: "GET",
      timeout: 15000,
      header: { accept: "application/json" },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }
        reject(new Error(`数据接口返回 ${response.statusCode}`));
      },
      fail(error) {
        reject(new Error(error.errMsg || "网络请求失败"));
      }
    });
  });
}

function getMatches({ date, tour = "all", query = "" }) {
  return request("/api/matches", { date, tour, q: query, view: "draw-v1" });
}

function getHealth() {
  return request("/api/health");
}

function getDraw(tournamentId) {
  return request("/api/draw", { tournamentId });
}

module.exports = { API_BASE, getMatches, getHealth, getDraw };
