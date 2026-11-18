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
import { createGame, finishGame } from "../src/services/gameService.js";
import { gameRepository } from "../src/repositories/gameRepository.js";
import { challengeTimings } from "../src/services/challengeService.js";
import { rateGame } from "../src/utils/ratingHelpers.js";

/**
 * What the first rated game between two brand-new 1200 players moves their
 * ratings by (createUser's defaults; neither has a rated game yet).
 */
const FIRST_GAME = (() => {
  const fresh = { rating: 1200, rd: 350, volatility: 0.06, ratedAt: null };
  const { white: loser, black: winner } = rateGame(fresh, fresh, "black_win", new Date());
  return { win: winner.rating - 1200, loss: loser.rating - 1200 };
})();

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
    assert.ok(FIRST_GAME.win > 100, "a first game moves a rating a lot");
    assert.equal(ended.ratingChanges.blackRatingChange, FIRST_GAME.win);
    assert.equal(ended.ratingChanges.whiteRatingChange, FIRST_GAME.loss);
    await b.next("game_ended");

    // Ending again is a no-op
    w.send({ type: "resign" });
    assert.equal((await w.next("error")).data.code, "GAME_OVER");
    assert.equal(await ratingOf(black.id), 1200 + FIRST_GAME.win);
    assert.equal(await ratingOf(white.id), 1200 + FIRST_GAME.loss);
  });

  test("a rated game settles both ratings a little: deviation, last-rated time, provisional flags", async () => {
    const rating = async (userId: number) =>
      (
        await app.pg.query(
          `SELECT "blitzRd", "blitzVolatility", "blitzRatedAt", "rapidRd", "rapidRatedAt" FROM users WHERE id = $1`,
          [userId]
        )
      ).rows[0];
    const profile = async () =>
      (await app.inject({ url: `/api/users/${white.id}`, headers: { authorization: `Bearer ${black.clerkId}` } })).json()
        .user;
    assert.deepEqual(await rating(white.id), {
      blitzRd: 350,
      blitzVolatility: 0.06,
      blitzRatedAt: null,
      rapidRd: 350,
      rapidRatedAt: null,
    });
    assert.equal((await profile()).blitzProvisional, true);

    // The game records that both ratings were provisional when it started
    const first = await newGame();
    assert.equal(first.whiteProvisional, true);
    assert.equal(first.blackProvisional, true);
    const w = await open(`/game/${first.id}`, white.clerkId);
    const b = await open(`/game/${first.id}`, black.clerkId);
    assert.equal((await w.next("initial_game_state")).data.whitePlayer.provisional, true);
    await b.next("initial_game_state");
    const startedAt = Date.now();
    w.send({ type: "resign" });
    await b.next("game_ended");

    for (const player of [white, black]) {
      const after = await rating(player.id);
      assert.ok(after.blitzRd < 350 && after.blitzRd > 200, `deviation ${after.blitzRd}`);
      assert.ok(after.blitzRatedAt.getTime() >= startedAt - 1_000);
      // Another time control is its own rating
      assert.equal(after.rapidRd, 350);
      assert.equal(after.rapidRatedAt, null);
    }
    const stored = (await app.inject({ url: `/api/games/${first.id}`, headers: { authorization: `Bearer ${black.clerkId}` } })).json();
    assert.equal(stored.whitePlayer.provisional, true);

    // A settled rating isn't provisional, and barely moves against a newcomer
    await app.pg.query(`UPDATE users SET "blitzRd" = 60, "blitzRating" = 1200 WHERE id = $1`, [white.id]);
    assert.equal((await profile()).blitzProvisional, false);
    assert.equal((await profile()).rapidProvisional, true);
    await app.pg.query(`UPDATE users SET "blitzRd" = 350, "blitzRating" = 1200 WHERE id = $1`, [black.id]);
    const second = await newGame();
    assert.equal(second.whiteProvisional, false);
    assert.equal(second.blackProvisional, true);
    const sockets2 = await joinGame(second.id);
    sockets2.w.send({ type: "resign" });
    const ended = await sockets2.b.next("game_ended");
    assert.ok(ended.ratingChanges.blackRatingChange > 100);
    assert.ok(ended.ratingChanges.whiteRatingChange < 0 && ended.ratingChanges.whiteRatingChange > -15);

    // Long without a rated game: provisional again
    await app.pg.query(
      `UPDATE users SET "blitzRd" = 60, "blitzRatedAt" = now() - interval '3 years' WHERE id = $1`,
      [white.id]
    );
    assert.equal((await profile()).blitzProvisional, true);
  });

  test("a game's end updates both players in one go, and only what it should", async () => {
    const row = async (userId: number) =>
      (
        await app.pg.query(
          `SELECT "blitzRating", "highestBlitzRating", "blitzGames", "listedGames" FROM users WHERE id = $1`,
          [userId]
        )
      ).rows[0];
    const end = (game: Awaited<ReturnType<typeof newGame>>, outcome: Parameters<typeof finishGame>[2]) =>
      app.pg.transact(async (tx) => {
        const locked = await gameRepository.lockById(tx, game.id);
        return finishGame(tx, locked as typeof game, outcome, null);
      });

    // Rated: ratings, peaks and both counters, with the floor applied to the
    // reported change
    await app.pg.query(`UPDATE users SET "blitzRating" = 100, "highestBlitzRating" = 100 WHERE id = $1`, [
      white.id,
    ]);
    const rated = await newGame();
    const finished = await end(rated, { result: "black_win", reason: "resignation" });
    assert.ok(finished?.ratingChanges);
    assert.equal(finished.ratingChanges.whiteNewRating, 100);
    assert.equal(finished.ratingChanges.whiteRatingChange, 0);
    assert.equal(finished.ratingChanges.blackNewRating, 1200 + finished.ratingChanges.blackRatingChange);
    assert.deepEqual(await row(white.id), {
      blitzRating: 100,
      highestBlitzRating: 100,
      blitzGames: 1,
      listedGames: 1,
    });
    const blackAfter = await row(black.id);
    assert.equal(blackAfter.blitzGames, 1);
    assert.equal(blackAfter.listedGames, 1);
    assert.equal(blackAfter.highestBlitzRating, blackAfter.blitzRating);

    // Aborted: nothing
    const aborted = await newGame();
    await end(aborted, { result: "aborted", reason: "aborted" });
    assert.equal((await row(white.id)).listedGames, 1);

    // Unrated (time odds): listed in the history, nothing else
    const odds = await app.pg.transact((tx) =>
      createGame(tx, {
        whiteId: white.id,
        blackId: black.id,
        time: 300,
        increment: 0,
        odds: { whiteTime: 300, blackTime: 60 },
      })
    );
    const unrated = await end(odds, { result: "draw", reason: "draw_agreement" });
    assert.equal(unrated?.ratingChanges, null);
    assert.deepEqual(await row(white.id), {
      blitzRating: 100,
      highestBlitzRating: 100,
      blitzGames: 1,
      listedGames: 2,
    });
    assert.equal((await row(black.id)).listedGames, 2);
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
    assert.equal(after.stats.blitz.rating, 1200 + FIRST_GAME.loss);
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
    assert.equal(await ratingOf(black.id), 1200 + FIRST_GAME.win);
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

  /** Plays `ucis` from ply `from`, white's moves on `w`, waiting until each is played. */
  const play = async ({ w, b }: { w: TestSocket; b: TestSocket }, ucis: string[], from = 0) => {
    for (const [i, uci] of ucis.entries()) {
      const ply = from + i;
      (ply % 2 === 0 ? w : b).send(move(uci));
      await w.next("move", (m) => m.move.lan === uci && m.moveNumber === ply + 1);
    }
  };
  const storedGame = async (gameId: number) =>
    (
      await app.pg.query(
        `SELECT "numMoves", pgn, "takebackRequestedBy", "takebackDeclinedFor", "drawOfferedBy"
         FROM games WHERE id = $1`,
        [gameId]
      )
    ).rows[0];
  const stateOf = async (gameId: number, clerkId: string) =>
    (await (await open(`/game/${gameId}`, clerkId)).next("initial_game_state")).data;

  test("a takeback on the requester's turn undoes their move and the reply", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    const watcher = await createUser(app, "watcher");
    const s = await open(`/game/${game.id}`, watcher.clerkId);
    await s.next("initial_game_state");
    await play({ w, b }, ["e2e4", "e7e5", "g1f3", "b8c6"]);

    w.send({ type: "takeback_request" });
    await b.next("takeback_request");
    await w.none("takeback_request");
    await s.none("takeback_request");
    // The pending request is between the players
    assert.equal((await stateOf(game.id, black.clerkId)).takebackRequestedBy, white.id);
    assert.equal((await stateOf(game.id, white.clerkId)).takebackRequestedBy, white.id);
    assert.equal((await stateOf(game.id, watcher.clerkId)).takebackRequestedBy, null);
    // Asking again while pending changes nothing
    w.send({ type: "takeback_request" });
    await b.none("takeback_request");

    b.send({ type: "takeback_response", accepted: true });
    const taken = await w.next("takeback");
    assert.equal(taken.moveNumber, 2);
    assert.equal(taken.fen, "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
    assert.ok(taken.pgn.endsWith("\n\n1. e4 e5 *"), taken.pgn);
    assert.equal(taken.clockRunning, true);
    assert.equal(typeof taken.whiteTimeLeft, "number");
    assert.deepEqual(await b.next("takeback"), taken);
    assert.deepEqual(await s.next("takeback"), taken);
    assert.deepEqual(await storedGame(game.id), {
      numMoves: 2,
      pgn: taken.pgn,
      takebackRequestedBy: null,
      takebackDeclinedFor: null,
      drawOfferedBy: null,
    });

    // The game goes on from the restored position: Nf3 is legal again
    await play({ w, b }, ["g1f3", "g8f6"], 2);
    assert.equal((await stateOf(game.id, white.clerkId)).numMoves, 4);
  });

  test("a takeback on the opponent's turn undoes only the requester's move", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    await play({ w, b }, ["e2e4", "e7e5", "g1f3"]);
    w.send({ type: "draw_offer" });
    await b.next("draw_offer");

    w.send({ type: "takeback_request" });
    await b.next("takeback_request");
    b.send({ type: "takeback_response", accepted: true });
    const taken = await w.next("takeback");
    assert.equal(taken.moveNumber, 2);
    assert.ok(taken.pgn.endsWith("1. e4 e5 *"), taken.pgn);
    // A pending draw offer lapses with the position it was made in
    assert.equal((await storedGame(game.id)).drawOfferedBy, null);

    // White is to move again
    b.send(move("b8c6"));
    assert.equal((await b.next("move_rejected")).message, "Not your turn");
    await play({ w, b }, ["d2d4"], 2);
  });

  test("a takeback can't go back before both players have moved", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    const refused = async (socket: TestSocket) => {
      socket.send({ type: "takeback_request" });
      assert.equal((await socket.next("error")).data.code, "TAKEBACK_NOT_ALLOWED");
    };

    await refused(w); // nothing played
    await play({ w, b }, ["e2e4"]);
    await refused(w);
    await refused(b); // hasn't moved
    await play({ w, b }, ["e7e5"], 1);
    await refused(w);
    await refused(b);
    await play({ w, b }, ["g1f3"], 2);
    await refused(b); // would undo black's first move
    await w.none("takeback_request");
    await b.none("takeback_request");
    assert.equal((await storedGame(game.id)).takebackRequestedBy, null);

    // Answering a request nobody made
    b.send({ type: "takeback_response", accepted: true });
    assert.equal((await b.next("error")).data.code, "NO_TAKEBACK_REQUEST");
    // From here white can ask
    w.send({ type: "takeback_request" });
    await b.next("takeback_request");
    // ...but can't answer their own request
    w.send({ type: "takeback_response", accepted: true });
    assert.equal((await w.next("error")).data.code, "NO_TAKEBACK_REQUEST");
  });

  test("a declined takeback can't be asked for again until a move is made", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    await play({ w, b }, ["e2e4", "e7e5", "g1f3"]);

    w.send({ type: "takeback_request" });
    await b.next("takeback_request");
    b.send({ type: "takeback_response", accepted: false });
    assert.deepEqual(await w.next("takeback_response"), { type: "takeback_response", accepted: false });
    await b.none("takeback_response");
    assert.equal((await storedGame(game.id)).takebackDeclinedFor, white.id);
    assert.equal((await stateOf(game.id, black.clerkId)).takebackRequestedBy, null);

    w.send({ type: "takeback_request" });
    assert.equal((await w.next("error")).data.code, "TAKEBACK_DECLINED");
    await b.none("takeback_request");

    // A move lifts the block
    await play({ w, b }, ["b8c6"], 3);
    assert.equal((await storedGame(game.id)).takebackDeclinedFor, null);
    w.send({ type: "takeback_request" });
    await b.next("takeback_request");
  });

  test("a move clears a pending takeback request", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    await play({ w, b }, ["e2e4", "e7e5", "g1f3", "b8c6"]);

    // White asks, then plays on instead
    w.send({ type: "takeback_request" });
    await b.next("takeback_request");
    await play({ w, b }, ["f1c4"], 4);
    assert.equal((await storedGame(game.id)).takebackRequestedBy, null);
    assert.equal((await stateOf(game.id, black.clerkId)).takebackRequestedBy, null);
    b.send({ type: "takeback_response", accepted: true });
    assert.equal((await b.next("error")).data.code, "NO_TAKEBACK_REQUEST");
    await w.none("takeback");

    // The end of the game clears one too
    w.send({ type: "takeback_request" });
    await b.next("takeback_request");
    b.send({ type: "resign" });
    await w.next("game_ended");
    assert.equal((await storedGame(game.id)).takebackRequestedBy, null);
    b.send({ type: "takeback_response", accepted: true });
    assert.equal((await b.next("error")).data.code, "GAME_OVER");
  });

  test("both players asking for a takeback means both agree", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    await play({ w, b }, ["e2e4", "e7e5", "g1f3", "b8c6"]);

    w.send({ type: "takeback_request" });
    await b.next("takeback_request");
    b.send({ type: "takeback_request" });
    // White's request is the one granted: back to white's move
    const taken = await b.next("takeback");
    assert.equal(taken.moveNumber, 2);
    await w.next("takeback");
    await w.none("takeback_request");
    assert.equal((await storedGame(game.id)).takebackRequestedBy, null);
  });

  test("after a takeback the clock runs for the side to move, with the time they had left", async () => {
    const game = await newGame(60, 2);
    const { w, b } = await joinGame(game.id);
    await play({ w, b }, ["e2e4", "e7e5", "g1f3"]);

    // Black to move, thinking for 5s so far
    await app.pg.query(
      `UPDATE games SET "whiteTimeLeftMs" = 50000, "blackTimeLeftMs" = 40000,
         "lastMoveAt" = now() - interval '5 seconds', "deadlineAt" = now() + interval '36 seconds'
       WHERE id = $1`,
      [game.id]
    );
    w.send({ type: "takeback_request" });
    await b.next("takeback_request");
    b.send({ type: "takeback_response", accepted: true });
    const taken = await w.next("takeback");
    assert.equal(taken.moveNumber, 2);
    assert.equal(taken.clockRunning, true);
    // Black is charged the 5s; white's time stays (no increment back or again)
    assert.equal(taken.whiteTimeLeft, 50_000);
    assert.ok(taken.blackTimeLeft > 34_000 && taken.blackTimeLeft <= 35_000, `black has ${taken.blackTimeLeft}ms`);

    // Now white's clock runs from the takeback, and their flag is the deadline
    const { rows } = await app.pg.query(
      `SELECT "whiteTimeLeftMs", "blackTimeLeftMs",
         extract(epoch FROM now() - "lastMoveAt") * 1000 AS "sinceTakeback",
         extract(epoch FROM "deadlineAt" - "lastMoveAt") * 1000 AS "deadlineIn"
       FROM games WHERE id = $1`,
      [game.id]
    );
    assert.equal(rows[0].whiteTimeLeftMs, 50_000);
    assert.equal(rows[0].blackTimeLeftMs, taken.blackTimeLeft);
    assert.ok(Number(rows[0].sinceTakeback) < 1_000, `${rows[0].sinceTakeback}ms since the takeback`);
    assert.equal(Math.round(Number(rows[0].deadlineIn)), 50_000 + 1_000); // + MAX_LAG_COMPENSATION_MS
    const state = await stateOf(game.id, white.clerkId);
    assert.ok(state.whiteTimeLeft <= 50_000 && state.whiteTimeLeft > 49_000);
    assert.equal(state.blackTimeLeft, taken.blackTimeLeft);

    // White's next move is charged from the takeback and gets the increment
    w.send(move("g1f3"));
    // On w: play() already took w's earlier move 3, b still has it
    const played = await w.next("move", (m) => m.moveNumber === 3);
    assert.ok(played.whiteTimeLeft > 51_000 && played.whiteTimeLeft <= 52_000, `white has ${played.whiteTimeLeft}ms`);
  });

  test("a move made for a position a takeback has since replaced is rejected", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    await play({ w, b }, ["e2e4", "e7e5", "g1f3", "b8c6"]);

    // White asks on their own turn (back to ply 2), black accepts...
    w.send({ type: "takeback_request" });
    await b.next("takeback_request");
    b.send({ type: "takeback_response", accepted: true });
    await w.next("takeback");
    // ...while white, still seeing ply 4, plays Bc4: legal at ply 2 too, but
    // meant for another position
    w.send({ ...move("f1c4"), ply: 4 });
    const rejected = await w.next("move_rejected");
    assert.equal(rejected.message, "The position changed");
    assert.ok(rejected.pgn.endsWith("1. e4 e5 *"), rejected.pgn);
    assert.equal((await storedGame(game.id)).numMoves, 2);

    // Resynced, the same move for the right position is played
    w.send({ ...move("f1c4"), ply: 2 });
    assert.equal((await w.next("move")).moveNumber, 3);
    // A client that doesn't say which position it means is trusted as before
    b.send(move("g8f6"));
    assert.equal((await b.next("move", (m) => m.moveNumber === 4)).moveNumber, 4);
  });

  test("a takeback can't save a flag that has already fallen", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    await play({ w, b }, ["e2e4", "e7e5", "g1f3"]);
    w.send({ type: "takeback_request" });
    await b.next("takeback_request");
    // Black's clock runs out, within the lag allowance (deadline not reached)
    await app.pg.query(
      `UPDATE games SET "blackTimeLeftMs" = 1000, "lastMoveAt" = now() - interval '1500 milliseconds',
         "deadlineAt" = now() + interval '500 milliseconds' WHERE id = $1`,
      [game.id]
    );
    b.send({ type: "takeback_response", accepted: true });
    const ended = await w.next("game_ended");
    assert.equal(ended.reason, "timeout");
    assert.equal(ended.winnerId, white.id);
    await w.none("takeback");
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

  /** A queue row with no socket behind it, as an instance that crashed leaves them */
  const leftover = async (userId: number, ageSeconds: number, rating = 1200) =>
    app.pg.query(
      `INSERT INTO matchmaking ("userId", rating, time, increment, "createdAt")
       VALUES ($1, $2, 60, 0, now() - make_interval(secs => $3))`,
      [userId, rating, ageSeconds]
    );
  const queued = async () =>
    (await app.pg.query<{ userId: number }>(`SELECT "userId" FROM matchmaking ORDER BY id`)).rows.map(
      (r) => r.userId
    );

  test("a player who isn't searching any more is never paired, and leaves the queue", async () => {
    const ghost = await createUser(app, "ghost");
    await leftover(ghost.id, 30);
    const a = await createUser(app, "alice");
    const sa = await open("/matchmaking?time=60&increment=0", a.clerkId);
    await sa.next("searching");
    await sa.none("match_found");
    // Joining found the ghost, saw nobody behind it, and dropped it
    assert.deepEqual(await queued(), [a.id]);
    assert.equal((await app.pg.query(`SELECT 1 FROM games`)).rowCount, 0);

    // The next real player is paired
    const b = await createUser(app, "bobby");
    const sb = await open("/matchmaking?time=60&increment=0", b.clerkId);
    await Promise.all([sa.next("match_found"), sb.next("match_found")]);
  });

  test("the sweep pairs entries that have someone to play, and drops gone opponents", async () => {
    const a = await createUser(app, "alice", 1200);
    const b = await createUser(app, "bobby", 1900);
    const c = await createUser(app, "carol", 2600);
    const ghost = await createUser(app, "ghost", 2600);
    const sa = await open("/matchmaking?time=60&increment=0", a.clerkId);
    await sa.next("searching");
    const sb = await open("/matchmaking?time=60&increment=0", b.clerkId);
    await sb.next("searching");
    const sc = await open("/matchmaking?time=60&increment=0", c.clerkId);
    await sc.next("searching");
    assert.deepEqual(await queued(), [a.id, b.id, c.id]);

    // Bobby's window reaches Alice now (as after a long wait), and a ghost
    // entry appears next to Carol
    await app.pg.query(`UPDATE matchmaking SET rating = 1240 WHERE "userId" = $1`, [b.id]);
    await leftover(ghost.id, 0, 2610);
    await app.matchmaking.sweep();
    await Promise.all([sa.next("match_found"), sb.next("match_found")]);
    // Carol's only candidate was the ghost: it is gone, she keeps waiting
    assert.deepEqual(await queued(), [c.id]);
    await sc.none("match_found");
  });

  test("leftover queue entries are removed at startup, live searchers keep theirs", async () => {
    const ghost = await createUser(app, "ghost");
    const fresh = await createUser(app, "fresh");
    const a = await createUser(app, "alice", 2500);
    const sa = await open("/matchmaking?time=60&increment=0", a.clerkId);
    await sa.next("searching");
    await app.pg.query(`UPDATE matchmaking SET "createdAt" = now() - interval '1 minute'`);
    await leftover(ghost.id, 60, 800);
    // Too new to tell: its socket may still be connecting
    await leftover(fresh.id, 0, 1600);
    await app.matchmaking.removeLeftovers();
    assert.deepEqual(await queued(), [a.id, fresh.id]);
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

  const allowChallengesFrom = (user: { id: number }, from: "everyone" | "only_friends" | "nobody") =>
    app.pg.query(
      `INSERT INTO user_settings ("userId", "challengesAllowedFrom") VALUES ($1, $2)
       ON CONFLICT ("userId") DO UPDATE SET "challengesAllowedFrom" = EXCLUDED."challengesAllowedFrom"`,
      [user.id, from]
    );
  const challengeTo = (to: { id: number }) => ({
    type: "challenge_sent",
    data: { challengedId: to.id, color: "white", time: 300, increment: 0 },
  });

  test("anyone can be challenged unless their settings say otherwise", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    const na = await open("/notifications", a.clerkId);
    const nb = await open("/notifications", b.clerkId);

    // No settings row at all: the default lets a stranger challenge
    na.send(challengeTo(b));
    assert.equal((await nb.next("challenge_received")).data.challengerId, a.id);

    await allowChallengesFrom(b, "only_friends");
    na.send(challengeTo(b));
    assert.equal((await na.next("error")).data.code, "NOT_FRIENDS");
    await befriend(a, b);
    na.send(challengeTo(b));
    await nb.next("challenge_received");

    // "Nobody" means friends too
    await allowChallengesFrom(b, "nobody");
    na.send(challengeTo(b));
    assert.equal((await na.next("error")).data.code, "CHALLENGES_OFF");
    await nb.none("challenge_received");
  });

  test("a stranger who was declined has to wait before challenging again", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    const c = await createUser(app, "carol");
    await befriend(c, b);
    const na = await open("/notifications", a.clerkId);
    const nb = await open("/notifications", b.clerkId);
    const nc = await open("/notifications", c.clerkId);

    na.send(challengeTo(b));
    await nb.next("challenge_received");
    nb.send({ type: "challenge_declined", data: { challengerId: a.id } });
    await na.next("challenge_declined");
    na.send(challengeTo(b));
    assert.equal((await na.next("error")).data.code, "CHALLENGE_DECLINED_RECENTLY");
    await nb.none("challenge_received");

    // A friend only waits a minute
    nc.send(challengeTo(b));
    await nb.next("challenge_received");
    nb.send({ type: "challenge_declined", data: { challengerId: c.id } });
    await nc.next("challenge_declined");
    nc.send(challengeTo(b));
    const wait = await nc.next("error");
    assert.equal(wait.data.code, "CHALLENGE_DECLINED_RECENTLY");
    assert.match(wait.data.message, /in a minute/);
    await nb.none("challenge_received");

    // A minute later the friend may ask again; the stranger still waits
    const aMinuteAgo = String(Date.now() - 61_000);
    await app.redis.set(`challenge:declined:${c.id}:${b.id}`, aMinuteAgo);
    await app.redis.set(`challenge:declined:${a.id}:${b.id}`, aMinuteAgo);
    nc.send(challengeTo(b));
    await nb.next("challenge_received");
    na.send(challengeTo(b));
    assert.equal((await na.next("error")).data.code, "CHALLENGE_DECLINED_RECENTLY");
  });

  test("a decline recorded by older code (no time) holds strangers back as it did, and not friends", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    const c = await createUser(app, "carol");
    await befriend(c, b);
    const na = await open("/notifications", a.clerkId);
    const nb = await open("/notifications", b.clerkId);
    const nc = await open("/notifications", c.clerkId);
    // What the code before the friend cooldown wrote, for its own TTL
    for (const challenger of [a, c]) {
      await app.redis.set(`challenge:declined:${challenger.id}:${b.id}`, "1", { expiration: { type: "EX", value: 300 } });
    }

    nc.send(challengeTo(b));
    assert.equal((await nb.next("challenge_received")).data.challengerId, c.id);
    na.send(challengeTo(b));
    assert.equal((await na.next("error")).data.code, "CHALLENGE_DECLINED_RECENTLY");
    // Once the key is gone, so is the wait
    await app.redis.del(`challenge:declined:${a.id}:${b.id}`);
    na.send(challengeTo(b));
    await nb.next("challenge_received", (m) => m.data.challengerId === a.id);
  });

  test("probing whether a stranger is online costs a challenge", async () => {
    const a = await createUser(app, "alice");
    const na = await open("/notifications", a.clerkId);
    // Ten probes of players who aren't online use up the stranger limit
    for (let i = 0; i < 10; i++) {
      na.send(challengeTo(await createUser(app, `offline${i}`)));
      await na.next("opponent_unavailable");
    }
    const online = await createUser(app, "online");
    const no = await open("/notifications", online.clerkId);
    na.send(challengeTo(online));
    assert.equal((await na.next("error")).data.code, "CHALLENGE_RATE_LIMITED");
    await no.none("challenge_received");
  });

  test("challenges to one player are limited, friends and series included", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    await befriend(a, b);
    const na = await open("/notifications", a.clerkId);
    const nb = await open("/notifications", b.clerkId);
    // Re-sending replaces the open challenge, but each one pops up again
    for (let i = 0; i < 8; i++) {
      na.send(challengeTo(b));
      await nb.next("challenge_received");
    }
    na.send(challengeTo(b));
    assert.equal((await na.next("error")).data.code, "CHALLENGE_RATE_LIMITED");
    await nb.none("challenge_received");
    // Someone else is still free to challenge them
    const c = await createUser(app, "carol");
    const nc = await open("/notifications", c.clerkId);
    nc.send(challengeTo(b));
    await nb.next("challenge_received");
    await nc.none("error");
  });

  test("a challenge carries a version that changes with its terms", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    await befriend(a, b);
    const na = await open("/notifications", a.clerkId);
    const nb = await open("/notifications", b.clerkId);
    const received = async () => (await nb.next("challenge_received")).data;
    const listed = async () =>
      (await app.inject({ url: "/api/challenges", headers: { authorization: `Bearer ${b.clerkId}` } })).json()
        .challenges[0];

    na.send(challengeTo(b));
    const first = await received();
    assert.equal(typeof first.version, "number");
    assert.equal((await listed()).version, first.version);
    const sent = (
      await app.inject({ url: "/api/challenges/sent", headers: { authorization: `Bearer ${a.clerkId}` } })
    ).json().challenge;
    assert.equal(sent.version, first.version);

    // The same terms again: same version (only the expiry is refreshed)
    na.send(challengeTo(b));
    assert.equal((await received()).version, first.version);

    // Other terms: a new version, and accepting the old one is refused
    na.send({ ...challengeTo(b), data: { ...challengeTo(b).data, time: 60 } });
    const second = await received();
    assert.notEqual(second.version, first.version);
    assert.equal(second.time, 60);
    nb.send({ type: "challenge_accepted", data: { challengerId: a.id, version: first.version } });
    const refused = await nb.next("error");
    assert.equal(refused.data.code, "CHALLENGE_CHANGED");
    assert.equal(refused.data.message, "The challenge changed. Check the new terms.");
    // The challenged player is shown the challenge as it now stands, still open
    const resent = await received();
    assert.equal(resent.version, second.version);
    assert.equal(resent.time, 60);
    await na.none("match_created");
    assert.equal((await listed()).version, second.version);

    // Accepting the current version starts the game on its terms
    nb.send({ type: "challenge_accepted", data: { challengerId: a.id, version: second.version } });
    const created = await na.next("match_created");
    assert.equal(created.data.time, 60);
  });

  test("a challenge cancelled and sent again never reuses a version", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    await befriend(a, b);
    const na = await open("/notifications", a.clerkId);
    const nb = await open("/notifications", b.clerkId);
    na.send(challengeTo(b));
    const first = (await nb.next("challenge_received")).data;
    na.send({ type: "challenge_cancelled", data: { challengedId: b.id } });
    await nb.next("challenge_cancelled");
    na.send(challengeTo(b));
    const second = (await nb.next("challenge_received")).data;
    assert.notEqual(second.version, first.version);
    nb.send({ type: "challenge_accepted", data: { challengerId: a.id, version: first.version } });
    assert.equal((await nb.next("error")).data.code, "CHALLENGE_CHANGED");
  });

  test("accepting without a version still works (older clients)", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    const na = await open("/notifications", a.clerkId);
    const nb = await open("/notifications", b.clerkId);
    na.send(challengeTo(b));
    await nb.next("challenge_received");
    nb.send({ type: "challenge_accepted", data: { challengerId: a.id } });
    await na.next("match_created");
    await nb.next("match_created");
  });

  test("one player can't challenge strangers without end", async () => {
    const a = await createUser(app, "alice");
    const na = await open("/notifications", a.clerkId);
    const strangers = [];
    for (let i = 0; i < 11; i++) {
      const user = await createUser(app, `stranger${i}`);
      strangers.push({ user, socket: await open("/notifications", user.clerkId) });
    }
    for (const { user, socket } of strangers.slice(0, 10)) {
      na.send(challengeTo(user));
      await socket.next("challenge_received");
    }
    na.send(challengeTo(strangers[10]!.user));
    assert.equal((await na.next("error")).data.code, "CHALLENGE_RATE_LIMITED");
    await strangers[10]!.socket.none("challenge_received");
  });

  test("a deleted account can't be challenged", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    await app.pg.query(`UPDATE users SET "clerkId" = NULL WHERE id = $1`, [b.id]);
    const na = await open("/notifications", a.clerkId);
    na.send(challengeTo(b));
    assert.equal((await na.next("error")).data.code, "USER_NOT_FOUND");
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
