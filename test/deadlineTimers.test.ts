import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { LiveGameService } from "../src/services/liveGameService.js";
import type { RealtimeHub } from "../src/realtime/hub.js";

/** Lets async work started by a timer finish (setImmediate isn't mocked) */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A LiveGameService over a fake pool: `handle` answers each query by its SQL
 * (throw to fail it). No database, so these run without TEST_POSTGRES_URL.
 */
function service(handle: (sql: string) => unknown[]) {
  const queries: string[] = [];
  const fastify = {
    log: { error: () => {}, info: () => {}, warn: () => {} },
    pg: {
      query: async (sql: string) => {
        queries.push(sql);
        const rows = handle(sql);
        return { rows, rowCount: rows.length };
      },
    },
  };
  const live = new LiveGameService(fastify as unknown as FastifyInstance, {} as RealtimeHub);
  return { live, queries };
}

const isPausedRead = (sql: string) => sql.includes(`"pausedAt" < $1`);
const isLiveRead = (sql: string) => sql.includes(`SELECT id, "deadlineAt" FROM games WHERE status = 'in_progress'`);
const isDeadlineRead = (sql: string) => sql.includes(`FROM games WHERE id = $1`);

test("a failed resume at startup still turns the deadline timers on", async () => {
  const { live } = service((sql) => {
    if (isPausedRead(sql)) throw new Error("connection reset");
    return [];
  });
  await live.startDeadlineTimers();
  live.watchDeadline(1, new Date(Date.now() + 60_000));
  try {
    assert.equal(live.watchedGameCount, 1, "later games still get a timer");
  } finally {
    live.stop();
  }
});

test("a failed startup read of live deadlines keeps the clock sweep running and is retried", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let failing = true;
  const { live } = service((sql) => {
    if (isLiveRead(sql)) {
      if (failing) throw new Error("connection reset");
      return [{ id: 9, deadlineAt: new Date(Date.now() + 600_000) }];
    }
    return [];
  });
  try {
    await live.startDeadlineTimers();
    assert.equal(live.watchedGameCount, 0);
    assert.equal(live.liveDeadlinesPending, true);
    assert.equal(live.needsClockSweep, true, "the sweep runs although no timer is armed");
    t.mock.timers.tick(6 * 60_000);
    assert.equal(live.needsClockSweep, false, "only for a few minutes");

    // The sweep retries the read; a failure opens the window again
    await assert.rejects(live.armLiveDeadlines());
    assert.equal(live.needsClockSweep, true);
    failing = false;
    await live.armLiveDeadlines();
    assert.equal(live.liveDeadlinesPending, false);
    assert.equal(live.watchedGameCount, 1);
  } finally {
    live.stop();
    mock.timers.reset();
  }
});

test("a deadline timer whose resolve fails tries again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let reads = 0;
  const { live } = service((sql) => {
    if (isDeadlineRead(sql)) {
      reads++;
      if (reads === 1) throw new Error("lock timeout");
      return [{ status: "finished", deadlineAt: null, pausedAt: null, whiteId: 1, blackId: 2 }];
    }
    return [];
  });
  try {
    await live.startDeadlineTimers();
    live.watchDeadline(7, new Date(Date.now() + 1_000));
    t.mock.timers.tick(1_100);
    await flush();
    assert.equal(reads, 1, "the timer fired and the resolve failed");
    assert.equal(live.watchedGameCount, 1, "re-armed");
    t.mock.timers.tick(5_000);
    await flush();
    assert.equal(reads, 2, "and tried again");
    assert.equal(live.watchedGameCount, 0, "the game is over: no timer left");
  } finally {
    live.stop();
    mock.timers.reset();
  }
});

test("a player's socket here keeps the clock sweep running, an idle instance doesn't", () => {
  const { live } = service(() => []);
  assert.equal(live.needsClockSweep, false);
  const detach = live.attachPlayer(3, { stop: () => {} });
  assert.equal(live.needsClockSweep, true);
  detach();
  assert.equal(live.needsClockSweep, false);
});
