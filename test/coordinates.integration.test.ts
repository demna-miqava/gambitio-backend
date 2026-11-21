import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createUser, integrationEnabled, resetDb, startTestApp } from "./helpers.js";
import { RECENT_RUNS_KEPT } from "../src/routes/coordinates.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";

describe("coordinates trainer scores", { skip }, () => {
  let app: FastifyInstance;
  let alice: { id: number; clerkId: string };
  let bob: { id: number; clerkId: string };

  const request = (method: "GET" | "POST", url: string, clerkId: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${clerkId}` }, ...(payload && { payload }) });
  const run = (clerkId: string, body: Record<string, unknown>) =>
    request("POST", "/api/coordinates/runs", clerkId, {
      seconds: 30,
      perspective: "white",
      withPieces: true,
      misses: 0,
      ...body,
    });

  before(async () => {
    ({ app } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(app);
    alice = await createUser(app, "alice");
    bob = await createUser(app, "bob");
  });

  test("keeps the best per run length and side, and says what it was before", async () => {
    const first = (await run(alice.clerkId, { score: 18, misses: 2 })).json();
    assert.equal(first.previousBest, null);
    assert.equal(first.best.best, 18);

    const better = (await run(alice.clerkId, { score: 22 })).json();
    assert.equal(better.previousBest, 18);
    assert.equal(better.best.best, 22);

    const worse = (await run(alice.clerkId, { score: 10 })).json();
    assert.equal(worse.previousBest, 22);
    assert.equal(worse.best.best, 22);
    assert.equal(worse.best.achievedAt, better.best.achievedAt);

    // Other run lengths and sides have their own bests
    assert.equal((await run(alice.clerkId, { score: 5, perspective: "black" })).json().previousBest, null);
    assert.equal((await run(alice.clerkId, { score: 30, seconds: 60 })).json().previousBest, null);

    const scores = (await request("GET", "/api/coordinates/scores", alice.clerkId)).json();
    assert.equal(scores.bests.length, 3);
    assert.deepEqual(
      scores.recent.map((r: { score: number }) => r.score),
      [30, 5, 10, 22, 18]
    );
    assert.equal(scores.recent[4].misses, 2);
    assert.deepEqual((await request("GET", "/api/coordinates/scores", bob.clerkId)).json(), { bests: [], recent: [] });
  });

  test("refuses scores nobody could reach and unknown options", async () => {
    assert.equal((await run(alice.clerkId, { score: 91 })).statusCode, 400);
    assert.equal((await run(alice.clerkId, { score: 90 })).statusCode, 200);
    assert.equal((await run(alice.clerkId, { score: 100, misses: 81 })).statusCode, 400);
    assert.equal((await run(alice.clerkId, { score: 10, seconds: 45 })).statusCode, 400);
    assert.equal((await run(alice.clerkId, { score: 10, perspective: "random" })).statusCode, 400);
    assert.equal((await run(alice.clerkId, { score: -1 })).statusCode, 400);
    assert.equal((await run(alice.clerkId, { score: 1.5 })).statusCode, 400);
    assert.equal((await run(alice.clerkId, { score: 10, leaderboard: true })).statusCode, 400);
  });

  test("keeps only the latest runs", async () => {
    // Posting this many would meet the rate limit
    await app.pg.query(
      `INSERT INTO coordinate_runs ("userId", mode, seconds, perspective, "withPieces", score, misses)
       SELECT $1, 'find', 30, 'white', true, i, 0 FROM generate_series(1, $2::int) i ORDER BY i`,
      [alice.id, RECENT_RUNS_KEPT + 4]
    );
    assert.equal((await run(alice.clerkId, { score: RECENT_RUNS_KEPT + 5 })).statusCode, 200);
    const { rows } = await app.pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM coordinate_runs WHERE "userId" = $1`,
      [alice.id]
    );
    assert.equal(rows[0]!.n, RECENT_RUNS_KEPT);
    const scores = (await request("GET", "/api/coordinates/scores", alice.clerkId)).json();
    assert.equal(scores.recent[0].score, RECENT_RUNS_KEPT + 5);
    assert.equal(scores.recent.at(-1).score, 6);
    assert.equal(scores.bests[0].best, RECENT_RUNS_KEPT + 5);
  });
});
