const $ = (selector) => document.querySelector(selector);
const state = {
  date: localISODate(new Date()),
  anchor: addDays(new Date(), -3),
  tour: "all",
  query: "",
  matches: [],
  initialDateResolved: false
};

const els = {
  strip: $("#dateStrip"), timeline: $("#timeline"), loading: $("#loading"), empty: $("#emptyState"),
  year: $("#dateYear"), title: $("#dateTitle"), label: $("#dateLabel"), count: $("#matchCount"),
  searchPanel: $("#searchPanel"), searchInput: $("#searchInput"), dialog: $("#matchDialog"),
  dialogContent: $("#dialogContent"), sync: $("#syncStatus")
};

renderDates();
loadMatches();
loadHealth();

$("#prevDates").addEventListener("click", () => shiftDates(-5));
$("#nextDates").addEventListener("click", () => shiftDates(5));
$("#todayButton").addEventListener("click", () => {
  state.date = localISODate(new Date());
  state.anchor = addDays(new Date(), -3);
  renderDates(); loadMatches();
});
$("#filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tour]");
  if (!button) return;
  document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
  state.tour = button.dataset.tour;
  loadMatches();
});
$("#searchButton").addEventListener("click", () => {
  els.searchPanel.hidden = !els.searchPanel.hidden;
  if (!els.searchPanel.hidden) els.searchInput.focus();
});
$("#clearSearch").addEventListener("click", () => {
  els.searchInput.value = ""; state.query = ""; loadMatches(); els.searchInput.focus();
});
let searchTimer;
els.searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = els.searchInput.value.trim(); loadMatches(); }, 260);
});
$("#dialogClose").addEventListener("click", () => els.dialog.close());
els.dialog.addEventListener("click", (event) => {
  if (event.target === els.dialog) els.dialog.close();
});

function shiftDates(amount) {
  state.anchor = addDays(state.anchor, amount);
  state.date = localISODate(addDays(parseDate(state.date), amount));
  renderDates(); loadMatches();
}

function renderDates() {
  const today = localISODate(new Date());
  const selected = parseDate(state.date);
  els.year.textContent = selected.getFullYear();
  els.title.textContent = `${selected.getMonth() + 1}月${selected.getDate()}日`;
  const delta = dayDiff(selected, new Date());
  const relative = delta === 0 ? "今天" : delta === -1 ? "昨天" : delta === 1 ? "明天" : "北京时间";
  els.label.textContent = `${weekday(selected, "long")} · ${relative}`;
  els.strip.replaceChildren();

  for (let i = 0; i < 7; i++) {
    const date = addDays(state.anchor, i);
    const iso = localISODate(date);
    const button = document.createElement("button");
    button.className = `date-tab${iso === state.date ? " active" : ""}${iso === today ? " today" : ""}`;
    button.type = "button";
    button.role = "tab";
    button.setAttribute("aria-selected", iso === state.date ? "true" : "false");
    button.innerHTML = `<span>${weekday(date, "short")}</span><strong>${String(date.getDate()).padStart(2, "0")}</strong>`;
    button.addEventListener("click", () => { state.date = iso; renderDates(); loadMatches(); });
    els.strip.append(button);
  }
}

