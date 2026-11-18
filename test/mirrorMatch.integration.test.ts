import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, move, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { openingPosition } from "../src/game/openings.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";

describe("mirror matches and openings", { skip }, () => {
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

  const gameRow = async (gameId: number) =>
    (
      await app.pg.query(
        `SELECT "whiteId", "blackId", "seriesId", "seriesGame", "openingId", "startPly", "numMoves", pgn, fen
         FROM games WHERE id = $1`,
        [gameId]
      )
    ).rows[0];

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
    alice = await createUser(app, "alice");
    bob = await createUser(app, "bobby");
  });

  /** Alice challenges Bob with `data`, Bob accepts; returns the first game's id */
  const challengeAccepted = async (data: object) => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    na.send({ type: "challenge_sent", data: { challengedId: bob.id, time: 180, increment: 0, ...data } });
    const received = await nb.next("challenge_received");
    nb.send({ type: "challenge_accepted", data: { challengerId: alice.id, version: received.data.version } });
    const created = await na.next("match_created");
    return { received, created, gameId: created.data.gameId as number };
  };

  test("the openings list is served with each opening's position", async () => {
    const { openings } = await get("/api/openings", alice.clerkId);
    const sicilian = openings.find((o: any) => o.id === "sicilian");
    assert.deepEqual(sicilian.moves, ["e4", "c5"]);
    assert.equal(sicilian.fen, openingPosition("sicilian")!.fen);
  });

  test("a mirror match plays the opening once with each colour and scores the pair", async () => {
    const { received, created, gameId } = await challengeAccepted({
      color: "white",
      bestOf: 2,
      openingId: "queens-gambit",
    });
    assert.equal(received.data.bestOf, 2);
    assert.deepEqual(received.data.opening, { id: "queens-gambit", eco: "D06", name: "Queen's Gambit" });
    assert.equal(created.data.opening.id, "queens-gambit");

    const qg = openingPosition("queens-gambit")!;
    const first = await gameRow(gameId);
    assert.deepEqual(
      [first.whiteId, first.seriesGame, first.openingId, first.startPly, first.numMoves, first.pgn, first.fen],
      [alice.id, 1, "queens-gambit", 3, 3, qg.pgn, qg.fen]
    );

    let ga = await open(`/game/${gameId}`, alice.clerkId);
    let gb = await open(`/game/${gameId}`, bob.clerkId);
    const state = (await ga.next("initial_game_state")).data;
    await gb.next("initial_game_state");
    assert.deepEqual([state.startPly, state.numMoves, state.clockRunning, state.pgn], [3, 3, false, qg.pgn]);
    assert.equal(state.opening.name, "Queen's Gambit");
    assert.deepEqual([state.series.bestOf, state.series.opening.id], [2, "queens-gambit"]);

    // 2...e6 3. Nc3: Black moves first, and neither first move starts the clocks
    ga.send(move("e7e6"));
    assert.equal((await ga.next("move_rejected")).message, "Not your turn");
    gb.send(move("e7e6"));
    const blackFirst = await ga.next("move");
    assert.deepEqual([blackFirst.moveNumber, blackFirst.clockRunning], [4, false]);
    // Still abortable, and a takeback can't reach into the opening
    gb.send({ type: "takeback_request" });
    assert.equal((await gb.next("error")).data.code, "TAKEBACK_NOT_ALLOWED");
    ga.send(move("b1c3"));
    const whiteFirst = await gb.next("move", (m) => m.moveNumber === 5);
    assert.deepEqual([whiteFirst.moveNumber, whiteFirst.clockRunning], [5, true]);
    ga.send({ type: "abort" });
    assert.equal((await ga.next("error")).data.code, "ABORT_NOT_ALLOWED");

    // Game 1: Bob (Black) resigns. One win is half the match: not decided yet
    gb.send({ type: "resign" });
    let ended = await ga.next("game_ended");
    assert.deepEqual([ended.series.status, ended.series.playerOne.score], ["active", 1]);
    assert.deepEqual(ended.series.next, { number: 2, whiteId: bob.id, blackId: alice.id });

    // Game 2: colours swap, same opening
    ga.send({ type: "rematch_request" });
    await gb.next("rematch_request");
    gb.send({ type: "rematch_response", data: { accepted: true } });
    const secondId: number = (await gb.next("match_found")).data.gameId;
    const second = await gameRow(secondId);
    assert.deepEqual(
      [second.whiteId, second.blackId, second.seriesGame, second.openingId, second.startPly, second.pgn],
      [bob.id, alice.id, 2, "queens-gambit", 3, qg.pgn]
    );

    // Alice, now Black, wins too: 2 - 0
    ga = await open(`/game/${secondId}`, alice.clerkId);
    gb = await open(`/game/${secondId}`, bob.clerkId);
    await ga.next("initial_game_state");
    await gb.next("initial_game_state");
    gb.send({ type: "resign" });
    ended = await ga.next("game_ended");
    assert.deepEqual(
      [ended.series.status, ended.series.winnerId, ended.series.playerOne.score, ended.series.playerTwo.score],
      ["finished", alice.id, 2, 0]
    );
    assert.equal(ended.series.next, null);
  });

  test("a win each is a drawn mirror match", async () => {
    const { gameId } = await challengeAccepted({ color: "black", bestOf: 2, openingId: "sicilian" });
    let ga = await open(`/game/${gameId}`, alice.clerkId);
    let gb = await open(`/game/${gameId}`, bob.clerkId);
    await ga.next("initial_game_state");
    await gb.next("initial_game_state");
    ga.send({ type: "resign" });
    await gb.next("game_ended");
    gb.send({ type: "rematch_request" });
    await ga.next("rematch_request");
    ga.send({ type: "rematch_response", data: { accepted: true } });
    const secondId: number = (await ga.next("match_found")).data.gameId;
    assert.equal((await gameRow(secondId)).whiteId, alice.id);
    ga = await open(`/game/${secondId}`, alice.clerkId);
    gb = await open(`/game/${secondId}`, bob.clerkId);
    await ga.next("initial_game_state");
    await gb.next("initial_game_state");
    gb.send({ type: "resign" });
    const ended = await ga.next("game_ended");
    assert.deepEqual(
      [ended.series.status, ended.series.winnerId, ended.series.playerOne.score, ended.series.playerTwo.score],
      ["finished", null, 1, 1]
    );
    const detail = await get(`/api/series/${ended.series.id}`, alice.clerkId);
    assert.deepEqual(
      detail.games.map((g: any) => [g.seriesGame, g.opening?.id, g.startPly]),
      [
        [1, "sicilian", 2],
        [2, "sicilian", 2],
      ]
    );
  });

  test("a single game can start from an opening, and before both players move it can be aborted", async () => {
    const { gameId } = await challengeAccepted({ color: "white", openingId: "italian" });
    const row = await gameRow(gameId);
    assert.deepEqual([row.seriesId, row.startPly, row.numMoves], [null, 5, 5]);
    const ga = await open(`/game/${gameId}`, alice.clerkId);
    const gb = await open(`/game/${gameId}`, bob.clerkId);
    await ga.next("initial_game_state");
    await gb.next("initial_game_state");
    // 3...Bc5: Black's own first move
    gb.send(move("f8c5"));
    await ga.next("move");
    ga.send({ type: "abort" });
    assert.equal((await gb.next("game_ended")).result, "aborted");
    assert.equal((await get(`/api/games/${gameId}`, alice.clerkId)).opening.id, "italian");
  });

  test("from an opening only a mirror match is rated", async () => {
    const rated = async (gameId: number) =>
      (await app.pg.query(`SELECT rated FROM games WHERE id = $1`, [gameId])).rows[0].rated;

    // A single game: unrated whatever the challenge asks, and shown so
    const single = await challengeAccepted({ color: "white", openingId: "kings-gambit", rated: true });
    assert.equal(single.received.data.rated, false);
    assert.equal(single.created.data.rated, false);
    assert.equal(await rated(single.gameId), false);
    await app.pg.query(`UPDATE games SET status = 'finished', result = 'draw', "endReason" = 'draw_agreement'`);
    await Promise.all(sockets.splice(0).map((s) => s.close()));

    // A best-of-3 series from an opening: unrated too, every game of it
    const series = await challengeAccepted({ color: "white", openingId: "evans-gambit", bestOf: 3 });
    assert.equal(series.received.data.rated, false);
    const seriesId = (await gameRow(series.gameId)).seriesId;
    assert.equal((await app.pg.query(`SELECT rated FROM series WHERE id = $1`, [seriesId])).rows[0].rated, false);
    assert.equal(await rated(series.gameId), false);
    await app.pg.query(`UPDATE games SET status = 'finished', result = 'draw', "endReason" = 'draw_agreement'`);
    await app.pg.query(`UPDATE series SET status = 'finished', "endReason" = 'resignation'`);
    await Promise.all(sockets.splice(0).map((s) => s.close()));

    // A mirror match is rated, as is each of its games
    const mirror = await challengeAccepted({ color: "white", openingId: "evans-gambit", bestOf: 2 });
    assert.equal(mirror.received.data.rated, true);
    assert.equal(await rated(mirror.gameId), true);
    // Once the match is over, a rematch is a single game from the opening: unrated
    const ga = await open(`/game/${mirror.gameId}`, alice.clerkId);
    const gb = await open(`/game/${mirror.gameId}`, bob.clerkId);
    await ga.next("initial_game_state");
    await gb.next("initial_game_state");
    gb.send({ type: "resign" });
    await ga.next("game_ended");
    await app.pg.query(`UPDATE series SET status = 'finished', "endReason" = 'resignation'`);
    ga.send({ type: "rematch_request" });
    await gb.next("rematch_request");
    gb.send({ type: "rematch_response", data: { accepted: true } });
    const rematch = await ga.next("match_found");
    assert.equal(rematch.data.rated, false);
    assert.equal((await gameRow(rematch.data.gameId)).openingId, "evans-gambit");
  });

  test("an opening's challenge reads the same rated or not: its version doesn't change", async () => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    const data = { challengedId: bob.id, color: "white", time: 180, increment: 0, openingId: "french" };
    na.send({ type: "challenge_sent", data: { ...data, rated: true } });
    const first = await nb.next("challenge_received");
    na.send({ type: "challenge_sent", data: { ...data, rated: false } });
    const second = await nb.next("challenge_received");
    assert.deepEqual([first.data.rated, second.data.rated], [false, false]);
    assert.equal(second.data.version, first.data.version);
    assert.equal((await get("/api/challenges", bob.clerkId)).challenges[0].rated, false);
  });

  test("changing the opening changes the challenge's version, and an unknown one is refused", async () => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    const data = { challengedId: bob.id, color: "white", time: 180, increment: 0, bestOf: 2 };
    na.send({ type: "challenge_sent", data: { ...data, openingId: "french" } });
    const first = await nb.next("challenge_received");
    na.send({ type: "challenge_sent", data: { ...data, openingId: "caro-kann" } });
    const second = await nb.next("challenge_received");
    assert.notEqual(second.data.version, first.data.version);
    assert.equal(second.data.opening.id, "caro-kann");
    assert.equal((await get("/api/challenges", bob.clerkId)).challenges[0].opening.id, "caro-kann");

    na.send({ type: "challenge_sent", data: { ...data, openingId: "bongcloud" } });
    await na.next("error");
    assert.equal((await get("/api/challenges", bob.clerkId)).challenges[0].opening.id, "caro-kann");
  });
});
