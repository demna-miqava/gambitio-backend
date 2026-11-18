import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createJobs } from "../src/jobs.js";
import { CHALLENGE_TTL_MS } from "../src/services/challengeService.js";
import { TOURNAMENT_TICK_MS } from "../src/services/tournamentService.js";

/** Lets passes that already started finish (setImmediate isn't mocked) */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Just what createJobs touches, with a counter for every database pass. */
function fakeApp() {
  const calls = { clockSweep: 0, challenges: 0, series: 0, chat: 0, matchmaking: 0, tournaments: 0 };
  const state = {
    needsClockSweep: false,
    liveDeadlinesPending: false,
    othersAlive: false,
    attachedCount: 0,
    searching: 0,
    tournamentDue: false,
  };
  const app = {
    log: { error: () => {} },
    pg: {
      query: async () => {
        calls.clockSweep++;
        return { rows: [], rowCount: 0 };
      },
    },
    liveGames: {
      get needsClockSweep() {
        return state.needsClockSweep;
      },
      get liveDeadlinesPending() {
        return state.liveDeadlinesPending;
      },
      armLiveDeadlines: async () => {
        state.liveDeadlinesPending = false;
      },
      startDeadlineTimers: async () => {},
      resolveDeadline: async () => {},
      stop: () => {},
    },
    hub: {
      get othersAlive() {
        return state.othersAlive;
      },
      get attachedCount() {
        return state.attachedCount;
      },
      presenceCount: () => state.searching,
    },
    matchmaking: { sweep: async () => void calls.matchmaking++, removeLeftovers: async () => {} },
    challenges: { expireStale: async () => void calls.challenges++ },
    series: { expireStale: async () => void calls.series++ },
    gameChat: { sweep: async () => void calls.chat++ },
    tournaments: {
      loadOpen: async () => {},
      get needsTick() {
        return state.tournamentDue;
      },
      tick: async () => void calls.tournaments++,
    },
  };
  return { app: app as unknown as FastifyInstance, calls, state };
}

test("one idle tab doesn't make the sweeps query the database", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const { app, calls, state } = fakeApp();
  const jobs = createJobs(app);
  jobs.start();
  try {
    // Someone has the site open; no games, no other instance, no challenges
    state.attachedCount = 1;
    // Past the window left open at startup for a previous process's challenges
    t.mock.timers.tick(CHALLENGE_TTL_MS + 2 * 60_000);
    const settled = { ...calls };
    t.mock.timers.tick(25 * 60_000);
    await flush();
    assert.equal(calls.clockSweep, settled.clockSweep, "no clock sweep");
    assert.equal(calls.challenges, settled.challenges, "no challenge sweep");
    assert.equal(calls.matchmaking, 0);
    assert.equal(calls.tournaments, 0, "no tournament tick");
    // 37 minutes in: once, at the half hour
    assert.equal(calls.series, 1, "the series sweep runs only every half hour");

    // A live game, or another instance: the clock sweep runs
    state.needsClockSweep = true;
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(calls.clockSweep, settled.clockSweep + 1);
    state.needsClockSweep = false;
    state.othersAlive = true;
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(calls.clockSweep, settled.clockSweep + 2);

    // A tournament running or about to start: its tick runs, and stops with it
    state.tournamentDue = true;
    t.mock.timers.tick(TOURNAMENT_TICK_MS);
    await flush();
    assert.equal(calls.tournaments, 1);
    state.tournamentDue = false;
    t.mock.timers.tick(10 * TOURNAMENT_TICK_MS);
    await flush();
    assert.equal(calls.tournaments, 1);

    // A challenge stored here: the challenge sweep runs until it can have expired
    jobs.noteChallenge();
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(calls.challenges, settled.challenges + 1);
    t.mock.timers.tick(CHALLENGE_TTL_MS + 2 * 30_000);
    await flush();
    const afterWindow = calls.challenges;
    t.mock.timers.tick(5 * 60_000);
    await flush();
    assert.equal(calls.challenges, afterWindow, "and then stops");
  } finally {
    jobs.stop();
    mock.timers.reset();
  }
});

test("the clock sweep retries a failed startup read of the live games", async () => {
  const { app, state } = fakeApp();
  const jobs = createJobs(app);
  state.liveDeadlinesPending = true;
  await jobs.runClockSweep();
  assert.equal(state.liveDeadlinesPending, false, "armLiveDeadlines ran");
});
