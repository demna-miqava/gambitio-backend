import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";

describe("time odds", { skip }, () => {
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
        `SELECT "whiteId", "blackId", time, "whiteTime", "blackTime", "whiteTimeLeftMs", "blackTimeLeftMs",
           rated, "seriesId", "whiteRatingChange", "blackRatingChange"
         FROM games WHERE id = $1`,
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

  test("each player starts with their own clock, and the game is unrated", async () => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    // Alice (stronger) takes 1 minute and gives Bob 5
    na.send({
      type: "challenge_sent",
      data: { challengedId: bob.id, color: "black", time: 60, opponentTime: 300, increment: 2 },
    });
    const received = await nb.next("challenge_received");
    assert.deepEqual(
      [received.data.time, received.data.ownTime, received.data.opponentTime, received.data.increment],
      [300, 300, 60, 2]
    );
    const listed = await get("/api/challenges", bob.clerkId);
    assert.deepEqual(
      [listed.challenges[0].time, listed.challenges[0].ownTime, listed.challenges[0].opponentTime],
      [300, 300, 60]
    );
    const sent = await get("/api/challenges/sent", alice.clerkId);
    assert.deepEqual([sent.challenge.time, sent.challenge.ownTime, sent.challenge.opponentTime], [300, 60, 300]);

    nb.send({ type: "challenge_accepted", data: { challengerId: alice.id } });
    const created = await na.next("match_created");
    assert.deepEqual(
      [created.data.color, created.data.time, created.data.ownTime, created.data.opponentTime, created.data.rated],
      ["black", 300, 60, 300, false]
    );
    const gameId: number = created.data.gameId;
    const row = await gameRow(gameId);
    assert.deepEqual(
      [row.whiteId, row.time, row.whiteTime, row.blackTime, row.whiteTimeLeftMs, row.blackTimeLeftMs, row.rated],
      [bob.id, 300, 300, 60, 300_000, 60_000, false]
    );

    const ga = await open(`/game/${gameId}`, alice.clerkId);
    const gb = await open(`/game/${gameId}`, bob.clerkId);
    const state = await ga.next("initial_game_state");
    assert.deepEqual(
      [state.data.whiteTime, state.data.blackTime, state.data.whiteTimeLeft, state.data.blackTimeLeft, state.data.rated],
      [300, 60, 300_000, 60_000, false]
    );
    await gb.next("initial_game_state");

    // The game ends without touching ratings or the rated-game counters
    const before = await ratings();
    gb.send({ type: "resign" });
    const ended = await ga.next("game_ended");
    assert.equal(ended.winnerId, alice.id);
    assert.equal(ended.ratingChanges, undefined);
    assert.deepEqual(await ratings(), before);
    const finished = await gameRow(gameId);
    assert.deepEqual([finished.whiteRatingChange, finished.blackRatingChange], [0, 0]);

    // The history shows both clocks; stats leave the game out
    const history = await get(`/api/users/${bob.id}/games`, bob.clerkId);
    assert.deepEqual(
      [history.data[0].whiteTime, history.data[0].blackTime, history.data[0].rated],
      [300, 60, false]
    );

    // A rematch swaps colours; each player keeps their own clock
    ga.send({ type: "rematch_request" });
    await gb.next("rematch_request");
    gb.send({ type: "rematch_response", data: { accepted: true } });
    const rematch = await gameRow((await gb.next("match_found")).data.gameId);
    assert.deepEqual(
      [rematch.whiteId, rematch.whiteTime, rematch.blackTime, rematch.whiteTimeLeftMs, rematch.blackTimeLeftMs, rematch.rated],
      [alice.id, 60, 300, 60_000, 300_000, false]
    );
  });

  test("the same clock for both is an ordinary rated game", async () => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    na.send({
      type: "challenge_sent",
      data: { challengedId: bob.id, color: "white", time: 180, opponentTime: 180, increment: 0 },
    });
    const received = await nb.next("challenge_received");
    assert.deepEqual([received.data.ownTime, received.data.opponentTime], [null, null]);
    nb.send({ type: "challenge_accepted", data: { challengerId: alice.id } });
    const created = await na.next("match_created");
    assert.equal(created.data.rated, true);
    const row = await gameRow(created.data.gameId);
    assert.deepEqual([row.whiteTime, row.blackTime, row.rated, row.whiteTimeLeftMs], [null, null, true, 180_000]);

    const ga = await open(`/game/${created.data.gameId}`, alice.clerkId);
    await ga.next("initial_game_state");
    ga.send({ type: "resign" });
    const ended = await ga.next("game_ended");
    assert.ok(ended.ratingChanges);
  });

  test("a series keeps each player's clock as colours alternate", async () => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    na.send({
      type: "challenge_sent",
      data: { challengedId: bob.id, color: "white", time: 60, opponentTime: 300, increment: 0, bestOf: 3 },
    });
    await nb.next("challenge_received");
    nb.send({ type: "challenge_accepted", data: { challengerId: alice.id } });
    let gameId: number = (await na.next("match_created")).data.gameId;
    const first = await gameRow(gameId);
    assert.deepEqual([first.whiteId, first.whiteTime, first.blackTime, first.rated], [alice.id, 60, 300, false]);

    let ga = await open(`/game/${gameId}`, alice.clerkId);
    const gb = await open(`/game/${gameId}`, bob.clerkId);
    const state = await ga.next("initial_game_state");
    assert.deepEqual([state.data.series.playerOne.time, state.data.series.playerTwo.time], [60, 300]);
    await gb.next("initial_game_state");
    ga.send({ type: "resign" });
    await ga.next("game_ended");

    // Game 2 through the rematch button: colours swap, clocks stay with the players
    gb.send({ type: "rematch_request" });
    await ga.next("rematch_request");
    ga.send({ type: "rematch_response", data: { accepted: true } });
    gameId = (await ga.next("match_found")).data.gameId;
    const second = await gameRow(gameId);
    assert.deepEqual([second.whiteId, second.whiteTime, second.blackTime], [bob.id, 300, 60]);

    // Bob aborts it; game 2 is then started again from a challenge to continue the series
    const gb2 = await open(`/game/${gameId}`, bob.clerkId);
    await gb2.next("initial_game_state");
    gb2.send({ type: "abort" });
    await gb2.next("game_ended");
    nb.send({
      type: "challenge_sent",
      data: { challengedId: alice.id, color: "white", time: 60, increment: 0, seriesId: first.seriesId },
    });
    const continued = await na.next("challenge_received");
    assert.deepEqual(
      [continued.data.time, continued.data.ownTime, continued.data.opponentTime, continued.data.seriesGame],
      [300, 60, 300, 2]
    );
    na.send({ type: "challenge_accepted", data: { challengerId: bob.id } });
    // (Bob's socket still holds the first game's match_created; Alice's doesn't)
    gameId = (await na.next("match_created")).data.gameId;
    const again = await gameRow(gameId);
    assert.deepEqual(
      [again.whiteId, again.whiteTime, again.blackTime, again.seriesId, again.rated],
      [bob.id, 300, 60, first.seriesId, false]
    );
    ga = await open(`/game/${gameId}`, alice.clerkId);
    await ga.next("initial_game_state");
  });

  test("a clock outside the allowed range is refused", async () => {
    const na = await open("/notifications", alice.clerkId);
    const nb = await open("/notifications", bob.clerkId);
    na.send({
      type: "challenge_sent",
      data: { challengedId: bob.id, color: "white", time: 60, opponentTime: 5, increment: 0 },
    });
    await nb.none("challenge_received");
  });
});
