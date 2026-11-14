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
import { challengeTimings } from "../src/services/challengeService.js";

describe("live games", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let white: { id: number; clerkId: string };
  let black: { id: number; clerkId: string };
  const sockets: TestSocket[] = [];

  const open = async (path: string, clerkId: string) => {
    const socket = await connect(baseUrl, path, clerkId);
    sockets.push(socket);
    return socket;
  };

  const newGame = (time = 180, increment = 0) =>
    app.pg.transact((tx) => createGame(tx, { whiteId: white.id, blackId: black.id, time, increment }));

  const joinGame = async (gameId: number) => {
    const w = await open(`/game/${gameId}`, white.clerkId);
    const b = await open(`/game/${gameId}`, black.clerkId);
    await w.next("initial_game_state");
    await b.next("initial_game_state");
    return { w, b };
  };

  const ratingOf = async (userId: number) =>
    (await app.pg.query(`SELECT "blitzRating" FROM users WHERE id = $1`, [userId])).rows[0].blitzRating;

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
    white = await createUser(app, "whitey");
    black = await createUser(app, "blacky");
  });

  test("checkmate is detected by the server and rated once", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);

    for (const [socket, uci] of [
      [w, "f2f3"],
      [b, "e7e5"],
      [w, "g2g4"],
      [b, "d8h4"],
    ] as const) {
      socket.send(move(uci));
      await w.next("move", (m) => m.move.lan === uci);
    }

    const ended = await w.next("game_ended");
    assert.equal(ended.reason, "checkmate");
    assert.equal(ended.winnerId, black.id);
    assert.equal(ended.ratingChanges.blackRatingChange, 8);
    await b.next("game_ended");

    // Ending again is a no-op
    w.send({ type: "resign" });
    assert.equal((await w.next("error")).data.code, "GAME_OVER");
    assert.equal(await ratingOf(black.id), 1208);
    assert.equal(await ratingOf(white.id), 1192);
  });

  test("stats require sign-in and refresh when a game ends", async () => {
    const url = `/api/users/${white.id}/stats/summary`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const get = async () =>
      (await app.inject({ url, headers: { authorization: `Bearer ${black.clerkId}` } })).json();

    assert.equal((await get()).numberOfGames, 0); // now cached
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    w.send({ type: "resign" });
    await b.next("game_ended");

    const after = await get();
    assert.equal(after.numberOfGames, 1);
    assert.equal(after.stats.blitz.losses, 1);
    assert.equal(after.stats.blitz.rating, 1192);
  });

  test("active game lookup returns the game in progress, then null", async () => {
    const get = async (clerkId: string) =>
      (await app.inject({ url: "/api/games/active", headers: { authorization: `Bearer ${clerkId}` } })).json();
    assert.equal((await app.inject({ url: "/api/games/active" })).statusCode, 401);

    const game = await newGame();
    assert.equal((await get(white.clerkId)).gameId, game.id);
    assert.equal((await get(black.clerkId)).gameId, game.id);

    const { w, b } = await joinGame(game.id);
    w.send({ type: "resign" });
    await b.next("game_ended");
    assert.equal((await get(white.clerkId)).gameId, null);
  });

  test("illegal, out-of-turn and non-player moves are rejected", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    const outsider = await createUser(app, "outsider");
    const o = await open(`/game/${game.id}`, outsider.clerkId);
    await o.next("initial_game_state");

    w.send(move("e2e5"));
    assert.equal((await w.next("move_rejected")).message, "Illegal move");

    b.send(move("e7e5"));
    assert.equal((await b.next("move_rejected")).message, "Not your turn");

    o.send(move("e2e4"));
    assert.equal((await o.next("error")).data.code, "NOT_A_PLAYER");
    o.send({ type: "resign" });
    assert.equal((await o.next("error")).data.code, "NOT_A_PLAYER");

    // Clients can no longer declare results
    w.send({ type: "checkmate", winnerId: white.id });
    assert.equal((await w.next("error")).data.code, "INVALID_MESSAGE");

    await w.none("move");
    const { rows } = await app.pg.query(`SELECT "numMoves", status FROM games WHERE id = $1`, [game.id]);
    assert.deepEqual(rows[0], { numMoves: 0, status: "in_progress" });

    // Spectators still see moves
    w.send(move("e2e4"));
    await o.next("move");
  });

  test("timeout is decided by the server clock, not by who reports it", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    for (const [socket, uci] of [
      [w, "e2e4"],
      [b, "e7e5"],
    ] as const) {
      socket.send(move(uci));
      await w.next("move", (m) => m.move.lan === uci);
    }

    // A premature claim does nothing
    b.send({ type: "timeout" });
    await w.none("game_ended");

    // White's clock runs out
    await app.pg.query(
      `UPDATE games SET "whiteTimeLeftMs" = 0, "deadlineAt" = now() - interval '1 second' WHERE id = $1`,
      [game.id]
    );
    // Both clients report it; the loser is white either way
    w.send({ type: "timeout" });
    b.send({ type: "timeout" });
    const ended = await b.next("game_ended");
    assert.equal(ended.reason, "timeout");
    assert.equal(ended.winnerId, black.id);
    await b.none("game_ended");
    assert.equal(await ratingOf(black.id), 1208);
  });

  test("a move that reaches the server just after its flag still counts (lag compensation)", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    for (const [socket, uci] of [
      [w, "e2e4"],
      [b, "e7e5"],
    ] as const) {
      socket.send(move(uci));
      await w.next("move", (m) => m.move.lan === uci);
    }

    // White had 2s; by the server's clock 2.3s have passed (the move was in
    // transit), but white's own clock ran 1.86s
    await app.pg.query(
      `UPDATE games SET "whiteTimeLeftMs" = 2000, "lastMoveAt" = now() - interval '2300 milliseconds',
         "deadlineAt" = now() + interval '700 milliseconds' WHERE id = $1`,
      [game.id]
    );
    w.send({ ...move("g1f3"), thinkMs: 1860 });
    const played = await b.next("move", (m) => m.move.lan === "g1f3");
    assert.ok(played.whiteTimeLeft > 0 && played.whiteTimeLeft <= 140, `white has ${played.whiteTimeLeft}ms`);

    // A client claiming to have thought 0ms is forgiven at most a second
    await app.pg.query(
      `UPDATE games SET "blackTimeLeftMs" = 2000, "lastMoveAt" = now() - interval '3500 milliseconds' WHERE id = $1`,
      [game.id]
    );
    b.send({ ...move("b8c6"), thinkMs: 0 });
    const ended = await w.next("game_ended");
    assert.equal(ended.reason, "timeout");
    assert.equal(ended.winnerId, white.id);
  });

  test("a player can give the opponent time, which moves their flag", async () => {
    const game = await newGame(60);
    const { w, b } = await joinGame(game.id);
    for (const [socket, uci] of [
      [w, "e2e4"],
      [b, "e7e5"],
    ] as const) {
      socket.send(move(uci));
      await w.next("move", (m) => m.move.lan === uci);
    }

    // White to move with 2s left; black gives 10s twice
    await app.pg.query(
      `UPDATE games SET "whiteTimeLeftMs" = 2000, "lastMoveAt" = now(),
         "deadlineAt" = now() + interval '3 seconds' WHERE id = $1`,
      [game.id]
    );
    b.send({ type: "give_time" });
    const first = await w.next("time_added");
    assert.equal(first.color, "white");
    assert.equal(first.userId, black.id);
    assert.equal(first.addedMs, 10_000);
    assert.ok(first.whiteTimeLeft > 11_000 && first.whiteTimeLeft <= 12_000, `white has ${first.whiteTimeLeft}ms`);
    assert.equal(first.blackTimeLeft, 60_000);
    b.send({ type: "give_time" });
    const second = await b.next("time_added", (m) => m.whiteTimeLeft > 20_000);
    assert.ok(second.whiteTimeLeft <= 22_000);

    const { rows } = await app.pg.query(
      `SELECT "whiteTimeLeftMs", "deadlineAt" > now() + interval '20 seconds' AS later FROM games WHERE id = $1`,
      [game.id]
    );
    assert.deepEqual(rows[0], { whiteTimeLeftMs: 22_000, later: true });

    // A spectator can't give time
    const o = await open(`/game/${game.id}`, (await createUser(app, "onlooker")).clerkId);
    await o.next("initial_game_state");
    o.send({ type: "give_time" });
    const error = await o.next("error");
    assert.equal(error.data.code, "NOT_A_PLAYER");
  });

  test("given time can't save a flag that has already fallen", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    for (const [socket, uci] of [
      [w, "e2e4"],
      [b, "e7e5"],
    ] as const) {
      socket.send(move(uci));
      await w.next("move", (m) => m.move.lan === uci);
    }
    await app.pg.query(
      `UPDATE games SET "whiteTimeLeftMs" = 0, "deadlineAt" = now() - interval '1 second' WHERE id = $1`,
      [game.id]
    );
    b.send({ type: "give_time" });
    const ended = await w.next("game_ended");
    assert.equal(ended.reason, "timeout");
    assert.equal(ended.winnerId, black.id);
    await w.none("time_added");
  });

  test("sweeper aborts a game whose first move never comes, without rating changes", async () => {
    const game = await newGame();
    const { w } = await joinGame(game.id);
    await app.pg.query(`UPDATE games SET "deadlineAt" = now() - interval '1 second' WHERE id = $1`, [
      game.id,
    ]);
    await app.jobs.runClockSweep();
    const ended = await w.next("game_ended");
    assert.equal(ended.reason, "aborted");
    assert.equal(await ratingOf(white.id), 1200);
  });

  test("a player can't accept their own draw offer", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);

    w.send({ type: "draw_offer" });
    await b.next("draw_offer");
    w.send({ type: "draw_response", accepted: true });
    assert.equal((await w.next("error")).data.code, "NO_DRAW_OFFER");

    b.send({ type: "draw_response", accepted: true });
    const ended = await w.next("game_ended");
    assert.equal(ended.reason, "draw_agreement");
  });

  test("moving declines a pending draw offer", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    w.send(move("e2e4"));
    await b.next("move");
    w.send({ type: "draw_offer" });
    await b.next("draw_offer");
    b.send(move("e7e5"));
    await w.next("move");
    b.send({ type: "draw_response", accepted: true });
    assert.equal((await b.next("error")).data.code, "NO_DRAW_OFFER");
  });

  test("abort is only allowed before both players have moved", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    w.send(move("e2e4"));
    await b.next("move");
    b.send(move("e7e5"));
    await w.next("move");
    w.send({ type: "abort" });
    assert.equal((await w.next("error")).data.code, "ABORT_NOT_ALLOWED");
  });

  test("closing a second tab doesn't disconnect the first", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    const secondTab = await open(`/game/${game.id}`, white.clerkId);
    await secondTab.next("initial_game_state");
    await secondTab.close();
    await new Promise((r) => setTimeout(r, 100));

    b.send(move("e2e4")); // wrong side, ignore result
    w.send(move("e2e4"));
    await w.next("move");
  });

  test("rematch swaps colors and creates exactly one game", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    w.send({ type: "resign" });
    await b.next("game_ended");

    w.send({ type: "rematch_request" });
    await b.next("rematch_request");
    b.send({ type: "rematch_response", data: { accepted: true } });
    const forWhite = await w.next("match_found");
    const forBlack = await b.next("match_found");
    assert.equal(forWhite.data.gameId, forBlack.data.gameId);
    assert.equal(forWhite.data.color, "black");
    assert.equal(forBlack.data.color, "white");

    b.send({ type: "rematch_response", data: { accepted: true } });
    assert.equal((await b.next("error")).data.code, "NO_REMATCH_OFFER");
    const { rows } = await app.pg.query(`SELECT count(*)::int AS n FROM games`);
    assert.equal(rows[0].n, 2);
  });
});

