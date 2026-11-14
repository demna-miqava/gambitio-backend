import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import {
  connect,
  createUser,
  integrationEnabled,
  move,
  resetDb,
  startTestApp,
  type TestSocket,
} from "./helpers.js";
import { createGame } from "../src/services/gameService.js";

describe("spectating", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const sockets: TestSocket[] = [];

  const open = async (path: string, clerkId: string) => {
    const socket = await connect(baseUrl, path, clerkId);
    sockets.push(socket);
    return socket;
  };

  const newGame = (whiteId: number, blackId: number, time = 180) =>
    app.pg.transact((tx) => createGame(tx, { whiteId, blackId, time, increment: 0 }));

  const befriend = (userOneId: number, userTwoId: number) =>
    app.pg.query(
      `INSERT INTO friends ("userOneId", "userTwoId", "userOneUsername", "userTwoUsername")
       SELECT $1, $2, a.username, b.username FROM users a, users b WHERE a.id = $1 AND b.id = $2`,
      [userOneId, userTwoId]
    );

  const get = async (url: string, clerkId?: string) =>
    app.inject({ url, ...(clerkId && { headers: { authorization: `Bearer ${clerkId}` } }) });

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
  });

  test("a non-player can watch a game but not act in it", async () => {
    const white = await createUser(app, "whitey");
    const black = await createUser(app, "blacky");
    const watcher = await createUser(app, "watcher");
    const game = await newGame(white.id, black.id);

    const w = await open(`/game/${game.id}`, white.clerkId);
    const b = await open(`/game/${game.id}`, black.clerkId);
    await w.next("initial_game_state");
    await b.next("initial_game_state");

    w.send(move("e2e4"));
    await b.next("move", (m) => m.move.lan === "e2e4");
    // A draw offer is between the players
    w.send({ type: "draw_offer" });
    await b.next("draw_offer");

    // Joining mid-game: the current position, but not the pending offer
    const s = await open(`/game/${game.id}`, watcher.clerkId);
    const initial = await s.next("initial_game_state");
    assert.equal(initial.data.pgn.includes("e4"), true);
    assert.equal(initial.data.numMoves, 1);
    assert.equal(initial.data.status, "in_progress");
    assert.equal(initial.data.whitePlayer.id, white.id);
    assert.equal(initial.data.drawOfferedBy, null);
    assert.equal(initial.data.spectators, 1);
    // ...while the players still see it
    const bState = await open(`/game/${game.id}`, black.clerkId);
    assert.equal((await bState.next("initial_game_state")).data.drawOfferedBy, white.id);

    // Every kind of action is refused
    for (const message of [
      move("e7e5"),
      { type: "resign" },
      { type: "abort" },
      { type: "draw_offer" },
      { type: "draw_response", accepted: true },
      { type: "rematch_request" },
    ]) {
      s.send(message);
      const error = await s.next("error");
      assert.ok(["NOT_A_PLAYER", "GAME_IN_PROGRESS"].includes(error.data.code), JSON.stringify(error));
    }
    const { rows } = await app.pg.query(
      `SELECT "numMoves", status, "drawOfferedBy" FROM games WHERE id = $1`,
      [game.id]
    );
    assert.deepEqual(rows[0], { numMoves: 1, status: "in_progress", drawOfferedBy: white.id });

    // Moves and the result reach the spectator
    b.send(move("e7e5"));
    const seen = await s.next("move", (m) => m.move.lan === "e7e5");
    assert.equal(seen.userId, black.id);
    assert.equal(typeof seen.whiteTimeLeft, "number");

    // Player-only messages don't
    b.send({ type: "draw_offer" });
    await w.next("draw_offer");
    await s.none("draw_offer");

    b.send({ type: "resign" });
    const ended = await s.next("game_ended");
    assert.equal(ended.winnerId, white.id);
    assert.equal(ended.reason, "resignation");
    // Rematch offers stay between the players too
    w.send({ type: "rematch_request" });
    await b.next("rematch_request");
    await s.none("rematch_request");
    await s.none("match_found");
  });

  test("players see how many people are watching", async () => {
    const white = await createUser(app, "whitey");
    const black = await createUser(app, "blacky");
    const one = await createUser(app, "viewer_one");
    const two = await createUser(app, "viewer_two");
    const game = await newGame(white.id, black.id);

    const w = await open(`/game/${game.id}`, white.clerkId);
    assert.equal((await w.next("initial_game_state")).data.spectators, 0);

    const s1 = await open(`/game/${game.id}`, one.clerkId);
    await s1.next("initial_game_state");
    assert.equal((await w.next("spectators")).count, 1);

    // A second tab of the same viewer isn't a second viewer
    const s1b = await open(`/game/${game.id}`, one.clerkId);
    await s1b.next("initial_game_state");
    assert.equal((await w.next("spectators")).count, 1);

    const s2 = await open(`/game/${game.id}`, two.clerkId);
    await s2.next("initial_game_state");
    assert.equal((await w.next("spectators")).count, 2);

    // Players don't count
    const b = await open(`/game/${game.id}`, black.clerkId);
    assert.equal((await b.next("initial_game_state")).data.spectators, 2);
    await w.none("spectators");

    await s2.close();
    assert.equal((await w.next("spectators")).count, 1);
    await s1.close();
    assert.equal((await w.next("spectators")).count, 1);
    await s1b.close();
    assert.equal((await w.next("spectators")).count, 0);
  });

  test("friends' live games lists only friends' games in progress", async () => {
    const me = await createUser(app, "myself");
    const ann = await createUser(app, "annie", 1500); // friend (I'm userOne)
    const bob = await createUser(app, "bobby"); // friend (I'm userTwo)
    const cat = await createUser(app, "catty"); // friend, not playing
    const x = await createUser(app, "stranger_x");
    const y = await createUser(app, "stranger_y");
    const z = await createUser(app, "stranger_z");
    const q = await createUser(app, "stranger_q");
    await befriend(me.id, ann.id);
    await befriend(bob.id, me.id);
    await befriend(me.id, cat.id);
    await befriend(x.id, y.id); // someone else's friendship

    const annGame = await newGame(ann.id, x.id);
    const bobFinished = await newGame(y.id, bob.id);
    await app.pg.query(`UPDATE games SET status = 'finished', result = 'draw' WHERE id = $1`, [bobFinished.id]);
    const bobGame = await newGame(z.id, bob.id, 60);
    // Two strangers playing (y's earlier game is over)
    const strangerGame = await newGame(q.id, y.id);

    assert.equal((await get("/api/games/live/friends")).statusCode, 401);
    const res = await get("/api/games/live/friends", me.clerkId);
    assert.equal(res.statusCode, 200);
    const { data } = res.json();
    assert.deepEqual(
      data.map((g: any) => g.id),
      [bobGame.id, annGame.id] // newest first
    );
    const bobEntry = data[0];
    assert.equal(bobEntry.whitePlayer.username, "stranger_z");
    assert.equal(bobEntry.blackPlayer.id, bob.id);
    assert.equal(bobEntry.time, 60);
    assert.equal(bobEntry.type, "bullet");
    assert.ok(bobEntry.startedAt);
    assert.equal(data[1].whitePlayer.rating, 1500);

    // My own game with a friend isn't listed as something to watch
    const catGame = await newGame(me.id, cat.id);
    const mine = (await get("/api/games/live/friends", me.clerkId)).json().data.map((g: any) => g.id);
    assert.equal(mine.includes(catGame.id), false);

    // x's friend y is playing; x's own game (against ann) isn't listed
    assert.deepEqual(
      (await get("/api/games/live/friends", x.clerkId)).json().data.map((g: any) => g.id),
      [strangerGame.id]
    );
  });

  test("top live games are ordered by average rating", async () => {
    const players = await Promise.all(
      [1000, 1100, 2000, 2100, 1500, 1600, 2500, 2600].map((r, i) => createUser(app, `player${i}`, r))
    );
    const low = await newGame(players[0]!.id, players[1]!.id);
    const high = await newGame(players[2]!.id, players[3]!.id);
    const mid = await newGame(players[4]!.id, players[5]!.id);
    const best = await newGame(players[6]!.id, players[7]!.id);
    await app.pg.query(`UPDATE games SET status = 'finished', result = 'draw' WHERE id = $1`, [best.id]);
    const viewer = await createUser(app, "viewer");

    assert.equal((await get("/api/games/live/top")).statusCode, 401);
    const all = (await get("/api/games/live/top", viewer.clerkId)).json().data;
    assert.deepEqual(
      all.map((g: any) => g.id),
      [high.id, mid.id, low.id]
    );
    const top = (await get("/api/games/live/top?limit=2", viewer.clerkId)).json().data;
    assert.deepEqual(
      top.map((g: any) => g.id),
      [high.id, mid.id]
    );
    assert.equal((await get("/api/games/live/top?limit=0", viewer.clerkId)).statusCode, 400);
    assert.equal((await get("/api/games/live/top?limit=500", viewer.clerkId)).statusCode, 400);
  });
});
