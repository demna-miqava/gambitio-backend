import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyBaseLogger } from "fastify";
import { DeadlineTimers } from "../src/services/deadlineTimers.js";

/** Lets the promise a timer's resolve returned settle (setImmediate isn't mocked) */
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

const log = { error: () => {} } as unknown as FastifyBaseLogger;

test("nothing is armed until enabled, and stop turns them off again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const resolved: number[] = [];
  const timers = new DeadlineTimers(async (id) => void resolved.push(id), log);
  timers.watch(1, new Date(Date.now() + 1_000));
  assert.equal(timers.size, 0);

  timers.enable();
  timers.watch(1, new Date(Date.now() + 1_000));
  timers.watch(2, new Date(Date.now() + 5_000));
  assert.deepEqual([...timers.gameIds()], [1, 2]);
  t.mock.timers.tick(1_000);
  assert.deepEqual(resolved, [], "a moment after the deadline, not on it");
  t.mock.timers.tick(20);
  assert.deepEqual(resolved, [1]);
  assert.equal(timers.size, 1, "a timer that fired is gone");

  timers.stop();
  assert.equal(timers.size, 0);
  timers.watch(3, new Date(Date.now() + 1_000));
  assert.equal(timers.size, 0);
  t.mock.timers.tick(10_000);
  assert.deepEqual(resolved, [1]);
});

test("a moved deadline re-arms, a null one clears, the same one is left alone", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const resolved: number[] = [];
  const timers = new DeadlineTimers(async (id) => void resolved.push(id), log);
  timers.enable();
  const at = new Date(Date.now() + 1_000);
  timers.watch(1, at);
  t.mock.timers.tick(500);
  // The same deadline again (another message about the same move) keeps the timer
  timers.watch(1, new Date(at));
  t.mock.timers.tick(520);
  assert.deepEqual(resolved, [1]);

  timers.watch(2, new Date(Date.now() + 1_000));
  timers.watch(2, new Date(Date.now() + 3_000));
  t.mock.timers.tick(1_100);
  assert.deepEqual(resolved, [1], "moved later");
  t.mock.timers.tick(2_000);
  assert.deepEqual(resolved, [1, 2]);

  timers.watch(3, new Date(Date.now() + 1_000));
  timers.watch(3, null);
  assert.equal(timers.size, 0);
  timers.stop();
});

test("a failed resolve retries unless the game was re-armed meanwhile", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let calls = 0;
  let timers!: DeadlineTimers;
  timers = new DeadlineTimers(async (id) => {
    calls++;
    if (id === 2) timers.watch(2, new Date(Date.now() + 60_000)); // a new deadline came in
    throw new Error("lock timeout");
  }, log);
  timers.enable();
  timers.watch(1, new Date(Date.now()));
  t.mock.timers.tick(20);
  await flush();
  assert.equal(calls, 1);
  assert.equal(timers.size, 1, "re-armed for a retry");
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(calls, 2);

  timers.clear(1);
  timers.watch(2, new Date(Date.now()));
  t.mock.timers.tick(20);
  await flush();
  assert.equal(calls, 3);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(calls, 3, "the new deadline's timer stands, no retry on top");
  timers.stop();
});
