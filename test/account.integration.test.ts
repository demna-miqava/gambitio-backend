import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createUser, fakeAuth, integrationEnabled, resetDb, startTestApp } from "./helpers.js";
import { createGame } from "../src/services/gameService.js";
import { gameRepository } from "../src/repositories/gameRepository.js";
import { accountDeletion, UserService } from "../src/services/userService.js";

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

  test("a deletion stopped by a game starting meanwhile (IN_GAME) changes nothing, and a retry finishes it", async () => {
    const del = await createUser(app, "leaver");
    const friend = await createUser(app, "stayer");
    await app.pg.query(`UPDATE users SET "avatarUrl" = 'https://img.test/a.png' WHERE id = $1`, [del.id]);
    await app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [del.id, friend.id]);
    const game = await newGame(del.id, friend.id);
    await app.pg.query(`UPDATE games SET status = 'finished', result = 'draw' WHERE id = $1`, [game.id]);
    await app.pg.query(
      `INSERT INTO push_subscriptions ("userId", endpoint, p256dh, auth)
       VALUES ($1, 'https://fcm.googleapis.com/fcm/send/x', 'p', 'a')`,
      [del.id]
    );
    const snapshot = async () => ({
      user: (await app.pg.query(`SELECT "clerkId", email, username, "avatarUrl" FROM users WHERE id = $1`, [del.id]))
        .rows[0],
      game: (await app.pg.query(`SELECT "whiteUsername", "whiteAvatarUrl" FROM games WHERE id = $1`, [game.id])).rows[0],
      friends: (await app.pg.query(`SELECT count(*)::int AS n FROM friends`)).rows[0].n,
      pushes: (await app.pg.query(`SELECT count(*)::int AS n FROM push_subscriptions`)).rows[0].n,
    });
    const before = await snapshot();

    // No game before the deletion starts; one has started by the time its
    // transaction looks (under the user lock)
    const find = gameRepository.findActiveGameIdForUser;
    let calls = 0;
    gameRepository.findActiveGameIdForUser = async (db, userId) => (++calls === 2 ? 999_999 : find(db, userId));
    const remove = () =>
      app.inject({ method: "DELETE", url: "/api/users/me", headers: { authorization: `Bearer ${del.clerkId}` } });
    try {
      const res = await remove();
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().code, "IN_GAME");
    } finally {
      gameRepository.findActiveGameIdForUser = find;
    }
    assert.deepEqual(await snapshot(), before, "nothing changed, not even the names on past games");

    assert.equal((await remove()).statusCode, 204);
    const done = await snapshot();
    assert.deepEqual(done.user, { clerkId: null, email: null, username: `deleted-${del.id}`, avatarUrl: null });
    assert.deepEqual(done.game, { whiteUsername: `deleted-${del.id}`, whiteAvatarUrl: null });
    assert.equal(done.friends, 0);
    assert.equal(done.pushes, 0);
  });

  test("the deletion batches' cursor doesn't depend on the session time zone", async () => {
    const original = accountDeletion.batchSize;
    accountDeletion.batchSize = 1;
    const del = await createUser(app, "leaver");
    const friend = await createUser(app, "stayer");
    for (let i = 0; i < 3; i++) {
      const game = await newGame(del.id, friend.id);
      // All at one moment, so the second batch starts at the first one's cursor
      await app.pg.query(
        `UPDATE games SET status = 'finished', result = 'draw', "createdAt" = timestamptz '2026-01-01 12:00:00+00'
         WHERE id = $1`,
        [game.id]
      );
    }
    // Pooled connections needn't share a time zone: batches alternate
    // between one in UTC and one in Tokyo
    const utc = await app.pg.connect();
    const tokyo = await app.pg.connect();
    await utc.query(`SET TIME ZONE 'UTC'`);
    await tokyo.query(`SET TIME ZONE 'Asia/Tokyo'`);
    const pg = app.pg as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> };
    const query = pg.query;
    let n = 0;
    pg.query = (sql, params) =>
      sql.includes("WITH batch AS")
        ? (n++ % 2 === 0 ? utc : tokyo).query(sql, params)
        : query.call(app.pg, sql, params);
    try {
      await new UserService(app).deleteAccount(del.clerkId);
    } finally {
      pg.query = query;
      accountDeletion.batchSize = original;
      await utc.query(`RESET TIME ZONE`);
      await tokyo.query(`RESET TIME ZONE`);
      utc.release();
      tokyo.release();
    }
    const { rows } = await app.pg.query(`SELECT "whiteUsername" FROM games`);
    assert.deepEqual(
      rows.map((r) => r.whiteUsername),
      [`deleted-${del.id}`, `deleted-${del.id}`, `deleted-${del.id}`]
    );
  });

  test("deleting an account while a challenge to it is being accepted doesn't deadlock", async () => {
    const del = await createUser(app, "leaver");
    const friend = await createUser(app, "stayer");
    await app.pg.query(
      `INSERT INTO challenges ("challengerId", "challengedId", "challengerUsername", "time", increment)
       VALUES ($1, $2, 'leaver', 180, 0)`,
      [del.id, friend.id]
    );
    // What accepting does (ChallengeService.accept): clear the players' queue
    // rows, lock both players, then claim the challenge
    const accept = await app.pg.connect();
    try {
      await accept.query("BEGIN");
      await accept.query(`DELETE FROM matchmaking WHERE "userId" = ANY($1)`, [[del.id, friend.id]]);
      await accept.query(`SELECT 1 FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [[del.id, friend.id]]);
      const removal = fetch(`http://${baseUrl}/api/users/me`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${del.clerkId}` },
      });
      await new Promise((r) => setTimeout(r, 200));
      await accept.query(`DELETE FROM challenges WHERE "challengerId" = $1`, [del.id]);
      await accept.query("COMMIT");
      assert.equal((await removal).status, 204);
    } finally {
      accept.release();
    }
  });
});
