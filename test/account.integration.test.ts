import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createUser, fakeAuth, integrationEnabled, resetDb, startTestApp } from "./helpers.js";
import { createGame } from "../src/services/gameService.js";

describe("accounts and game creation", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
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

  const newGame = (whiteId: number, blackId: number) =>
    app.pg.transact((tx) => createGame(tx, { whiteId, blackId, time: 180, increment: 0 }));

  test("a player can't be put into two games at once", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    const c = await createUser(app, "carol");
    // Hold the first game's transaction open while the second one starts
    const first = await app.pg.connect();
    try {
      await first.query("BEGIN");
      await createGame(first, { whiteId: a.id, blackId: b.id, time: 180, increment: 0 });
      const second = newGame(a.id, c.id);
      await new Promise((r) => setTimeout(r, 200));
      await first.query("COMMIT");
      await assert.rejects(second, { code: "ALREADY_IN_GAME" });
    } finally {
      first.release();
    }
    const { rows } = await app.pg.query(`SELECT count(*)::int AS n FROM games WHERE status = 'in_progress'`);
    assert.equal(rows[0].n, 1);
  });

  test("the stored rating change is what was applied at the rating floor", async () => {
    const low = await createUser(app, "lowly", 100);
    const other = await createUser(app, "other", 100);
    const game = await newGame(low.id, other.id);
    await app.pg.query(`UPDATE games SET "numMoves" = 2 WHERE id = $1`, [game.id]);
    await app.liveGames.resign(game.id, low.id);
    const { rows } = await app.pg.query(
      `SELECT "whiteRatingChange", "blackRatingChange" FROM games WHERE id = $1`,
      [game.id]
    );
    assert.equal(rows[0].whiteRatingChange, 0); // already at the floor
    assert.ok(rows[0].blackRatingChange > 0);
  });

  test("deleting an account resigns its game, anonymizes it and can be retried", async () => {
    const del = await createUser(app, "leaver");
    const friend = await createUser(app, "stayer");
    await app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [del.id, friend.id]);
    const game = await newGame(del.id, friend.id);
    await app.pg.query(`UPDATE games SET "numMoves" = 2 WHERE id = $1`, [game.id]);

    const deleted: string[] = [];
    const original = fakeAuth.deleteUser;
    fakeAuth.deleteUser = async (clerkId) => {
      deleted.push(clerkId);
    };
    try {
      const remove = () =>
        fetch(`http://${baseUrl}/api/users/me`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${del.clerkId}` },
        });
      assert.equal((await remove()).status, 204);
      // Retry after a partial failure: the profile is gone, Clerk is asked again
      assert.equal((await remove()).status, 204);
      assert.deepEqual(deleted, [del.clerkId, del.clerkId]);
    } finally {
      fakeAuth.deleteUser = original;
    }

    const { rows: games } = await app.pg.query(`SELECT * FROM games WHERE id = $1`, [game.id]);
    assert.equal(games[0].status, "finished");
    assert.equal(games[0].winnerId, friend.id);
    assert.equal(games[0].whiteUsername, `deleted-${del.id}`);

    const { rows: users } = await app.pg.query(`SELECT * FROM users WHERE id = $1`, [del.id]);
    assert.equal(users[0].clerkId, null);
    assert.equal(users[0].email, null);
    assert.equal(users[0].username, `deleted-${del.id}`);

    const { rows: friends } = await app.pg.query(`SELECT 1 FROM friends`);
    assert.equal(friends.length, 0);
  });
});
