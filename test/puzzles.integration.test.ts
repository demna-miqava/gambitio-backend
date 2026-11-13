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

  // Seed puzzles (migration 005): seed01..seed06 rated 600, 650, 700, 750, 900, 1300
  const auth = (clerkId: string) => ({ authorization: `Bearer ${clerkId}` });
  const attempt = (clerkId: string, id: string, success: boolean) =>
    app.inject({
      method: "POST",
      url: `/api/puzzles/${id}/attempt`,
      headers: auth(clerkId),
      payload: { success },
    });
  const list = async (clerkId: string, params: Record<string, string>) => {
    const res = await app.inject({
      method: "GET",
      url: `/api/puzzles?${new URLSearchParams(params)}`,
      headers: auth(clerkId),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { data: { id: string; themes: string[] }[]; nextCursor: string | null };
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
    const me = await app.inject({ method: "GET", url: "/api/users/me", headers: auth(user.clerkId) });
    assert.equal(me.json().user.puzzleRating, 1500);
    assert.equal(me.json().user.highestPuzzleRating, 1500);
    const profile = await app.inject({ method: "GET", url: `/api/users/${user.id}`, headers: auth(user.clerkId) });
    assert.equal(profile.json().user.puzzleRating, 1500);
  });

  test("a solved rated attempt raises the rating, records it and marks the puzzle solved", async () => {
    await setPuzzleRating(user.id, 1200);
    const res = await attempt(user.clerkId, "seed06", true);
    assert.equal(res.statusCode, 200, res.body);
    // expected = 1 / (1 + 10^(100/400)) = 0.360; K = 40 (provisional) => +26
    assert.deepEqual(res.json(), { rated: true, puzzleRating: 1226, highestPuzzleRating: 1226, ratingChange: 26 });
    assert.deepEqual(await ratingRow(user.id), { puzzleRating: 1226, highestPuzzleRating: 1226, puzzleAttempts: 1 });

    const { rows } = await app.pg.query(`SELECT success, "ratingBefore", "ratingChange" FROM puzzle_attempts`);
    assert.deepEqual(rows, [{ success: true, ratingBefore: 1200, ratingChange: 26 }]);
    assert.ok(!(await list(user.clerkId, { limit: "10" })).ids.includes("seed06"));
  });

  test("a failed rated attempt lowers the rating but keeps the highest", async () => {
    await setPuzzleRating(user.id, 1200);
    const res = await attempt(user.clerkId, "seed06", false);
    // 40 * (0 - 0.360) => -14
    assert.deepEqual(res.json(), { rated: true, puzzleRating: 1186, highestPuzzleRating: 1200, ratingChange: -14 });
    // Failed puzzles are still served in unrated (ascending) mode
    assert.ok((await list(user.clerkId, { limit: "10" })).ids.includes("seed06"));
  });

  test("only the first attempt at a puzzle is rated; a later solve still marks it solved", async () => {
    await setPuzzleRating(user.id, 1200);
    assert.equal((await attempt(user.clerkId, "seed06", false)).json().ratingChange, -14);
    const retry = await attempt(user.clerkId, "seed06", true);
    assert.deepEqual(retry.json(), { rated: false, puzzleRating: 1186, highestPuzzleRating: 1200, ratingChange: 0 });
    assert.deepEqual(await ratingRow(user.id), { puzzleRating: 1186, highestPuzzleRating: 1200, puzzleAttempts: 1 });
    assert.ok(!(await list(user.clerkId, { limit: "10" })).ids.includes("seed06"));
    // Another user's first attempt is rated independently
    const other = await createUser(app, "other");
    assert.equal((await attempt(other.clerkId, "seed06", true)).json().rated, true);
  });

  test("concurrent duplicate attempts are rated once", async () => {
    await setPuzzleRating(user.id, 1200);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => attempt(user.clerkId, "seed06", i % 2 === 0))
    );
    assert.ok(results.every((r) => r.statusCode === 200));
    const rated = results.map((r) => r.json()).filter((r) => r.rated);
    assert.equal(rated.length, 1);
    const row = await ratingRow(user.id);
    assert.equal(row.puzzleAttempts, 1);
    assert.equal(row.puzzleRating, 1200 + rated[0].ratingChange);
    const { rows } = await app.pg.query(`SELECT count(*)::int AS n FROM puzzle_attempts`);
    assert.equal(rows[0].n, 1);
  });

  test("attempts on unknown puzzles are 404 and bodies are validated", async () => {
    assert.equal((await attempt(user.clerkId, "nope", true)).statusCode, 404);
    const bad = await app.inject({
      method: "POST",
      url: "/api/puzzles/seed01/attempt",
      headers: auth(user.clerkId),
      payload: { success: "yes" },
    });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(await ratingRow(user.id), { puzzleRating: 1500, highestPuzzleRating: 1500, puzzleAttempts: 0 });
  });

  test("theme filter returns only puzzles with that theme, keyset-paged", async () => {
    const page1 = await list(user.clerkId, { theme: "smotheredMate", limit: "1" });
    assert.deepEqual(page1.ids, ["seed05"]);
    assert.ok(page1.body.nextCursor);
    const page2 = await list(user.clerkId, { theme: "smotheredMate", limit: "1", cursor: page1.body.nextCursor });
    assert.deepEqual(page2.ids, ["seed06"]);
    assert.equal(page2.body.nextCursor, null);
    assert.deepEqual((await list(user.clerkId, { theme: "opening" })).ids, ["seed04"]);
    assert.deepEqual((await list(user.clerkId, { theme: "noSuchTheme" })).ids, []);

    const bad = await app.inject({ method: "GET", url: "/api/puzzles?theme=a%20b", headers: auth(user.clerkId) });
    assert.equal(bad.statusCode, 400);
  });

  test("rated mode starts near the user's rating, skips attempted puzzles and falls back to the easiest", async () => {
    await setPuzzleRating(user.id, 900);
    // Starts at 900 - 50: seed05 (900) and seed06 (1300)
    const page1 = await list(user.clerkId, { mode: "rated", limit: "1" });
    assert.deepEqual(page1.ids, ["seed05"]);
    const page2 = await list(user.clerkId, { mode: "rated", limit: "1", cursor: page1.body.nextCursor! });
    assert.deepEqual(page2.ids, ["seed06"]);
    assert.equal(page2.body.nextCursor, null);

    // A failed rated attempt isn't served again in rated mode (it couldn't be rated)
    await attempt(user.clerkId, "seed05", false);
    assert.deepEqual((await list(user.clerkId, { mode: "rated", limit: "1" })).ids, ["seed06"]);

    // Nothing left at or above the rating: easiest first instead of nothing
    await setPuzzleRating(user.id, 2500);
    assert.deepEqual((await list(user.clerkId, { mode: "rated", limit: "2" })).ids, ["seed01", "seed02"]);
    // Ascending (Rush / Survival) is unaffected by the rating
    assert.deepEqual((await list(user.clerkId, { limit: "2" })).ids, ["seed01", "seed02"]);
    // Rated mode combined with a theme
    assert.deepEqual((await list(user.clerkId, { mode: "rated", theme: "opening" })).ids, ["seed04"]);
  });

  test("themes lists every theme with its count, cached", async () => {
    const get = () => app.inject({ method: "GET", url: "/api/puzzles/themes", headers: auth(user.clerkId) });
    const res = await get();
    assert.equal(res.statusCode, 200);
    const { rows } = await app.pg.query(
      `SELECT t AS theme, COUNT(*)::int AS count FROM puzzles, unnest(themes) t GROUP BY t ORDER BY count DESC, theme`
    );
    assert.deepEqual(res.json().data, rows);
    assert.ok(await app.redis.exists("puzzles:themes"));
    assert.deepEqual((await get()).json().data, rows);
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
    await attempt(user.clerkId, "seed06", true); // clears the stats cache
    assert.deepEqual((await summary()).json().puzzle, {
      rating: 1226,
      highestRating: 1226,
      attempts: 1,
      solved: 1,
      delta: 26,
    });
  });
});
