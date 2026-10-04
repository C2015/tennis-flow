import assert from "node:assert/strict";
import test from "node:test";
import { shouldPoll } from "./should_sync_live.mjs";

const now = new Date("2026-10-04T05:07:00Z"); // 13:07 in Beijing
const match = (status, time = "13:30", date = "2026-10-04") => ({ status, time, date });

test("polls active matches and those close to their scheduled start", () => {
  assert.equal(shouldPoll([match("in_progress")], now), "match in progress");
  assert.equal(shouldPoll([match("scheduled")], now), "match near scheduled start");
  assert.equal(shouldPoll([match("scheduled", "07:30")], now), "match near scheduled start");
});

test("skips finished matches and matches outside the discovery window", () => {
  assert.equal(shouldPoll([], now), null);
  assert.equal(shouldPoll([match("finished")], now), null);
  assert.equal(shouldPoll([match("scheduled", "18:00")], now), null);
  assert.equal(shouldPoll([match("scheduled", "06:30")], now), null);
});

test("checks unknown start times once per Beijing hour", () => {
  assert.equal(shouldPoll([match("scheduled", null)], now), null);
  assert.equal(shouldPoll([match("scheduled", null)], new Date("2026-10-04T05:02:00Z")), "match scheduled today without a start time");
  assert.equal(shouldPoll([match("scheduled", null, "2026-10-05")], new Date("2026-10-04T05:02:00Z")), null);
});