describe("matchmaking and challenges", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const sockets: TestSocket[] = [];
  const open = async (path: string, clerkId: string) => {
    const socket = await connect(baseUrl, path, clerkId);
    sockets.push(socket);
    return socket;
  };

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

  test("two players joining at once are paired into one game", async () => {
    const a = await createUser(app, "alice", 1200);
    const b = await createUser(app, "bobby", 1230);
    const [sa, sb] = await Promise.all([
      open("/matchmaking?time=180&increment=2", a.clerkId),
      open("/matchmaking?time=180&increment=2", b.clerkId),
    ]);
    // If both searched before the other was queued, the sweeper pairs them
    await new Promise((r) => setTimeout(r, 200));
    await app.matchmaking.sweep();

    const [ma, mb] = await Promise.all([sa.next("match_found"), sb.next("match_found")]);
    assert.equal(ma.data.gameId, mb.data.gameId);
    assert.notEqual(ma.data.color, mb.data.color);
    assert.equal(ma.data.increment, 2);
    const { rows } = await app.pg.query(`SELECT count(*)::int AS n FROM matchmaking`);
    assert.equal(rows[0].n, 0);
  });

  test("a waiting player is claimed by only one opponent", async () => {
    const waiting = await createUser(app, "waiter");
    const s1 = await open("/matchmaking?time=60&increment=0", waiting.clerkId);
    await s1.next("searching");

    const c1 = await createUser(app, "chaser1");
    const c2 = await createUser(app, "chaser2");
    await Promise.all([
      open("/matchmaking?time=60&increment=0", c1.clerkId),
      open("/matchmaking?time=60&increment=0", c2.clerkId),
    ]);
    await s1.next("match_found");
    await new Promise((r) => setTimeout(r, 200));
    const { rows } = await app.pg.query(
      `SELECT count(*)::int AS n FROM games WHERE "whiteId" = $1 OR "blackId" = $1`,
      [waiting.id]
    );
    assert.equal(rows[0].n, 1);
  });

  test("rejects invalid time controls", async () => {
    const a = await createUser(app, "alice");
    const s = await open("/matchmaking?time=-5&increment=null", a.clerkId);
    assert.equal((await s.next("error")).data.code, "INVALID_TIME_CONTROL");
  });

  const befriend = (a: { id: number }, b: { id: number }) =>
    app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [a.id, b.id]);

  test("WebSocket upgrades with a bad token are refused before connecting", async () => {
    await assert.rejects(connect(baseUrl, "/notifications", "clerk_nobody"), /403/);
    await assert.rejects(connect(baseUrl, "/notifications", ""), /401/);
  });

  test("only friends can be challenged", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    const na = await open("/notifications", a.clerkId);
    await open("/notifications", b.clerkId);
    na.send({ type: "challenge_sent", data: { challengedId: b.id, color: "white", time: 300, increment: 0 } });
    assert.equal((await na.next("error")).data.code, "NOT_FRIENDS");
  });

  test("a challenge can only be accepted once", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    await befriend(a, b);
    const na = await open("/notifications", a.clerkId);
    const nb = await open("/notifications", b.clerkId);
    await new Promise((r) => setTimeout(r, 100));

    na.send({
      type: "challenge_sent",
      data: { challengedId: b.id, color: "white", time: 300, increment: 0 },
    });
    const received = await nb.next("challenge_received");
    assert.equal(received.data.color, "black");

    // Sending again replaces the open challenge
    na.send({
      type: "challenge_sent",
      data: { challengedId: b.id, color: "white", time: 300, increment: 0 },
    });
    assert.equal((await nb.next("challenge_received")).data.id, received.data.id);

    nb.send({ type: "challenge_accepted", data: { challengerId: a.id } });
    nb.send({ type: "challenge_accepted", data: { challengerId: a.id } });
    const created = await na.next("match_created");
    assert.equal(created.data.color, "white");
    assert.equal((await nb.next("error")).data.code, "CHALLENGE_NOT_FOUND");
    const { rows } = await app.pg.query(`SELECT count(*)::int AS n FROM games`);
    assert.equal(rows[0].n, 1);
  });

  const challenge = (socket: TestSocket, challengedId: number) =>
    socket.send({ type: "challenge_sent", data: { challengedId, color: "white", time: 300, increment: 0 } });

  test("challenges carry the rating; cancel and decline tell the other side", async () => {
    const a = await createUser(app, "alice", 1234);
    const b = await createUser(app, "bobby");
    await befriend(a, b);
    const na = await open("/notifications", a.clerkId);
    const nb = await open("/notifications", b.clerkId);
    await new Promise((r) => setTimeout(r, 100));

    challenge(na, b.id);
    assert.equal((await nb.next("challenge_received")).data.rating, 1234);
    const list = (
      await app.inject({ url: "/api/challenges", headers: { authorization: `Bearer ${b.clerkId}` } })
    ).json();
    assert.equal(list.challenges[0].rating, 1234);

    const sent = async () =>
      (
        await app.inject({ url: "/api/challenges/sent", headers: { authorization: `Bearer ${a.clerkId}` } })
      ).json().challenge;
    assert.equal((await sent()).username, "bobby");

    na.send({ type: "challenge_cancelled", data: { challengedId: b.id } });
    assert.equal((await nb.next("challenge_cancelled")).data.challengerId, a.id);
    assert.equal(await sent(), null);

    challenge(na, b.id);
    await nb.next("challenge_received");
    nb.send({ type: "challenge_declined", data: { challengerId: a.id } });
    assert.equal((await na.next("challenge_declined")).data.challengedId, b.id);
    // The decliner's own tabs hear about it too
    assert.equal((await nb.next("challenge_cancelled")).data.reason, "declined");
  });

  test("challenges are withdrawn when the sender goes offline or they expire", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    await befriend(a, b);
    const na = await open("/notifications", a.clerkId);
    const nb = await open("/notifications", b.clerkId);
    await new Promise((r) => setTimeout(r, 100));

    challengeTimings.offlineGraceMs = 300;
    // A quick reconnect (e.g. a reload) keeps the challenge
    challenge(na, b.id);
    await nb.next("challenge_received");
    await na.close();
    const back = await open("/notifications", a.clerkId);
    await new Promise((r) => setTimeout(r, 500));
    const { rows: kept } = await app.pg.query(`SELECT count(*)::int AS n FROM challenges`);
    assert.equal(kept[0].n, 1);

    // Staying away withdraws it
    await back.close();
    assert.equal((await nb.next("challenge_cancelled")).data.challengerId, a.id);
    // The sender's "offline" notice goes out just after; let it pass before
    // reconnecting, or the new socket may hear it
    await new Promise((r) => setTimeout(r, 100));

    const na2 = await open("/notifications", a.clerkId);
    await new Promise((r) => setTimeout(r, 100));
    challenge(na2, b.id);
    await nb.next("challenge_received");
    await app.challenges.expireStale(new Date(Date.now() + 11 * 60_000));
    assert.equal((await nb.next("challenge_cancelled")).data.challengerId, a.id);
    assert.equal((await na2.next("challenge_declined")).data.reason, "expired");
    const { rows } = await app.pg.query(`SELECT count(*)::int AS n FROM challenges`);
    assert.equal(rows[0].n, 0);
  });

  test("challenge input is validated", async () => {
    const a = await createUser(app, "alice");
    const na = await open("/notifications", a.clerkId);
    na.send({ type: "challenge_sent", data: { challengedId: a.id, color: "white", time: 300, increment: 0 } });
    assert.equal((await na.next("error")).data.code, "SELF_CHALLENGE");
    na.send({ type: "challenge_sent", data: { challengedId: 99, color: "purple", time: -1, increment: 0 } });
    assert.equal((await na.next("error")).data.code, "INVALID_MESSAGE");
  });
});
