import fs from "node:fs/promises";

const endpoint = process.env.WORKER_SYNC_URL;
const token = process.env.SYNC_TOKEN;
const feedPath = process.env.SYNC_FEED_FILE || ".sync/feed.json";
if (!endpoint || !token) {
  console.log("Sync skipped: configure WORKER_SYNC_URL and SYNC_TOKEN in GitHub Actions secrets.");
  process.exit(0);
}

const feed = JSON.parse(await fs.readFile(feedPath, "utf8"));
validateFeed(feed);
const response = await fetch(endpoint, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(feed)
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`Worker sync failed (${response.status}): ${JSON.stringify(payload)}`);
console.log(`Imported ${payload.imported} matches from ${payload.source}.`);

function validateFeed(feed) {
  if (!feed || !Array.isArray(feed.matches) || !feed.source || !feed.updatedAt) throw new Error("Feed must contain source, updatedAt and matches[]");
  for (const [index, item] of feed.matches.entries()) {
    if (!item.id || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !item.tournament?.id || !["ATP","WTA"].includes(item.tournament?.tour) || item.players?.length !== 2) throw new Error(`Invalid match at index ${index}`);
  }
}
