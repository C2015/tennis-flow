const DAY_MS = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function beijingToday() {
  return new Date(Date.now() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function fromISO(value) {
  return new Date(`${value}T00:00:00Z`);
}

function addDays(value, amount) {
  return new Date(fromISO(value).getTime() + amount * DAY_MS).toISOString().slice(0, 10);
}

function dayDifference(value, reference = beijingToday()) {
  return Math.round((fromISO(value).getTime() - fromISO(reference).getTime()) / DAY_MS);
}

function dateMeta(value) {
  const date = fromISO(value);
  const delta = dayDifference(value);
  return {
    iso: value,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: WEEKDAYS[date.getUTCDay()],
    relative: delta === 0 ? "今天" : delta === -1 ? "昨天" : delta === 1 ? "明天" : "北京时间"
  };
}

function buildDateStrip(anchor, count = 7) {
  const today = beijingToday();
  return Array.from({ length: count }, (_, index) => {
    const meta = dateMeta(addDays(anchor, index));
    return { ...meta, isToday: meta.iso === today };
  });
}

function formatSyncTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "刚刚";
  const beijing = new Date(date.getTime() + BEIJING_OFFSET_MS);
  return `${beijing.getUTCMonth() + 1}月${beijing.getUTCDate()}日 ${String(beijing.getUTCHours()).padStart(2, "0")}:${String(beijing.getUTCMinutes()).padStart(2, "0")}`;
}

module.exports = { addDays, beijingToday, buildDateStrip, dateMeta, formatSyncTime };
