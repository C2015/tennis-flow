import fs from "node:fs/promises";

const endpoint = process.env.WORKER_SYNC_URL;
const token = process.env.SYNC_TOKEN;
const dryRun = process.env.SYNC_DRY_RUN === "1";
if (!endpoint || (!token && !dryRun)) throw new Error("Configure WORKER_SYNC_URL and SYNC_TOKEN in GitHub Actions secrets.");

const feed = JSON.parse(await fs.readFile(".sync/live-feed.json", "utf8"));
if (!Array.isArray(feed.matches) || !feed.updatedAt || !feed.source) throw new Error("Invalid live feed");
const dates = [...new Set(feed.matches.map((match) => match.date))];
const existing = new Map();
for (const date of dates) {
  const url = new URL(endpoint);
  url.pathname = "/api/matches";
  url.search = new URLSearchParams({ date, fresh: feed.updatedAt }).toString();
  const response = await fetch(url, { headers: { "cache-control": "no-cache", "user-agent": "curl/8.7.1" } });
  if (!response.ok) throw new Error(`Failed to read ${date} matches (${response.status})`);
  const payload = await response.json();
  if (!Array.isArray(payload.matches)) throw new Error(`Invalid match response for ${date}`);
  for (const match of payload.matches) existing.set(match.id, match);
}

const changes = feed.matches.filter((match) => changed(match, existing.get(match.id)));
if (dryRun) {
  console.log(`Dry run: ${changes.length} changed matches out of ${feed.matches.length}.`);
  process.exit(0);
}
if (!changes.length) {
  console.log(`No score or schedule changes among ${feed.matches.length} recent matches.`);
  process.exit(0);
}

const response = await fetch(endpoint, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ ...feed, matches: changes })
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`Worker sync failed (${response.status}): ${JSON.stringify(payload)}`);
console.log(`Updated ${payload.imported} changed matches out of ${feed.matches.length}.`);

function changed(next, current) {
  if (!current) return true;
  // ESPN can briefly publish an empty or pre-match snapshot while a match is live.
  if (current.status === "finished" && next.status === "scheduled") return false;
  if (current.score && !next.score && next.status === "scheduled") return false;
  const nextStatus = next.status === "scheduled" && next.score ? "in_progress" : next.status;
  return nextStatus !== current.status
    || (next.score || null) !== (current.score || null)
    || JSON.stringify(next.setScores || []) !== JSON.stringify(current.setScores || [])
    || (next.winnerId || null) !== (current.winnerPlayerId || null)
    || next.date !== current.date
    || (next.time || null) !== (current.time || null)
    || (next.court || null) !== (current.court || null)
    || (next.round || null) !== (current.round || null)
    || next.players[0].id !== current.player1Id
    || next.players[1].id !== current.player2Id;
}
