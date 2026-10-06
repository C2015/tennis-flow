import assert from "node:assert/strict";
import test from "node:test";
import worker, { beijingDate, coreMatchUpdate, readCoreMatch, runLiveSync, MAX_MATCHES_PER_TICK } from "../src/live-sync.js";

const match = { id: "espn-184332", tournamentId: "espn-959-2026-wta", player1Id: "espn-3626", player2Id: "espn-17886", date: "2026-10-05", score: "7-5", setScores: '[{"p1":7,"p2":5}]' };
const competition = { id: "184332", competitors: [{ id: "17886", winner: false }, { id: "3626", winner: true }] };
const final = { type: { state: "post", completed: true } };
const lines = [
  { count: 2, items: [{ period: 2, value: 6 }, { period: 1, value: 7 }] },
  { count: 2, items: [{ period: 1, value: 5 }, { period: 2, value: 1 }] }
];

test("preserves database player order and final winner across reordered core resources", () => {
  assert.deepEqual(coreMatchUpdate(match, competition, final, lines), {
    status: "finished", winnerId: "espn-3626", score: "7-5 6-1", setScores: [{ p1: 7, p2: 5 }, { p1: 6, p2: 1 }]
  });
  const swapped = { ...match, player1Id: match.player2Id, player2Id: match.player1Id };
  assert.equal(coreMatchUpdate(swapped, competition, final, [...lines].reverse()).score, "5-7 1-6");
});

test("rejects incomplete snapshots and invalid pairings without clearing stored live scores", () => {
  assert.equal(coreMatchUpdate(match, competition, { type: { state: "pre" } }, null), null);
  assert.throws(() => coreMatchUpdate(match, competition, { type: { state: "in" } }, [{ count: 0, items: [] }, { count: 0, items: [] }]), /Empty live snapshot/);
  assert.throws(() => coreMatchUpdate(match, competition, final, [{ count: 2, items: [] }, lines[1]]), /Incomplete/);
  assert.throws(() => coreMatchUpdate(match, { ...competition, id: "999" }, final, lines), /ID mismatch/);
  assert.throws(() => coreMatchUpdate(match, { ...competition, competitors: [{ id: "1" }, { id: "1" }] }, final, lines), /pairing/);
});

test("handles a replacement player without putting the existing opponent's score on the wrong side", () => {
  const changed = { ...competition, competitors: [{ id: "17886", order: 1 }, { id: "3001", name: "Katarina Zavatska", order: 2 }] };
  const update = coreMatchUpdate(match, changed, { type: { state: "in" } }, lines);
  assert.equal(update.player1Id, "espn-3001");
  assert.equal(update.player2Id, "espn-17886");
  assert.equal(update.score, "7-5 6-1");
  assert.deepEqual(update.newPlayers, [{ id: "espn-3001", name: "Katarina Zavatska" }]);
});

test("converts Beijing dates correctly at midnight and year boundaries", () => {
  assert.equal(beijingDate(new Date("2026-10-05T15:59:59Z")), "2026-10-05");
  assert.equal(beijingDate(new Date("2026-10-05T16:00:00Z")), "2026-10-06");
  assert.equal(beijingDate(new Date("2026-12-31T16:00:00Z")), "2027-01-01");
});

test("uses only four small resources and never requests a full scoreboard", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    const body = url.endsWith("/status") ? final
      : url.includes("/3626/linescores") ? lines[0]
      : url.includes("/17886/linescores") ? lines[1] : { count: 2, items: competition.competitors };
    return new Response(JSON.stringify(body));
  });
  assert.equal((await readCoreMatch(match)).score, "7-5 6-1");
  assert.equal(urls.length, 4);
  assert.ok(urls.every((url) => url.startsWith("https://sports.core.api.espn.com/") && !url.includes("scoreboard")));
});

test("does not access ESPN when no match is eligible and applies a fixed batch limit", async (t) => {
  let queryBindings;
  const database = { prepare(sql) { return { bind(...values) { if (sql.includes("FROM matches m JOIN")) queryBindings = values; return this; }, async all() { return { results: [] }; }, async run() {} }; } };
  t.mock.method(globalThis, "fetch", () => { throw new Error("ESPN must not be called"); });
  assert.deepEqual(await runLiveSync({ DB: database }, new Date("2026-10-06T05:13:00Z"), "WTA"), { checked: 0, updated: 0, failures: 0 });
  assert.equal(queryBindings[0], "WTA");
  assert.equal(queryBindings.at(-1), MAX_MATCHES_PER_TICK);
});

test("isolates a failed match and submits database changes in one batch", async (t) => {
  const targets = [0, 1, 2].map((offset) => ({ ...match, id: `espn-${184332 + offset}` }));
  let batchCalls = 0;
  const database = {
    prepare(sql) { return { sql, bind() { return this; }, async all() { return { results: targets }; }, async run() {} }; },
    async batch(statements) {
      batchCalls += 1;
      assert.equal(statements.length, 7);
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    const id = /competitions\/(\d+)/.exec(url)[1];
    if (id === "184334") return new Response("unavailable", { status: 503 });
    const body = url.endsWith("/status") ? (id === "184333" ? { type: { state: "pre" } } : final)
      : url.includes("/3626/linescores") ? lines[0]
      : url.includes("/17886/linescores") ? lines[1] : { count: 2, items: competition.competitors };
    return new Response(JSON.stringify(body));
  });
  assert.deepEqual(await runLiveSync({ DB: database }, new Date("2026-10-06T05:13:00Z"), "WTA"), { checked: 3, updated: 1, failures: 1 });
  assert.equal(batchCalls, 1);
});


test("dispatches each worker to its configured tour while old schedules propagate", async (t) => {
  const tours = [];
  const database = { prepare(sql) { return { bind(...values) { if (sql.includes("FROM matches m JOIN")) tours.push(values[0]); return this; }, async all() { return { results: [] }; }, async run() {} }; } };
  t.mock.method(globalThis, "fetch", () => { throw new Error("No eligible matches must not call ESPN"); });
  const scheduledTime = Date.parse("2026-10-06T05:13:00Z");
  for (const tour of ["ATP", "WTA"]) {
    await worker.scheduled({ cron: "0-59/1 * * * *", scheduledTime }, { DB: database, LIVE_TOUR: tour });
  }
  await worker.scheduled({ cron: "3-59/5 * * * *", scheduledTime }, { DB: database, LIVE_TOUR: "ATP" });
  assert.deepEqual(tours, ["ATP", "WTA", "WTA"]);
  await assert.rejects(worker.scheduled({ cron: "0-59/1 * * * *", scheduledTime }, { DB: database, LIVE_TOUR: "INVALID" }), /schedule or tour/);
});
