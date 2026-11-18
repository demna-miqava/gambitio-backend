import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";

describe("casual challenges", { skip }, () => {
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
        `SELECT "whiteId", rated, "seriesId", "whiteRatingChange", "blackRatingChange" FROM games WHERE id = $1`,
        [gameId]
      )
    ).rows[0];

  const ratings = async () =>
    (await app.pg.query(`SELECT "blitzRating", "blitzGames" FROM users ORDER BY id`)).rows;

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
    alice = await createUser(app, "alice", 1800);
    bob = await createUser(app, "bobby", 1200);
  });

  test("an unrated challenge plays a game that changes no ratings, and so does its rematch", async () => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    na.send({
      type: "challenge_sent",
      data: { challengedId: bob.id, color: "white", time: 180, increment: 0, rated: false },
    });
    const received = await nb.next("challenge_received");
    assert.equal(received.data.rated, false);
    assert.equal((await get("/api/challenges", bob.clerkId)).challenges[0].rated, false);
    assert.equal((await get("/api/challenges/sent", alice.clerkId)).challenge.rated, false);

    nb.send({ type: "challenge_accepted", data: { challengerId: alice.id, version: received.data.version } });
    const created = await na.next("match_created");
    assert.equal(created.data.rated, false);
    const gameId: number = created.data.gameId;
    assert.equal((await gameRow(gameId)).rated, false);

    const ga = await open(`/game/${gameId}`, alice.clerkId);
    const gb = await open(`/game/${gameId}`, bob.clerkId);
    assert.equal((await ga.next("initial_game_state")).data.rated, false);
    await gb.next("initial_game_state");

    const before = await ratings();
    gb.send({ type: "resign" });
    const ended = await ga.next("game_ended");
    assert.equal(ended.winnerId, alice.id);
    assert.equal(ended.ratingChanges, undefined);
    assert.deepEqual(await ratings(), before);

    ga.send({ type: "rematch_request" });
    await gb.next("rematch_request");
    gb.send({ type: "rematch_response", data: { accepted: true } });
    const rematch = await gameRow((await gb.next("match_found")).data.gameId);
    assert.deepEqual([rematch.whiteId, rematch.rated], [bob.id, false]);
  });

  test("a challenge is rated unless it says otherwise", async () => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    na.send({ type: "challenge_sent", data: { challengedId: bob.id, color: "white", time: 180, increment: 0 } });
    assert.equal((await nb.next("challenge_received")).data.rated, true);
    nb.send({ type: "challenge_accepted", data: { challengerId: alice.id } });
    const created = await na.next("match_created");
    assert.equal(created.data.rated, true);
    assert.equal((await gameRow(created.data.gameId)).rated, true);
  });

  test("making a challenge unrated changes its version, so an accept of the rated one is refused", async () => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    const data = { challengedId: bob.id, color: "white", time: 180, increment: 0 };
    na.send({ type: "challenge_sent", data });
    const first = await nb.next("challenge_received");
    na.send({ type: "challenge_sent", data: { ...data, rated: false } });
    const second = await nb.next("challenge_received");
    assert.notEqual(second.data.version, first.data.version);
    assert.equal(second.data.rated, false);

    nb.send({ type: "challenge_accepted", data: { challengerId: alice.id, version: first.data.version } });
    const resent = await nb.next("challenge_received");
    assert.deepEqual([resent.data.version, resent.data.rated], [second.data.version, false]);
    await na.none("match_created");
  });

  test("every game of an unrated series is unrated, whatever a continuation asks for", async () => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    na.send({
      type: "challenge_sent",
      data: { challengedId: bob.id, color: "white", time: 180, increment: 0, bestOf: 3, rated: false },
    });
    await nb.next("challenge_received");
    nb.send({ type: "challenge_accepted", data: { challengerId: alice.id } });
    let gameId: number = (await na.next("match_created")).data.gameId;
    const first = await gameRow(gameId);
    assert.equal(first.rated, false);

    const ga = await open(`/game/${gameId}`, alice.clerkId);
    const gb = await open(`/game/${gameId}`, bob.clerkId);
    const state = await ga.next("initial_game_state");
    assert.equal(state.data.series.rated, false);
    await gb.next("initial_game_state");
    ga.send({ type: "resign" });
    await ga.next("game_ended");

    // Game 2 through the rematch button
    gb.send({ type: "rematch_request" });
    await ga.next("rematch_request");
    ga.send({ type: "rematch_response", data: { accepted: true } });
    gameId = (await ga.next("match_found")).data.gameId;
    assert.deepEqual([(await gameRow(gameId)).rated, (await gameRow(gameId)).seriesId], [false, first.seriesId]);

    // Aborted, then started again from a challenge that asks for a rated game:
    // the series' setting wins
    const gb2 = await open(`/game/${gameId}`, bob.clerkId);
    await gb2.next("initial_game_state");
    gb2.send({ type: "abort" });
    await gb2.next("game_ended");
    nb.send({
      type: "challenge_sent",
      data: { challengedId: alice.id, color: "white", time: 180, increment: 0, seriesId: first.seriesId, rated: true },
    });
    const continued = await na.next("challenge_received");
    assert.equal(continued.data.rated, false);
    na.send({ type: "challenge_accepted", data: { challengerId: bob.id } });
    gameId = (await na.next("match_created")).data.gameId;
    const again = await gameRow(gameId);
    assert.deepEqual([again.seriesId, again.rated], [first.seriesId, false]);
  });

  test("time odds make a challenge unrated even when it asks to be rated", async () => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    na.send({
      type: "challenge_sent",
      data: { challengedId: bob.id, color: "white", time: 60, opponentTime: 300, increment: 0, rated: true },
    });
    assert.equal((await nb.next("challenge_received")).data.rated, false);
  });
});
