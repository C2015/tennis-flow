import fs from "node:fs";

const required = ["public/index.html","public/styles.css","public/app.js","src/worker.js","db/schema.sql",".github/workflows/sync.yml"];
for (const file of required) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`Missing or empty: ${file}`);
}
const worker = await import(new URL("../src/worker.js", import.meta.url));
if (typeof worker.default?.fetch !== "function") throw new Error("Worker fetch handler missing");
JSON.parse(fs.readFileSync("data/sample-feed.json", "utf8"));
console.log(`OK: ${required.length} project files and feed schema are present.`);
