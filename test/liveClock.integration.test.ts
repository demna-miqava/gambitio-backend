import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
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
import { gameRepository, saveMoveStatement } from "../src/repositories/gameRepository.js";
import { INITIAL_LAG_BUDGET_MS, LAG_BUDGET_REFILL_MS, MAX_PAUSE_MS } from "../src/game/clock.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("live clocks, pauses and offer limits", { skip }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const sockets: TestSocket[] = [];

  const open = async (path: string, clerkId: string, url = baseUrl) => {
    const socket = await connect(url, path, clerkId);
    sockets.push(socket);
    return socket;
  };

  const newGame = (whiteId: number, blackId: number, time = 180) =>
    app.pg.transact((tx) => createGame(tx, { whiteId, blackId, time, increment: 0 }));

  const row = async (gameId: number) =>
    (
      await app.pg.query(
        `SELECT status, "endReason", "numMoves", "whiteTimeLeftMs", "blackTimeLeftMs", "lastMoveAt",
           "deadlineAt", "pausedAt", "whiteLagBudgetMs", "blackLagBudgetMs", "drawDeclinedFor"
         FROM games WHERE id = $1`,
        [gameId]
      )
    ).rows[0];

  /** Moves the game's clock timestamps back by `ms`, as if that much time had passed. */
  const age = (gameId: number, ms: number) =>
    app.pg.query(
      `UPDATE games SET "lastMoveAt" = "lastMoveAt" - $2 * interval '1 millisecond',
         "deadlineAt" = "deadlineAt" - $2 * interval '1 millisecond',
         "pausedAt" = "pausedAt" - $2 * interval '1 millisecond'
       WHERE id = $1`,
      [gameId, ms]
    );

  /** A game with both first moves played, so white's clock is running, and both players' sockets. */
  async function startedGame(names: [string, string], url = baseUrl) {
    const white = await createUser(app, names[0]);
    const black = await createUser(app, names[1]);
    const game = await newGame(white.id, black.id);
    const w = await open(`/game/${game.id}`, white.clerkId, url);
    const b = await open(`/game/${game.id}`, black.clerkId, url);
    await w.next("initial_game_state");
    await b.next("initial_game_state");
    w.send(move("e2e4"));
    await b.next("move", (m) => m.move.lan === "e2e4");
    b.send(move("e7e5"));
    await w.next("move", (m) => m.move.lan === "e7e5");
    return { game, white, black, w, b };
  }

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
  });

  test("a shutdown pauses the games played here, and startup resumes them without the downtime", async () => {
    // A server of its own, since it is shut down
    const old = await startTestApp();
    const one = await startedGame(["white_one", "black_one"], old.baseUrl);
    const two = await startedGame(["white_two", "black_two"], old.baseUrl);
    const elsewhere = await newGame((await createUser(app, "white_x")).id, (await createUser(app, "black_x")).id);

    assert.equal(await old.app.liveGames.pauseForShutdown(), 2);
    assert.ok((await row(one.game.id)).pausedAt);
    assert.equal((await row(elsewhere.id)).pausedAt, null, "no player of it here");
    // Until it is gone, the server shutting down plays on without resuming
    two.w.send(move("g1f3"));
    await two.b.next("move", (m) => m.move.lan === "g1f3");
    assert.ok((await row(two.game.id)).pausedAt, "still paused");
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await old.app.close();

    // The downtime: 20 seconds for one, more than the cap for the other
    await age(one.game.id, 20_000);
    await age(two.game.id, 90_000);
    const before1 = await row(one.game.id);
    const before2 = await row(two.game.id);

    const next = await startTestApp();
    try {
      await next.app.liveGames.startDeadlineTimers();
      next.app.liveGames.stopDeadlineTimers();
      const after1 = await row(one.game.id);
      const after2 = await row(two.game.id);
      assert.equal(after1.pausedAt, null);
      const shift1 = after1.lastMoveAt.getTime() - before1.lastMoveAt.getTime();
      assert.ok(shift1 >= 20_000 && shift1 < 25_000, `shifted by the downtime: ${shift1}`);
      assert.equal(after1.deadlineAt.getTime() - before1.deadlineAt.getTime(), shift1);
      assert.equal(after1.whiteTimeLeftMs, before1.whiteTimeLeftMs, "stored clocks don't change");
      // Capped, and from the move played after the pause began
      assert.equal(after2.lastMoveAt.getTime() - before2.lastMoveAt.getTime(), MAX_PAUSE_MS);
      assert.equal(after2.pausedAt, null);
    } finally {
      await next.app.close();
    }
  });

  test("a player reconnecting resumes a paused game before getting its state", async () => {
    const { game, white, w, b } = await startedGame(["whitey", "blacky"]);
    await w.close();
    await b.close();
    // Paused 10 seconds ago by a server that went away
    await app.pg.query(`UPDATE games SET "pausedAt" = now() WHERE id = $1`, [game.id]);
    await age(game.id, 10_000);

    // A spectator sees the clocks as they were at the pause, and doesn't resume it
    const watcher = await createUser(app, "watcher");
    const s = await open(`/game/${game.id}`, watcher.clerkId);
    const seen = await s.next("initial_game_state");
    assert.ok(seen.data.whiteTimeLeft > 179_000, `paused clock: ${seen.data.whiteTimeLeft}`);
    assert.ok((await row(game.id)).pausedAt);

    const w2 = await open(`/game/${game.id}`, white.clerkId);
    const state = await w2.next("initial_game_state");
    assert.ok(state.data.whiteTimeLeft > 179_000, `the downtime isn't charged: ${state.data.whiteTimeLeft}`);
    const resumed = await row(game.id);
    assert.equal(resumed.pausedAt, null);
    assert.ok(Date.now() - resumed.lastMoveAt.getTime() < 2_000);
  });

  test("a paused game isn't flagged while a resume could still save it", async () => {
    const { game, w, b } = await startedGame(["whitey", "blacky"]);
    await w.close();
    await b.close();
    // White had 1s left; the flag would have fallen during the downtime
    await app.pg.query(
      `UPDATE games SET "whiteTimeLeftMs" = 1000, "lastMoveAt" = now() - interval '2.5 s',
         "deadlineAt" = now() - interval '0.5 s', "pausedAt" = now() - interval '2 s'
       WHERE id = $1`,
      [game.id]
    );
    assert.deepEqual(await gameRepository.findIdsPastDeadline(app.pg, new Date(), 50), []);
    await app.jobs.runClockSweep();
    await app.liveGames.resolveDeadline(game.id);
    assert.equal((await row(game.id)).status, "in_progress");

    // Paused for longer than any resume makes up for: the flag decides it
    await age(game.id, MAX_PAUSE_MS + 10_000);
    await app.jobs.runClockSweep();
    const ended = await row(game.id);
    assert.deepEqual([ended.status, ended.endReason, ended.pausedAt], ["finished", "timeout", null]);
  });

  test("claimed delay comes out of the lag budget once the measured round trip is used up", async () => {
    const { game, w, b } = await startedGame(["whitey", "blacky"]);
    // The probe's first ping went out on connect; its pong is long back
    await sleep(400);
    w.send({ ...move("g1f3"), thinkMs: 0 });
    await b.next("move", (m) => m.move.lan === "g1f3");
    const first = await row(game.id);
    // About 400ms claimed, ~50ms of it free (a local round trip plus slack)
    assert.equal(first.whiteTimeLeftMs, 180_000, "an untouched budget covers it all");
    assert.ok(
      first.whiteLagBudgetMs > 120 && first.whiteLagBudgetMs < 280,
      `budget spent: ${first.whiteLagBudgetMs}`
    );
    assert.equal(first.blackLagBudgetMs, INITIAL_LAG_BUDGET_MS);

    b.send(move("b8c6"));
    await w.next("move", (m) => m.move.lan === "b8c6");
    await sleep(400);
    w.send({ ...move("f1c4"), thinkMs: 0 });
    await b.next("move", (m) => m.move.lan === "f1c4");
    const second = await row(game.id);
    assert.equal(second.whiteLagBudgetMs, LAG_BUDGET_REFILL_MS, "drained, then refilled once");
    const charged = 180_000 - second.whiteTimeLeftMs;
    assert.ok(charged > 50 && charged < 300, `the rest is charged: ${charged}`);
  });

  test("a declined draw offer can't be repeated until the offerer moves", async () => {
    const { game, white, w, b } = await startedGame(["whitey", "blacky"]);
    w.send({ type: "draw_offer" });
    await b.next("draw_offer");
    b.send({ type: "draw_response", accepted: false });
    await w.next("draw_response");
    assert.equal((await row(game.id)).drawDeclinedFor, white.id);

    w.send({ type: "draw_offer" });
    const refused = await w.next("error");
    assert.equal(refused.data.code, "DRAW_DECLINED");
    // The opponent's move doesn't lift it...
    w.send(move("g1f3"));
    await b.next("move", (m) => m.move.lan === "g1f3");
    b.send(move("b8c6"));
    await w.next("move", (m) => m.move.lan === "b8c6");
    assert.equal((await row(game.id)).drawDeclinedFor, null, "...but the offerer's own move did");
    w.send({ type: "draw_offer" });
    await b.next("draw_offer");
  });

  test("each player can ask for a rematch once per game", async () => {
    const { w, b } = await startedGame(["whitey", "blacky"]);
    b.send({ type: "resign" });
    await w.next("game_ended");
    await b.next("game_ended");

    w.send({ type: "rematch_request" });
    await b.next("rematch_request");
    b.send({ type: "rematch_response", data: { accepted: false } });
    await w.next("rematch_response");
    w.send({ type: "rematch_request" });
    assert.equal((await w.next("error")).data.code, "REMATCH_ALREADY_REQUESTED");
    await b.none("rematch_request");

    // A cancelled request is used up too
    b.send({ type: "rematch_request" });
    await w.next("rematch_request");
    b.send({ type: "cancel_rematch" });
    await w.next("rematch_canceled");
    b.send({ type: "rematch_request" });
    assert.equal((await b.next("error")).data.code, "REMATCH_ALREADY_REQUESTED");
  });

  test("spectator counts are sent at most every two seconds, ending with the latest", async () => {
    const white = await createUser(app, "whitey");
    const black = await createUser(app, "blacky");
    const game = await newGame(white.id, black.id);
    const w = await open(`/game/${game.id}`, white.clerkId);
    await w.next("initial_game_state");

    const viewers: TestSocket[] = [];
    for (let i = 0; i < 5; i++) {
      const viewer = await createUser(app, `viewer_${i}`);
      const socket = await open(`/game/${game.id}`, viewer.clerkId);
      await socket.next("initial_game_state");
      viewers.push(socket);
    }
    await sleep(2_300);
    const counts = w.messages.filter((m) => m.type === "spectators").map((m) => m.count);
    assert.ok(counts.length <= 2, `throttled: ${JSON.stringify(counts)}`);
    assert.equal(counts.at(-1), 5);

    await Promise.all(viewers.map((socket) => socket.close()));
    await w.next("spectators", (m) => m.count === 0, 4_500);
  });

  test("a move takes two round trips to the database: lock, then write and commit", async () => {
    const { game, w, b } = await startedGame(["whitey", "blacky"]);
    const queries: string[] = [];
    const connect = app.pg.connect;
    const connectClient = connect.bind(app.pg) as () => Promise<PoolClient>;
    // Records every query of the connections handed out while the move runs
    app.pg.connect = (async () => {
      const client = await connectClient();
      const { query, release } = client;
      client.query = ((...args: unknown[]) => {
        queries.push(typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text);
        return (query as (...a: unknown[]) => unknown).apply(client, args);
      }) as typeof client.query;
      client.release = (err?: boolean | Error) => {
        client.query = query;
        client.release = release;
        return release.call(client, err);
      };
      return client;
    }) as unknown as typeof app.pg.connect;
    try {
      w.send({ ...move("g1f3"), thinkMs: 10 });
      await b.next("move", (m) => m.move.lan === "g1f3");
    } finally {
      app.pg.connect = connect;
    }
    assert.equal(queries.length, 2, queries.join("\n---\n"));
    assert.match(queries[0]!, /^BEGIN; SELECT/);
    assert.match(queries[1]!, /^UPDATE games SET[\s\S]*; COMMIT$/);
    assert.equal((await row(game.id)).numMoves, 3);
  });

  test("the inlined move statement stores any text exactly", async () => {
    const white = await createUser(app, "whitey");
    const black = await createUser(app, "blacky");
    const game = await newGame(white.id, black.id);
    const tricky = `it's a \\ test'); DROP TABLE games; --`;
    const client = await app.pg.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `${saveMoveStatement(client, game.id, {
          fen: tricky,
          pgn: `${tricky}\nline two`,
          numMoves: 7,
          whiteTimeLeftMs: 1234.4,
          blackTimeLeftMs: 99,
          lastMoveAt: new Date("2026-01-02T03:04:05.678Z"),
          deadlineAt: new Date("2026-01-02T03:05:05.678Z"),
          drawOfferedBy: null,
          drawDeclinedFor: white.id,
          whiteLagBudgetMs: 321,
          blackLagBudgetMs: 0,
        })}; COMMIT`
      );
    } finally {
      client.release();
    }
    const { rows } = await app.pg.query(`SELECT fen, pgn, "numMoves", "whiteTimeLeftMs", "lastMoveAt", "drawDeclinedFor",
      "whiteLagBudgetMs" FROM games WHERE id = $1`, [game.id]);
    assert.deepEqual(rows[0], {
      fen: tricky,
      pgn: `${tricky}\nline two`,
      numMoves: 7,
      whiteTimeLeftMs: 1234,
      lastMoveAt: new Date("2026-01-02T03:04:05.678Z"),
      drawDeclinedFor: white.id,
      whiteLagBudgetMs: 321,
    });
  });

  test("the player sockets of a game are tracked until the game ends", async () => {
    const { game, w, b } = await startedGame(["whitey", "blacky"]);
    assert.deepEqual(app.liveGames.playedGameIds, [game.id]);
    b.send({ type: "resign" });
    await w.next("game_ended");
    assert.deepEqual(app.liveGames.playedGameIds, []);
  });
});
