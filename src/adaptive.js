export const SCOREBOARD_HEADERS = Object.freeze({
  accept: "*/*",
  "user-agent": "curl/8.7.1"
});

export function scoreboardDateCandidates(localDate) {
  const center = new Date(`${localDate}T00:00:00Z`);
  if (!Number.isFinite(center.getTime())) return [];
  return [0, -1, 1].map((offset) => {
    const candidate = new Date(center);
    candidate.setUTCDate(candidate.getUTCDate() + offset);
    return candidate.toISOString().slice(0, 10).replaceAll("-", "");
  });
}

export function pollingIntervalMinutes(level, tournament) {
  const value = `${level || ""} ${tournament || ""}`.toLowerCase();
  if (/grand slam|1000|finals|olympic|australian open|roland garros|french open|wimbledon|us open/.test(value)) return 10;
  if (/\b500\b/.test(value)) return 30;
  return 60;
}

export function adaptiveDueReason(group, state, nowMs) {
  if (!state) return "first_check";
  const nextCheck = Date.parse(state.next_check_at || "");
  const lastCheck = Date.parse(state.last_checked_at || "");
  if (!Number.isFinite(nextCheck) || !Number.isFinite(lastCheck)) return "first_check";
  if (nextCheck <= nowMs) return "scheduled";

  const acceleratedAt = lastCheck + group.interval * 60_000;
  return acceleratedAt < nextCheck && acceleratedAt <= nowMs ? "priority_escalation" : null;
}

export function scoreboardUpdateStatus(type = {}) {
  const description = String(type.description || "").toLowerCase();
  if (description.includes("cancel") || description.includes("abandon")) return "cancelled";
  if (description.includes("postpon") || description.includes("suspend")) return "postponed";
  if (type.state === "post" || type.completed === true) return "finished";
  // D1 keeps an active match in the scheduled bucket so the adaptive poller
  // continues following it. The API presents it as in_progress once scores exist.
  if (type.state === "in") return "scheduled";
  return null;
}

export function matchDisplayStatus(status, setScores = [], score = null) {
  if (status !== "scheduled") return status;
  const hasSetScore = Array.isArray(setScores) && setScores.some((set) =>
    Number(set?.p1) > 0 || Number(set?.p2) > 0
  );
  return hasSetScore || String(score || "").trim() ? "in_progress" : status;
}
