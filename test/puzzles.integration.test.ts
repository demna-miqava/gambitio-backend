import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createUser, integrationEnabled, resetDb, startTestApp } from "./helpers.js";

describe("puzzles", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let user: { id: number; clerkId: string };

  before(async () => {
    ({ app } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(app);
    user = await createUser(app, "solver");
  });

  const fetchPage = async (clerkId: string, cursor?: string) => {
    const query = new URLSearchParams({ limit: "2", ...(cursor ? { cursor } : {}) });
    const res = await app.inject({
      method: "GET",
      url: `/api/puzzles?${query}`,
      headers: { authorization: `Bearer ${clerkId}` },
    });
    assert.equal(res.statusCode, 200);
    return res.json() as { data: { id: string }[]; nextCursor: string | null };
  };
  const solve = (clerkId: string, id: string) =>
    app.inject({
      method: "POST",
      url: `/api/puzzles/${id}/solve`,
      headers: { authorization: `Bearer ${clerkId}` },
    });

  test("solved puzzles are not served again, to that user only", async () => {
    const [a, b] = (await fetchPage(user.clerkId)).data.map((p) => p.id);
    assert.ok(a && b);

    assert.equal((await solve(user.clerkId, a)).statusCode, 204);
    assert.equal((await solve(user.clerkId, a)).statusCode, 204); // idempotent

    // b was never solved (e.g. failed), so it is still served
    assert.deepEqual((await fetchPage(user.clerkId)).data[0]?.id, b);

    const other = await createUser(app, "someone");
    assert.deepEqual((await fetchPage(other.clerkId)).data.map((p) => p.id), [a, b]);
  });

  test("keyset cursor pages forward without gaps after solves", async () => {
    const page1 = await fetchPage(user.clerkId);
    assert.ok(page1.nextCursor);
    // Solving page 1 must not shift page 2 (offset paging would skip puzzles)
    for (const p of page1.data) await solve(user.clerkId, p.id);
    const page2 = await fetchPage(user.clerkId, page1.nextCursor);
    const fresh = await fetchPage(user.clerkId);
    assert.deepEqual(page2.data.map((p) => p.id), fresh.data.map((p) => p.id));
  });

  test("solving an unknown puzzle is 404", async () => {
    assert.equal((await solve(user.clerkId, "nope")).statusCode, 404);
  });

  // seed06 is rated (Infinite): marking it solved would take it out of the
  // rated feed without the attempt, and its rating loss, ever counting
  test("a rated puzzle can only be marked solved after the rated attempt at it", async () => {
    const refused = await solve(user.clerkId, "seed06");
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().code, "PUZZLE_NOT_ATTEMPTED");
    assert.equal((await solve(user.clerkId, "nope0")).statusCode, 403, "nothing is said about which rated ids exist");

    const revealed = await app.inject({
      method: "POST",
      url: "/api/puzzles/seed06/reveal",
      headers: { authorization: `Bearer ${user.clerkId}` },
    });
    assert.equal(revealed.statusCode, 200);
    // A solve on retry, after the miss was rated
    assert.equal((await solve(user.clerkId, "seed06")).statusCode, 204);
  });

  // Seed puzzles (migration 005): seed01..seed06 rated 600, 650, 700, 750, 900, 1300.
  // Rated mode uses the even ids (seed02, seed04, seed06), Rush / Survival the odd ones.
  // seed06 is a mate in 2: b3g8 f8g8 h6f7
  const auth = (clerkId: string) => ({ authorization: `Bearer ${clerkId}` });
  const check = (clerkId: string, id: string, moves: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/puzzles/${id}/check`,
      headers: auth(clerkId),
      payload: { moves },
    });
  const reveal = (clerkId: string, id: string) =>
    app.inject({ method: "POST", url: `/api/puzzles/${id}/reveal`, headers: auth(clerkId) });
  const solveSeed06 = (clerkId: string) => check(clerkId, "seed06", ["b3g8", "h6f7"]);
  const failSeed06 = (clerkId: string) => check(clerkId, "seed06", ["b3b8"]);
  const list = async (clerkId: string, params: Record<string, string>) => {
    const res = await app.inject({
      method: "GET",
      url: `/api/puzzles?${new URLSearchParams(params)}`,
      headers: auth(clerkId),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      data: { id: string; themes: string[]; moves: string[]; hidden?: boolean }[];
      nextCursor: string | null;
    };
    return { ids: body.data.map((p) => p.id), body };
  };
  const setPuzzleRating = (id: number, rating: number) =>
    app.pg.query(`UPDATE users SET "puzzleRating" = $2, "highestPuzzleRating" = $2 WHERE id = $1`, [
      id,
      rating,
    ]);
  const ratingRow = async (id: number) =>
    (
      await app.pg.query(
        `SELECT "puzzleRating", "highestPuzzleRating", "puzzleAttempts" FROM users WHERE id = $1`,
        [id]
      )
    ).rows[0];

  test("new users start at 1500 and see it on their profile", async () => {
    const me = await app.inject({ method: "GET", url: "/api/users/status", headers: auth(user.clerkId) });
    assert.equal(me.json().user.puzzleRating, 1500);
    assert.equal(me.json().user.highestPuzzleRating, 1500);
    const profile = await app.inject({ method: "GET", url: `/api/users/${user.id}`, headers: auth(user.clerkId) });
    assert.equal(profile.json().user.puzzleRating, 1500);
  });

  test("rated puzzles are served without their solution", async () => {
    const { body } = await list(user.clerkId, { mode: "rated", limit: "10" });
    assert.ok(body.data.length > 0);
    for (const p of body.data) {
      assert.deepEqual(p.moves, []);
      assert.equal(p.hidden, true);
    }
    // ...while Rush / Survival puzzles come with it, from the other half
    const unrated = await list(user.clerkId, { limit: "10" });
    assert.deepEqual(unrated.ids, ["seed01", "seed03", "seed05"]);
    assert.ok(unrated.body.data.every((p) => p.moves.length > 0 && !p.hidden));
  });

  test("the server checks each move: a reply to continue, then the rated outcome", async () => {
    await setPuzzleRating(user.id, 1200);
    const first = await check(user.clerkId, "seed06", ["b3g8"]);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json(), { result: "continue", line: ["b3g8", "f8g8"] });
    // Nothing is recorded until the puzzle is over
    assert.deepEqual(await ratingRow(user.id), { puzzleRating: 1200, highestPuzzleRating: 1200, puzzleAttempts: 0 });

    const res = await solveSeed06(user.clerkId);
    // expected = 1 / (1 + 10^(100/400)) = 0.360; K = 40 (provisional) => +26
    assert.deepEqual(res.json(), {
      result: "solved",
      line: ["b3g8", "f8g8", "h6f7"],
      attempt: { rated: true, puzzleRating: 1226, highestPuzzleRating: 1226, ratingChange: 26 },
    });
    assert.deepEqual(await ratingRow(user.id), { puzzleRating: 1226, highestPuzzleRating: 1226, puzzleAttempts: 1 });
    const { rows } = await app.pg.query(`SELECT success, "ratingBefore", "ratingChange" FROM puzzle_attempts`);
    assert.deepEqual(rows, [{ success: true, ratingBefore: 1200, ratingChange: 26 }]);
    assert.ok(!(await list(user.clerkId, { mode: "rated", limit: "10" })).ids.includes("seed06"));
  });

  test("a wrong move fails the puzzle, lowers the rating and reveals the solution", async () => {
    await setPuzzleRating(user.id, 1200);
    const res = await failSeed06(user.clerkId);
    // 40 * (0 - 0.360) => -14
    assert.deepEqual(res.json(), {
      result: "failed",
      line: ["b3g8", "f8g8", "h6f7"],
      attempt: { rated: true, puzzleRating: 1186, highestPuzzleRating: 1200, ratingChange: -14 },
    });
  });

  test("a one-move puzzle is solved by its mate", async () => {
    const mate = await check(user.clerkId, "seed04", ["h5f7"]);
    assert.equal(mate.json().result, "solved");
    assert.deepEqual(mate.json().line, ["h5f7"]);
  });

  test("only the first outcome on a puzzle is rated", async () => {
    await setPuzzleRating(user.id, 1200);
    assert.equal((await failSeed06(user.clerkId)).json().attempt.ratingChange, -14);
    const again = await solveSeed06(user.clerkId);
    assert.deepEqual(again.json().attempt, { rated: false, puzzleRating: 1186, highestPuzzleRating: 1200, ratingChange: 0 });
    assert.deepEqual(await ratingRow(user.id), { puzzleRating: 1186, highestPuzzleRating: 1200, puzzleAttempts: 1 });
    // Another user's first outcome is rated independently
    const other = await createUser(app, "other");
    assert.equal((await solveSeed06(other.clerkId)).json().attempt.rated, true);
  });

  test("revealing the solution before the end counts as a miss", async () => {
    await setPuzzleRating(user.id, 1200);
    const res = await reveal(user.clerkId, "seed06");
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().result, "failed");
    assert.deepEqual(res.json().line, ["b3g8", "f8g8", "h6f7"]);
    assert.equal(res.json().attempt.ratingChange, -14);
    // Solving it now is unrated
    assert.equal((await solveSeed06(user.clerkId)).json().attempt.rated, false);
  });

  test("concurrent duplicate outcomes are rated once", async () => {
    await setPuzzleRating(user.id, 1200);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? solveSeed06 : failSeed06)(user.clerkId))
    );
    assert.ok(results.every((r) => r.statusCode === 200));
    const rated = results.map((r) => r.json().attempt).filter((a) => a.rated);
    assert.equal(rated.length, 1);
    const row = await ratingRow(user.id);
    assert.equal(row.puzzleAttempts, 1);
    assert.equal(row.puzzleRating, 1200 + rated[0].ratingChange);
  });

  test("checks refuse unrated or unknown puzzles, illegal moves and bad bodies", async () => {
    // Rush / Survival puzzles (solution already sent) can't be rated
    assert.equal((await check(user.clerkId, "seed05", ["g5f7"])).statusCode, 404);
    assert.equal((await check(user.clerkId, "nope", ["e2e4"])).statusCode, 404);
    assert.equal((await check(user.clerkId, "seed06", ["a1a8"])).statusCode, 400);
    assert.equal((await check(user.clerkId, "seed06", ["b3g8", "h6f7", "a2a3"])).json().result, "solved");
    assert.equal((await check(user.clerkId, "seed06", [])).statusCode, 400);
    assert.equal((await check(user.clerkId, "seed06", ["zz"])).statusCode, 400);
    const legacy = await app.inject({
      method: "POST",
      url: "/api/puzzles/seed06/attempt",
      headers: auth(user.clerkId),
      payload: { success: true },
    });
    assert.equal(legacy.statusCode, 404);
  });

  test("theme filter returns only puzzles with that theme, keyset-paged", async () => {
    const page1 = await list(user.clerkId, { theme: "mateIn1", limit: "2" });
    assert.deepEqual(page1.ids, ["seed01", "seed03"]);
    assert.ok(page1.body.nextCursor);
    const page2 = await list(user.clerkId, { theme: "mateIn1", limit: "2", cursor: page1.body.nextCursor });
    assert.deepEqual(page2.ids, ["seed05"]);
    assert.equal(page2.body.nextCursor, null);
    assert.deepEqual((await list(user.clerkId, { theme: "smotheredMate" })).ids, ["seed05"]);
    assert.deepEqual((await list(user.clerkId, { theme: "noSuchTheme" })).ids, []);

    const bad = await app.inject({ method: "GET", url: "/api/puzzles?theme=a%20b", headers: auth(user.clerkId) });
    assert.equal(bad.statusCode, 400);
  });

  test("rated mode starts near the user's rating, skips attempted puzzles and falls back to the easiest", async () => {
    await setPuzzleRating(user.id, 750);
    // Starts at 750 - 50 within the rated half: seed04 (750), then seed06 (1300)
    const page1 = await list(user.clerkId, { mode: "rated", limit: "1" });
    assert.deepEqual(page1.ids, ["seed04"]);
    const page2 = await list(user.clerkId, { mode: "rated", limit: "1", cursor: page1.body.nextCursor! });
    assert.deepEqual(page2.ids, ["seed06"]);
    assert.equal(page2.body.nextCursor, null);

    // A failed puzzle isn't served again in rated mode (it couldn't be rated)
    await check(user.clerkId, "seed04", ["h5h7"]);
    assert.deepEqual((await list(user.clerkId, { mode: "rated", limit: "1" })).ids, ["seed06"]);

    // Nothing left at or above the rating: easiest first instead of nothing
    await setPuzzleRating(user.id, 2500);
    assert.deepEqual((await list(user.clerkId, { mode: "rated", limit: "2" })).ids, ["seed02", "seed06"]);
    // Ascending (Rush / Survival) is unaffected by the rating
    assert.deepEqual((await list(user.clerkId, { limit: "2" })).ids, ["seed01", "seed03"]);
    // Rated mode combined with a theme
    assert.deepEqual((await list(user.clerkId, { mode: "rated", theme: "mateIn2" })).ids, ["seed06"]);
  });

  test("themes lists every theme with its count, counted ahead and cached", async () => {
    const get = () => app.inject({ method: "GET", url: "/api/puzzles/themes", headers: auth(user.clerkId) });
    const res = await get();
    assert.equal(res.statusCode, 200);
    // Migration 031 (and the import) counted them from the puzzles
    const { rows } = await app.pg.query(
      `SELECT t AS theme, COUNT(*)::int AS count FROM puzzles, unnest(themes) t GROUP BY t ORDER BY count DESC, theme`
    );
    assert.deepEqual(res.json().data, rows);
    assert.ok(await app.redis.exists("puzzles:theme-counts"));

    // Served from the counts table, not by counting the puzzles
    await app.pg.query(`INSERT INTO puzzle_theme_counts (theme, count) VALUES ('zzTest', 1)`);
    try {
      assert.deepEqual((await get()).json().data, rows); // still cached
      await app.redis.del("puzzles:theme-counts");
      assert.deepEqual((await get()).json().data, [...rows, { theme: "zzTest", count: 1 }]);
    } finally {
      await app.pg.query(`DELETE FROM puzzle_theme_counts WHERE theme = 'zzTest'`);
    }
  });

  test("stats summary includes the puzzle rating card", async () => {
    await setPuzzleRating(user.id, 1200);
    const summary = () =>
      app.inject({ method: "GET", url: `/api/users/${user.id}/stats/summary`, headers: auth(user.clerkId) });
    assert.deepEqual((await summary()).json().puzzle, {
      rating: 1200,
      highestRating: 1200,
      attempts: 0,
      solved: 0,
      delta: 0,
    });
    const gameStats = await app.redis.hGet(`stats:${user.id}`, "summary");
    assert.ok(gameStats);
    await solveSeed06(user.clerkId); // clears the cached puzzle card
    assert.deepEqual((await summary()).json().puzzle, {
      rating: 1226,
      highestRating: 1226,
      attempts: 1,
      solved: 1,
      delta: 26,
    });
    // ...and only that: the game stats stay cached
    assert.equal(await app.redis.hGet(`stats:${user.id}`, "summary"), gameStats);
  });
});
