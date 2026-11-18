import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { NEXT_GAME_DELAY_MS } from "../src/game/timedMatch.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";

describe("timed matches", { skip }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let alice: { id: number; clerkId: string };
  let bob: { id: number; clerkId: string };
  const sockets: TestSocket[] = [];

  const open = async (path: string, clerkId: string) => {
    const socket = await connect(baseUrl, path, clerkId);
    sockets.push(socket);
    return socket;
  };
  const get = async (url: string, clerkId: string) =>
    (await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${clerkId}` } })).json();
  const seriesRow = async (id: number) =>
    (await app.pg.query(`SELECT * FROM series WHERE id = $1`, [id])).rows[0];
  const inProgress = async (seriesId: number) =>
    (await app.pg.query(`SELECT id FROM games WHERE "seriesId" = $1 AND status = 'in_progress'`, [seriesId])).rows;

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    app.series.stop();
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
    alice = await createUser(app, "alice");
    bob = await createUser(app, "bobby");
  });

  /** Alice challenges Bob to a timed match, Bob accepts; both open the first game */
  const matchStarted = async (data: object = {}) => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    na.send({
      type: "challenge_sent",
      data: { challengedId: bob.id, time: 180, increment: 0, color: "white", matchMinutes: 15, ...data },
    });
    const received = await nb.next("challenge_received");
    nb.send({ type: "challenge_accepted", data: { challengerId: alice.id, version: received.data.version } });
    const gameId: number = (await na.next("match_created")).data.gameId;
    const players = await openGame(gameId);
    return { received, gameId, ...players };
  };
  const openGame = async (gameId: number) => {
    const ga = await open(`/game/${gameId}`, alice.clerkId);
    const gb = await open(`/game/${gameId}`, bob.clerkId);
    const state = (await ga.next("initial_game_state")).data;
    await gb.next("initial_game_state");
    return { ga, gb, state };
  };
  /** Makes the deadline of a game pass and resolves it, as its timer would */
  const passDeadline = async (gameId: number) => {
    await app.pg.query(`UPDATE games SET "deadlineAt" = now() - interval '1 second' WHERE id = $1`, [gameId]);
    await app.liveGames.resolveDeadline(gameId);
  };

  test("games follow each other by themselves, scored like an arena, until the time is up", async () => {
    const { received, gameId, ga, gb, state } = await matchStarted();
    assert.equal(received.data.matchMinutes, 15);
    assert.equal(received.data.bestOf, 1);
    const series = state.series;
    assert.deepEqual([series.bestOf, series.matchMinutes, series.status], [0, 15, "active"]);
    const endsIn = new Date(series.endsAt).getTime() - Date.now();
    assert.ok(endsIn > 14 * 60_000 && endsIn <= 15 * 60_000, `ends in ${endsIn} ms`);
    assert.equal(new Date(series.endsAt).getTime() - new Date(series.lastGameStartsBy).getTime(), 60_000);

    // No abort: every game counts
    ga.send({ type: "abort" });
    assert.equal((await ga.next("error")).data.code, "TIMED_MATCH_GAME");

    // Game 1: Bob resigns. Alice 2, and nobody asks for the next game
    gb.send({ type: "resign" });
    const first = await ga.next("game_ended");
    assert.deepEqual(
      [first.series.status, first.series.playerOne.score, first.series.playerOne.streak, first.series.playerTwo.score],
      ["active", 2, 1, 0]
    );
    ga.send({ type: "rematch_request" });
    assert.equal((await ga.next("error")).data.code, "TIMED_MATCH_GAME");

    // It starts on its own, colours swapped, on both players' game pages
    const startedAt = Date.now();
    const next = await ga.next("match_found", undefined, NEXT_GAME_DELAY_MS + 3000);
    assert.ok(Date.now() - startedAt >= NEXT_GAME_DELAY_MS - 1000);
    assert.equal((await gb.next("match_found")).data.gameId, next.data.gameId);
    assert.equal(next.data.color, "black");
    const secondId: number = next.data.gameId;
    const firstRow = (await app.pg.query(`SELECT "rematchGameId" FROM games WHERE id = $1`, [gameId])).rows[0];
    assert.equal(firstRow.rematchGameId, secondId);

    // Game 2 ends after the last moment a game may start: the match is over
    const second = await openGame(secondId);
    await app.pg.query(`UPDATE series SET "endsAt" = now() + interval '30 seconds' WHERE id = $1`, [series.id]);
    second.gb.send({ type: "resign" }); // Bob is White now; Alice on a streak of one, still 2 a win
    const last = await second.ga.next("game_ended");
    assert.deepEqual(
      [last.series.status, last.series.endReason, last.series.winnerId, last.series.playerOne.score],
      ["finished", "time_up", alice.id, 4]
    );
    await new Promise((r) => setTimeout(r, NEXT_GAME_DELAY_MS + 500));
    assert.deepEqual(await inProgress(series.id), []);
    const detail = await get(`/api/series/${series.id}`, bob.clerkId);
    assert.equal(detail.games.length, 2);
    // After the match a rematch is an ordinary game again
    second.ga.send({ type: "rematch_request" });
    await second.gb.next("rematch_request");
  });

  test("a no-show loses the game, and two in a row end the match", async () => {
    const { gameId, state } = await matchStarted();
    await passDeadline(gameId); // Alice (White) never moves
    let row = await seriesRow(state.series.id);
    assert.deepEqual([row.status, row.playerTwoPoints, row.noShows], ["active", 2, 1]);
    const game = (await app.pg.query(`SELECT result, rated FROM games WHERE id = $1`, [gameId])).rows[0];
    assert.deepEqual([game.result, game.rated], ["black_win", false]);

    // The sweep starts the next game when the timer didn't (another instance went away)
    app.series.stop();
    await app.series.sweepTimedMatches(new Date(Date.now() + 3 * NEXT_GAME_DELAY_MS));
    const [second] = await inProgress(state.series.id);
    assert.ok(second);
    await passDeadline(second.id); // Bob (White now) doesn't move either
    row = await seriesRow(state.series.id);
    assert.deepEqual(
      [row.status, row.endReason, row.playerOnePoints, row.playerTwoPoints, row.winnerId],
      ["finished", "abandoned", 2, 2, null]
    );
  });

  test("time running out between games ends the match on points", async () => {
    const { gb, ga, state } = await matchStarted();
    gb.send({ type: "resign" });
    await ga.next("game_ended");
    app.series.stop(); // the next game's timer
    await app.pg.query(`UPDATE series SET "endsAt" = now() + interval '10 seconds' WHERE id = $1`, [state.series.id]);
    const na = sockets[0]!;
    await app.series.sweepTimedMatches(new Date(Date.now() + 3 * NEXT_GAME_DELAY_MS));
    const updated = await na.next("series_updated");
    assert.deepEqual(
      [updated.data.series.status, updated.data.series.endReason, updated.data.series.winnerId],
      ["finished", "time_up", alice.id]
    );
    assert.deepEqual(await inProgress(state.series.id), []);
  });

  test("resigning the match resigns the game being played", async () => {
    const { ga, state } = await matchStarted();
    const res = await app.inject({
      method: "POST",
      url: `/api/series/${state.series.id}/resign`,
      headers: { authorization: `Bearer ${bob.clerkId}` },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual([res.json().series.status, res.json().series.winnerId], ["finished", alice.id]);
    assert.equal((await ga.next("game_ended")).reason, "resignation");
    await new Promise((r) => setTimeout(r, NEXT_GAME_DELAY_MS + 500));
    assert.deepEqual(await inProgress(state.series.id), []);
  });

  test("the time control has to fit, and a timed match isn't also a best-of", async () => {
    const na = await open("/notifications", alice.clerkId);
    await open("/notifications", bob.clerkId);
    const base = { challengedId: bob.id, increment: 0, color: "white" };
    na.send({ type: "challenge_sent", data: { ...base, time: 600, matchMinutes: 15 } });
    assert.equal((await na.next("error")).data.code, "MATCH_TOO_SHORT");
    na.send({ type: "challenge_sent", data: { ...base, time: 180, matchMinutes: 15, bestOf: 3 } });
    assert.equal((await na.next("error")).data.code, "BAD_MATCH_FORMAT");
    na.send({ type: "challenge_sent", data: { ...base, time: 180, matchMinutes: 7 } });
    await na.next("error");
  });
});
