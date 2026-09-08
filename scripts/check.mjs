import fs from "node:fs";
import vm from "node:vm";

const required = [
  "public/index.html", "public/styles.css", "public/app.js", "src/worker.js", "db/schema.sql", ".github/workflows/sync.yml",
  "project.config.json", "miniprogram/app.json", "miniprogram/app.js", "miniprogram/app.wxss",
  "miniprogram/pages/timeline/index.js", "miniprogram/pages/timeline/index.wxml", "miniprogram/pages/timeline/index.wxss",
  "miniprogram/pages/match/index.js", "miniprogram/pages/match/index.wxml", "miniprogram/pages/match/index.wxss"
];
for (const file of required) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`Missing or empty: ${file}`);
}
const worker = await import(new URL("../src/worker.js", import.meta.url));
if (typeof worker.default?.fetch !== "function") throw new Error("Worker fetch handler missing");
if (typeof worker.default?.scheduled !== "function") throw new Error("Worker scheduled handler missing");
JSON.parse(fs.readFileSync("data/sample-feed.json", "utf8"));
const project = JSON.parse(fs.readFileSync("project.config.json", "utf8"));
if (project.appid !== "wxf575cca5dce6ff34") throw new Error("Mini Program AppID mismatch");
for (const file of ["miniprogram/app.json", "miniprogram/sitemap.json", "miniprogram/pages/timeline/index.json", "miniprogram/pages/match/index.json"]) {
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
  { id: "1", tournament: "Test Open", player1: "A", player1Zh: "甲", player2: "B", setScores: [{ p1: 6, p2: 4 }] }
]);
if (groups.length !== 1 || groups[0].matches[0].player1Primary !== "甲" || !groups[0].matches[0].setScores[0].p1Won) {
  throw new Error("Mini Program match normalization failed");
}
console.log(`OK: ${required.length} project files and feed schema are present.`);
