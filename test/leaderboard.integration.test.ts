import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createUser, integrationEnabled, resetDb, startTestApp } from "./helpers.js";
import { createGame } from "../src/services/gameService.js";
import { LEADERBOARD_VARIANTS, type LeaderboardVariant } from "../src/models/Leaderboard.js";

describe("leaderboard", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let baseUrl: string;

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(app);
  });

  /** Sets a player's rating and rated-game count in one variant. */
  const rate = async (userId: number, variant: LeaderboardVariant, rating: number, games = 1) => {
    const { rating: r, highest, games: g } = LEADERBOARD_VARIANTS[variant];
    await app.pg.query(`UPDATE users SET "${r}" = $2, "${highest}" = $2 + 50, "${g}" = $3 WHERE id = $1`, [
      userId,
      rating,
      games,
    ]);
  };

  const get = async (clerkId: string | null, query: string) => {
    const res = await fetch(`http://${baseUrl}/api/leaderboard?${query}`, {
      headers: clerkId ? { authorization: `Bearer ${clerkId}` } : {},
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const befriend = (a: number, b: number) =>
    app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [a, b]);

  test("orders by rating, shares ranks on ties and skips players without rated games", async () => {
    const a = await createUser(app, "alpha");
    const b = await createUser(app, "bravo");
    const c = await createUser(app, "charlie");
    const d = await createUser(app, "delta");
    await createUser(app, "never", 3000); // no games: not listed despite the rating
    await rate(a.id, "blitz", 1400, 3);
    await rate(b.id, "blitz", 1600);
    await rate(c.id, "blitz", 1400);
    await rate(d.id, "blitz", 1300);
    await rate(d.id, "rapid", 2000); // other variants don't leak in

    const { status, body } = await get(a.clerkId, "variant=blitz");
    assert.equal(status, 200);
    assert.equal(body.variant, "blitz");
    assert.equal(body.scope, "global");
    assert.deepEqual(
      body.data.map((e: any) => [e.rank, e.username, e.rating]),
      [
        [1, "bravo", 1600],
        [2, "alpha", 1400], // tie: lower id first
        [2, "charlie", 1400],
        [4, "delta", 1300],
      ]
    );
    assert.deepEqual(body.data[1], {
      rank: 2,
      id: a.id,
      username: "alpha",
      avatarUrl: null,
      rating: 1400,
      highestRating: 1450,
      gamesPlayed: 3,
    });
    assert.deepEqual(body.pagination, { page: 1, limit: 10, total: 4, totalPages: 1 });
    assert.equal(body.me.rank, 2);
    assert.equal(body.me.page, 1);
  });

  test("puzzle leaderboard lists players after a rated attempt in Infinite mode", async () => {
    const solver = await createUser(app, "solver");
    const idle = await createUser(app, "idle");
    await rate(idle.id, "blitz", 1500); // a game rating doesn't list you for puzzles

    // Friends scope isn't cached, so the global page below is computed fresh
    const before = await get(solver.clerkId, "variant=puzzle&scope=friends");
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.data, []);
    assert.equal(before.body.me, null);

    // Solving it move by move (seed06: b3g8 f8g8 h6f7); the server rates it
    const res = await fetch(`http://${baseUrl}/api/puzzles/seed06/check`, {
      method: "POST",
      headers: { authorization: `Bearer ${solver.clerkId}`, "content-type": "application/json" },
      body: JSON.stringify({ moves: ["b3g8", "h6f7"] }),
    });
    assert.equal(res.status, 200);
    const { puzzleRating } = ((await res.json()) as any).attempt;

    const { body } = await get(solver.clerkId, "variant=puzzle");
    assert.deepEqual(
      body.data.map((e: any) => [e.rank, e.username, e.rating, e.gamesPlayed]),
      [[1, "solver", puzzleRating, 1]]
    );
    assert.equal(body.me.rank, 1);
  });

  test("rated games count towards eligibility, aborted games don't", async () => {
    const w = await createUser(app, "white");
    const b = await createUser(app, "black");
    const start = (time: number) =>
      app.pg.transact((tx) => createGame(tx, { whiteId: w.id, blackId: b.id, time, increment: 0 }));

    const aborted = await start(60);
    await app.liveGames.abort(aborted.id, w.id);
    assert.equal((await get(w.clerkId, "variant=bullet")).body.pagination.total, 0);

    const played = await start(60);
    await app.pg.query(`UPDATE games SET "numMoves" = 2 WHERE id = $1`, [played.id]);
    await app.liveGames.resign(played.id, w.id);
    await app.redis.flushDb(); // drop the cached empty page

    const { body } = await get(w.clerkId, "variant=bullet");
    assert.deepEqual(
      body.data.map((e: any) => [e.username, e.gamesPlayed]),
      [
        ["black", 1],
        ["white", 1],
      ]
    );
    assert.equal(body.me.rank, 2);
    // The winner's peak moved up with their rating
    assert.equal(body.data[0].highestRating, body.data[0].rating);
    assert.ok(body.data[0].rating > body.data[1].rating);
    // A bullet game doesn't list anyone in blitz
    assert.equal((await get(w.clerkId, "variant=blitz")).body.pagination.total, 0);
  });

  test("your own position is fresh right after a game or a rated puzzle; pages keep a key old code can read", async () => {
    const w = await createUser(app, "white");
    const b = await createUser(app, "black");
    await rate(w.id, "bullet", 1500);
    await rate(b.id, "bullet", 1495);
    await rate(b.id, "puzzle", 1200);
    assert.equal((await get(b.clerkId, "variant=bullet")).body.me.rank, 2);
    const puzzleBefore = (await get(b.clerkId, "variant=puzzle")).body.me.rating;
    assert.equal(puzzleBefore, 1200);
    // Pages are stored as {v, freshUntil}: under a name code from before
    // that change doesn't read as a page
    assert.equal(await app.redis.exists("leaderboard:global:bullet:10:1"), 0);
    assert.equal(await app.redis.exists("leaderboard:v2:global:bullet:10:1"), 1);
    assert.equal(await app.redis.exists(`leaderboard:me:bullet:${b.id}`), 1);

    const game = await app.pg.transact((tx) => createGame(tx, { whiteId: w.id, blackId: b.id, time: 60, increment: 0 }));
    await app.pg.query(`UPDATE games SET "numMoves" = 2 WHERE id = $1`, [game.id]);
    await app.liveGames.resign(game.id, w.id);
    // The page may be up to GLOBAL_CACHE_SECONDS old; the caller's own entry isn't
    const after = (await get(b.clerkId, "variant=bullet")).body.me;
    assert.equal(after.rank, 1);
    assert.ok(after.rating > 1495, `rating ${after.rating}`);
    assert.equal((await get(w.clerkId, "variant=bullet")).body.me.rank, 2);

    const res = await fetch(`http://${baseUrl}/api/puzzles/seed06/check`, {
      method: "POST",
      headers: { authorization: `Bearer ${b.clerkId}`, "content-type": "application/json" },
      body: JSON.stringify({ moves: ["b3g8", "h6f7"] }),
    });
    const { puzzleRating } = ((await res.json()) as any).attempt;
    assert.notEqual(puzzleRating, puzzleBefore);
    assert.equal((await get(b.clerkId, "variant=puzzle")).body.me.rating, puzzleRating);
  });

  test("the peak is never reported below the current rating", async () => {
    const me = await createUser(app, "climber");
    // A row written before finishGame kept the peak up to date
    await app.pg.query(
      `UPDATE users SET "blitzRating" = 1408, "highestBlitzRating" = 1400, "blitzGames" = 2 WHERE id = $1`,
      [me.id]
    );

    const { body } = await get(me.clerkId, "variant=blitz&scope=friends");
    assert.equal(body.data[0].highestRating, 1408);
    assert.equal(body.me.highestRating, 1408);
  });

  test("paginates with ranks continuing across pages and pins the caller's own entry", async () => {
    const ratings = [1900, 1800, 1700, 1700, 1700, 1500, 1400];
    const users = [];
    for (const [i, rating] of ratings.entries()) {
      const u = await createUser(app, `player${i}`);
      await rate(u.id, "rapid", rating);
      users.push(u);
    }
    const me = users[6]!;

    const page2 = await get(me.clerkId, "variant=rapid&page=2&limit=3");
    assert.equal(page2.status, 200);
    // Page 2 starts mid-tie: the 1700s are #3 on both pages
    assert.deepEqual(
      page2.body.data.map((e: any) => [e.rank, e.rating]),
      [
        [3, 1700],
        [3, 1700],
        [6, 1500],
      ]
    );
    assert.deepEqual(page2.body.pagination, { page: 2, limit: 3, total: 7, totalPages: 3 });

    const page1 = await get(me.clerkId, "variant=rapid&page=1&limit=3");
    assert.deepEqual(
      page1.body.data.map((e: any) => e.rank),
      [1, 2, 3]
    );
    // Off-page: "you are #7", found on page 3
    assert.equal(page1.body.me.id, me.id);
    assert.equal(page1.body.me.rank, 7);
    assert.equal(page1.body.me.page, 3);

    // Tied users land on the page their row is actually listed on
    const tied = await get(users[4]!.clerkId, "variant=rapid&limit=3");
    assert.equal(tied.body.me.rank, 3);
    assert.equal(tied.body.me.page, 2);

    const beyond = await get(me.clerkId, "variant=rapid&page=9&limit=3");
    assert.deepEqual(beyond.body.data, []);
    assert.equal(beyond.body.me.rank, 7);
  });

  test("friends scope covers friends and the caller only", async () => {
    const me = await createUser(app, "myself");
    const f1 = await createUser(app, "friend1");
    const f2 = await createUser(app, "friend2");
    const stranger = await createUser(app, "stranger");
    const idle = await createUser(app, "idlefriend");
    await befriend(me.id, f1.id);
    await befriend(f2.id, me.id); // either side of the pair
    await befriend(me.id, idle.id); // a friend without games stays unlisted
    await befriend(f1.id, stranger.id); // friend of a friend isn't included
    await rate(me.id, "blitz", 1500);
    await rate(f1.id, "blitz", 1200);
    await rate(f2.id, "blitz", 1700);
    await rate(stranger.id, "blitz", 2500);

    const { body } = await get(me.clerkId, "variant=blitz&scope=friends");
    assert.equal(body.scope, "friends");
    assert.deepEqual(
      body.data.map((e: any) => [e.rank, e.username]),
      [
        [1, "friend2"],
        [2, "myself"],
        [3, "friend1"],
      ]
    );
    assert.equal(body.pagination.total, 3);
    assert.equal(body.me.rank, 2);

    const global = await get(me.clerkId, "variant=blitz&scope=global");
    assert.equal(global.body.me.rank, 3);
  });

  test("the caller without rated games gets me: null; deleted accounts are hidden", async () => {
    const me = await createUser(app, "newbie");
    const gone = await createUser(app, "goner");
    const kept = await createUser(app, "keeper");
    await rate(gone.id, "blitz", 1900);
    await rate(kept.id, "blitz", 1100);
    await app.pg.query(`UPDATE users SET "clerkId" = NULL, username = 'deleted-' || id WHERE id = $1`, [gone.id]);

    const { body } = await get(me.clerkId, "variant=blitz");
    assert.equal(body.me, null);
    assert.deepEqual(
      body.data.map((e: any) => [e.rank, e.username]),
      [[1, "keeper"]]
    );
  });

  test("global pages, the caller's own entry and the totals are cached briefly", async () => {
    const a = await createUser(app, "cached");
    const b = await createUser(app, "fresh");
    await rate(a.id, "bullet", 1500);
    await rate(b.id, "bullet", 1400);
    await get(a.clerkId, "variant=bullet");

    await rate(b.id, "bullet", 1600);
    const { body } = await get(b.clerkId, "variant=bullet");
    assert.deepEqual(
      body.data.map((e: any) => e.username),
      ["cached", "fresh"]
    );
    // b's own entry wasn't cached yet
    assert.equal(body.me.rank, 1);
    assert.equal(body.me.rating, 1600);

    // Now it is (for everyone's own entry, separately), and so is the number of listed players
    await rate(b.id, "bullet", 1300);
    const late = await createUser(app, "late");
    await rate(late.id, "bullet", 1450);
    const again = (await get(b.clerkId, "variant=bullet")).body;
    assert.deepEqual([again.me.rank, again.me.rating], [1, 1600]);
    assert.equal(again.pagination.total, 2);
    assert.equal((await get(late.clerkId, "variant=bullet")).body.me.rating, 1450);
    await app.redis.flushDb();
    const fresh = (await get(b.clerkId, "variant=bullet")).body;
    assert.deepEqual([fresh.me.rank, fresh.me.rating, fresh.pagination.total], [3, 1300, 3]);

    // Friends scope is computed on every request
    await rate(b.id, "bullet", 1250);
    const friends = await get(b.clerkId, "variant=bullet&scope=friends");
    assert.deepEqual(
      friends.body.data.map((e: any) => [e.rank, e.rating]),
      [[1, 1250]]
    );
    assert.equal(friends.body.me.rating, 1250);
  });

  test("rejects bad parameters and anonymous requests", async () => {
    const me = await createUser(app, "checker");
    assert.equal((await get(null, "variant=blitz")).status, 401);
    for (const query of [
      "variant=classical",
      "scope=everyone",
      "page=0",
      "page=abc",
      "limit=0",
      "limit=101",
    ]) {
      const { status, body } = await get(me.clerkId, query);
      assert.equal(status, 400, query);
      assert.equal(body.code, "VALIDATION_ERROR", query);
    }
    // Defaults: blitz, global, page 1, limit 10
    const { status, body } = await get(me.clerkId, "");
    assert.equal(status, 200);
    assert.equal(body.variant, "blitz");
    assert.equal(body.scope, "global");
    assert.deepEqual(body.pagination, { page: 1, limit: 10, total: 0, totalPages: 0 });
  });
});