async function loadMatches() {
  els.loading.hidden = false;
  els.empty.hidden = true;
  els.timeline.replaceChildren();
  const params = new URLSearchParams({ date: state.date, tour: state.tour, q: state.query });
  try {
    const response = await fetch(`/api/matches?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.matches = payload.matches || [];
    if (!state.initialDateResolved && !state.matches.length && payload.suggestedDate) {
      state.initialDateResolved = true;
      state.date = payload.suggestedDate;
      state.anchor = addDays(parseDate(payload.suggestedDate), -3);
      renderDates();
      return loadMatches();
    }
    state.initialDateResolved = true;
  } catch {
    state.matches = demoMatches().filter((match) => {
      const matchesTour = state.tour === "all" || match.tour === state.tour || (state.tour === "slam" && match.level === "Grand Slam");
      const haystack = `${match.player1} ${match.player2} ${match.tournament}`.toLowerCase();
      return match.date === state.date && matchesTour && haystack.includes(state.query.toLowerCase());
    });
    els.sync.textContent = "本地预览 · 演示数据";
  } finally {
    els.loading.hidden = true;
  }
  renderTimeline();
}

function renderTimeline() {
  els.count.textContent = `${state.matches.length} 场比赛`;
  els.empty.hidden = state.matches.length > 0;
  if (!state.matches.length) return;
  const groups = Map.groupBy ? Map.groupBy(state.matches, (m) => m.tournament) : groupBy(state.matches, (m) => m.tournament);
  let delay = 0;
  for (const [name, matches] of groups) {
    const tournament = matches[0];
    const fragment = $("#tournamentTemplate").content.cloneNode(true);
    const group = fragment.querySelector(".tournament-group");
    group.style.animationDelay = `${delay++ * 60}ms`;
    fragment.querySelector(".tour-level").textContent = `${tournament.tour} · ${tournament.level}`;
    fragment.querySelector(".tour-name").textContent = name;
    fragment.querySelector(".tour-meta").textContent = [tournament.surface, tournament.city].filter(Boolean).join(" · ");
    const list = fragment.querySelector(".match-list");
    matches.forEach((match) => list.append(matchCard(match)));
    els.timeline.append(fragment);
  }
}

function matchCard(match) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "match-card";
  const sets = match.status === "finished"
    ? `<div class="sets">${(match.setScores || []).map((set) => `<span class="set"><i class="${set.p1 > set.p2 ? "won" : ""}">${set.p1}</i><i class="${set.p2 > set.p1 ? "won" : ""}">${set.p2}</i></span>`).join("")}</div>`
    : `<span class="scheduled-label">待开赛</span>`;
  card.innerHTML = `
    <span class="match-time"><strong>${escapeHTML(match.time || "待定")}</strong><small>${match.status === "finished" ? "已完赛" : escapeHTML(match.round || "赛程")}</small></span>
    <span class="players">
      ${playerRow(match.player1, match.player1Country, match.player1Rank, match.winner === 1)}
      ${playerRow(match.player2, match.player2Country, match.player2Rank, match.winner === 2)}
    </span>
    ${sets}<span class="chevron">›</span>`;
  card.addEventListener("click", () => openMatch(match));
  return card;
}

function playerRow(name, country, rank, winner) {
  return `<span class="player-row"><small class="flag">${escapeHTML(country || "—")}</small><span class="player ${winner ? "winner" : ""}">${escapeHTML(name)}</span><small class="rank">${rank ? `#${rank}` : "—"}</small></span>`;
}

function openMatch(match) {
  const stats = match.stats;
  const sourceName = match.sourceUrl?.includes("espn.com") ? "ESPN Tennis" : "开放网球数据";
  const sourceNote = match.sourceUrl
    ? `<p class="demo-note">数据来自 <a href="${escapeHTML(match.sourceUrl)}" target="_blank" rel="noreferrer">${sourceName}</a>。开赛时间、场地、排名和技术统计仅在来源提供时展示。</p>`
    : `<p class="demo-note">这是一条本地演示记录，仅用于界面预览，不代表真实赛程或赛果。</p>`;
  els.dialogContent.innerHTML = `
    <div class="dialog-hero">
      <span class="dialog-kicker">${escapeHTML(match.tour)} · ${escapeHTML(match.level)} · ${escapeHTML(match.round || "")}</span>
      <h2>${escapeHTML(match.tournament)}</h2>
      <div class="dialog-players">
        <div class="dialog-player"><strong>${escapeHTML(match.player1)}</strong><span>${escapeHTML(match.player1Country || "—")} · ${match.player1Rank ? `世界 #${match.player1Rank}` : "暂无排名"}</span></div>
        <div class="dialog-score">${escapeHTML(match.score || "VS")}</div>
        <div class="dialog-player"><strong>${escapeHTML(match.player2)}</strong><span>${escapeHTML(match.player2Country || "—")} · ${match.player2Rank ? `世界 #${match.player2Rank}` : "暂无排名"}</span></div>
      </div>
    </div>
    <div class="dialog-body">
      <div class="match-facts">
        ${fact("北京时间", `${match.date} ${match.time || "待定"}`)}
        ${fact("比赛场地", match.court || "待公布")}
        ${fact("场地类型", match.surface || "待公布")}
      </div>
      <div class="stats-title"><h3>比赛技术统计</h3><span>${stats ? "球员 1 / 球员 2" : ""}</span></div>
      ${stats ? [
        stat("ACE 球", stats.aces), stat("双误", stats.doubleFaults),
        stat("一发成功率", stats.firstServe, "%"), stat("破发成功", stats.breakPoints)
      ].join("") : `<p class="no-stats">${match.status === "finished" ? "数据源暂未提供本场技术统计" : "比赛结束后，如数据源提供则在这里显示"}</p>`}
      ${sourceNote}
    </div>`;
  els.dialog.showModal();
}

const fact = (label, value) => `<div class="fact"><span>${label}</span><strong>${escapeHTML(value)}</strong></div>`;
const stat = (label, values = ["—", "—"], suffix = "") => `<div class="stat-row"><strong>${values?.[0] ?? "—"}${suffix}</strong><label>${label}</label><strong>${values?.[1] ?? "—"}${suffix}</strong></div>`;

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return;
    const data = await response.json();
    if (data.lastSync) els.sync.textContent = `数据已同步 · ${formatSync(data.lastSync.finished_at)} · ${data.lastSync.source}`;
  } catch { /* static preview */ }
}

function demoMatches() {
  const today = localISODate(new Date());
  const yesterday = localISODate(addDays(new Date(), -1));
  const tomorrow = localISODate(addDays(new Date(), 1));
  const common = { level: "Grand Slam", surface: "硬地", city: "纽约" };
  return [
    { id:"d1", date:today, time:"00:30", status:"finished", round:"半决赛", court:"阿瑟·阿什球场", tournament:"美国网球公开赛 · 男单", tour:"ATP", player1:"扬尼克·辛纳", player1Country:"ITA", player1Rank:1, player2:"亚历山大·兹维列夫", player2Country:"GER", player2Rank:3, winner:1, score:"3–1", setScores:[{p1:6,p2:4},{p1:3,p2:6},{p1:6,p2:3},{p1:6,p2:4}], stats:{aces:[12,9],doubleFaults:[3,5],firstServe:[68,62],breakPoints:[4,2]}, ...common },
    { id:"d2", date:today, time:"08:10", status:"scheduled", round:"半决赛", court:"阿瑟·阿什球场", tournament:"美国网球公开赛 · 男单", tour:"ATP", player1:"卡洛斯·阿尔卡拉斯", player1Country:"ESP", player1Rank:2, player2:"诺瓦克·德约科维奇", player2Country:"SRB", player2Rank:7, winner:null, score:null, setScores:[], stats:null, ...common },
    { id:"d3", date:today, time:"03:00", status:"finished", round:"半决赛", court:"路易斯·阿姆斯特朗球场", tournament:"美国网球公开赛 · 女单", tour:"WTA", player1:"伊加·斯维亚特克", player1Country:"POL", player1Rank:2, player2:"杰西卡·佩古拉", player2Country:"USA", player2Rank:4, winner:1, score:"2–0", setScores:[{p1:6,p2:3},{p1:7,p2:5}], stats:{aces:[5,2],doubleFaults:[2,4],firstServe:[71,64],breakPoints:[5,2]}, ...common },
    { id:"d4", date:today, time:"09:30", status:"scheduled", round:"半决赛", court:"阿瑟·阿什球场", tournament:"美国网球公开赛 · 女单", tour:"WTA", player1:"阿丽娜·萨巴伦卡", player1Country:"—", player1Rank:1, player2:"科科·高芙", player2Country:"USA", player2Rank:3, winner:null, score:null, setScores:[], stats:null, ...common },
    { id:"d7", date:today, time:"11:20", status:"finished", round:"四分之一决赛", court:"中央球场", tournament:"亚洲网球公开赛 · 男单", tour:"ATP", level:"ATP 500", surface:"硬地", city:"东京", player1:"费利克斯·奥热-阿利亚西姆", player1Country:"CAN", player1Rank:18, player2:"亚历克斯·德米纳尔", player2Country:"AUS", player2Rank:9, winner:2, score:"1–2", setScores:[{p1:6,p2:4},{p1:5,p2:7},{p1:3,p2:6}], stats:{aces:[11,7],doubleFaults:[6,2],firstServe:[59,67],breakPoints:[2,4]} },
    { id:"d8", date:today, time:"13:45", status:"scheduled", round:"第二轮", court:"2号球场", tournament:"亚洲网球公开赛 · 男单", tour:"ATP", level:"ATP 500", surface:"硬地", city:"东京", player1:"张之臻", player1Country:"CHN", player1Rank:47, player2:"本·谢尔顿", player2Country:"USA", player2Rank:12, winner:null, score:null, setScores:[], stats:null },
    { id:"d9", date:today, time:"16:00", status:"finished", round:"第二轮", court:"钻石球场", tournament:"中国女子网球公开赛", tour:"WTA", level:"WTA 1000", surface:"硬地", city:"北京", player1:"郑钦文", player1Country:"CHN", player1Rank:6, player2:"巴博拉·克雷吉茨科娃", player2Country:"CZE", player2Rank:15, winner:1, score:"2–1", setScores:[{p1:4,p2:6},{p1:7,p2:5},{p1:6,p2:2}], stats:null },
    { id:"d10", date:today, time:"19:30", status:"scheduled", round:"第二轮", court:"莲花球场", tournament:"中国女子网球公开赛", tour:"WTA", level:"WTA 1000", surface:"硬地", city:"北京", player1:"米拉·安德列娃", player1Country:"—", player1Rank:8, player2:"艾玛·拉杜卡努", player2Country:"GBR", player2Rank:31, winner:null, score:null, setScores:[], stats:null },
    { id:"d5", date:yesterday, time:"14:00", status:"finished", round:"四分之一决赛", court:"17号球场", tournament:"美国网球公开赛 · 男单", tour:"ATP", player1:"示例球员 A", player1Country:"CHN", player1Rank:86, player2:"示例球员 B", player2Country:"JPN", player2Rank:112, winner:1, score:"3–2", setScores:[{p1:6,p2:4},{p1:3,p2:6},{p1:7,p2:5},{p1:4,p2:6},{p1:6,p2:2}], stats:null, ...common },
    { id:"d6", date:tomorrow, time:"04:00", status:"scheduled", round:"决赛", court:"阿瑟·阿什球场", tournament:"美国网球公开赛 · 男单", tour:"ATP", player1:"待定球员 1", player1Country:"—", player1Rank:null, player2:"待定球员 2", player2Country:"—", player2Rank:null, winner:null, score:null, setScores:[], stats:null, ...common },
    { id:"d11", date:tomorrow, time:"14:30", status:"scheduled", round:"第三轮", court:"中央球场", tournament:"亚洲网球公开赛 · 男单", tour:"ATP", level:"ATP 500", surface:"硬地", city:"东京", player1:"待定球员 3", player1Country:"—", player1Rank:null, player2:"待定球员 4", player2Country:"—", player2Rank:null, winner:null, score:null, setScores:[], stats:null }
  ];
}

function groupBy(items, getKey) { const result = new Map(); for (const item of items) { const key = getKey(item); result.set(key, [...(result.get(key) || []), item]); } return result; }
function addDays(value, days) { const date = new Date(value); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + days); return date; }
function parseDate(iso) { const [y,m,d] = iso.split("-").map(Number); return new Date(y, m - 1, d, 12); }
function localISODate(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }
function dayDiff(a, b) { const x = new Date(a.getFullYear(),a.getMonth(),a.getDate()); const y = new Date(b.getFullYear(),b.getMonth(),b.getDate()); return Math.round((x-y)/86400000); }
function weekday(date, length) { return new Intl.DateTimeFormat("zh-CN", { weekday: length }).format(date); }
function formatSync(value) { try { return new Intl.DateTimeFormat("zh-CN", {month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Asia/Shanghai"}).format(new Date(value)); } catch { return value; } }
function escapeHTML(value = "") { return String(value).replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char])); }
