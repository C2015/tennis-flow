import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function shouldPoll(matches, now = new Date()) {
  const localNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const today = localNow.toISOString().slice(0, 10);
  const localMinute = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();

  if (matches.some((match) => match.status === "in_progress")) return "match in progress";

  for (const match of matches) {
    if (match.status !== "scheduled") continue;
    if (match.time && /^\d{2}:\d{2}$/.test(match.time)) {
      const scheduledAt = Date.parse(`${match.date}T${match.time}:00+08:00`);
      const minutesUntilStart = (scheduledAt - now.getTime()) / 60000;
      if (minutesUntilStart >= -360 && minutesUntilStart <= 30) return "match near scheduled start";
    } else if (match.date === today && localMinute % 60 < 5) {
      // Unknown start times need an occasional discovery check.
      return "match scheduled today without a start time";
    }
  }
  return null;
}

async function main() {
  const endpoint = process.env.WORKER_SYNC_URL;
  if (!endpoint) throw new Error("Configure WORKER_SYNC_URL in GitHub Actions secrets.");

  const now = new Date();
  const localNow = now.getTime() + SHANGHAI_OFFSET_MS;
  const dates = [-DAY_MS, 0, DAY_MS].map((offset) => new Date(localNow + offset).toISOString().slice(0, 10));
  const matches = [];
  for (const date of dates) {
    const url = new URL(endpoint);
    url.pathname = "/api/matches";
    url.search = new URLSearchParams({ date, fresh: now.toISOString() }).toString();
    const response = await fetch(url, { headers: { "cache-control": "no-cache", "user-agent": "curl/8.7.1" } });
    if (!response.ok) throw new Error(`Failed to check ${date} matches (${response.status})`);
    const payload = await response.json();
    if (!Array.isArray(payload.matches)) throw new Error(`Invalid match response for ${date}`);
    matches.push(...payload.matches);
  }

  const reason = shouldPoll(matches, now);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `should_sync=${reason ? "true" : "false"}\n`);
  }
  console.log(reason ? `ESPN check needed: ${reason}.` : "No active or imminent match; skipping ESPN.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
