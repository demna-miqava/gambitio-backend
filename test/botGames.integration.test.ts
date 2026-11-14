import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, resetDb, startTestApp } from "./helpers.js";

describe("bot games", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let player: { id: number; clerkId: string };

  const request = async (clerkId: string, method: "GET" | "POST", path: string, body?: object) => {
    const res = await fetch(`http://${baseUrl}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${clerkId}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const save = (body: object, clerkId = player.clerkId) => request(clerkId, "POST", "/games/bot", body);

  const userRow = async (userId: number) =>
    (
      await app.pg.query(
        `SELECT "bulletRating", "blitzRating", "rapidRating", "highestBlitzRating",
                "bulletGames", "blitzGames", "rapidGames"
         FROM users WHERE id = $1`,
        [userId]
      )
    ).rows[0];

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(app);
    player = await createUser(app, "botfan", 1350);
  });

  test("a finished bot game is stored unrated and shows up in the history", async () => {
    const before = await userRow(player.id);
    const { status, body: game } = await save({
      botId: "casual-bot",
      color: "black",
      pgn: '[White "Casual Carl"]\n[Black "botfan"]\n\n1. f3 e5 2. g4 Qh4# 0-1',
      endReason: "checkmate",
    });
    assert.equal(status, 201);
    assert.equal(game.status, "finished");
    assert.equal(game.rated, false);
    assert.equal(game.botId, "casual-bot");
    assert.equal(game.result, "black_win");
    assert.equal(game.endReason, "checkmate");
    assert.equal(game.winnerId, player.id);
    assert.equal(game.numMoves, 4);
    assert.equal(game.time, null);
    assert.equal(game.type, null);
    assert.deepEqual(game.whitePlayer, {
      id: null,
      username: "Casual Carl",
      rating: 600,
      avatarUrl: null,
      ratingChange: null,
    });
    assert.equal(game.blackPlayer.id, player.id);
    assert.equal(game.blackPlayer.rating, 1350);
    assert.equal(game.blackPlayer.ratingChange, null);

    // Game by id and history include it
    const byId = await request(player.clerkId, "GET", `/games/${game.id}`);
    assert.equal(byId.status, 200);
    assert.equal(byId.body.botId, "casual-bot");
    const history = await request(player.clerkId, "GET", `/users/${player.id}/games`);
    assert.equal(history.body.pagination.total, 1);
    assert.equal(history.body.data[0].id, game.id);

    // Nothing rating-related moves
    assert.deepEqual(await userRow(player.id), before);
    const stats = await request(player.clerkId, "GET", `/users/${player.id}/stats/summary`);
    assert.equal(stats.body.numberOfGames, 0);
    assert.equal(stats.body.stats.blitz.games, 0);
    const active = await request(player.clerkId, "GET", "/games/active");
    assert.equal(active.body.gameId, null);
    const top = await request(player.clerkId, "GET", "/games/live/top");
    assert.deepEqual(top.body.data, []);
  });

  test("a resignation is a loss for the player; the result comes from the server", async () => {
    const { status, body: game } = await save({
      botId: "club-bot",
      color: "white",
      pgn: "1. e4 e5 2. Nf3",
      endReason: "resignation",
    });
    assert.equal(status, 201);
    assert.equal(game.result, "black_win");
    assert.equal(game.endReason, "resignation");
    assert.equal(game.winnerId, null);
  });

  test("rejects unknown bots, illegal moves and games that aren't over", async () => {
    const unknown = await save({ botId: "nobody", color: "white", pgn: "1. e4", endReason: "resignation" });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, "UNKNOWN_BOT");

    const illegal = await save({ botId: "club-bot", color: "white", pgn: "1. e4 e4", endReason: "resignation" });
    assert.equal(illegal.status, 400);
    assert.equal(illegal.body.code, "INVALID_BOT_GAME");

    const notOver = await save({ botId: "club-bot", color: "white", pgn: "1. e4 e5", endReason: "checkmate" });
    assert.equal(notOver.status, 400);

    const badBody = await save({ botId: "club-bot", color: "green", pgn: "1. e4", endReason: "resignation" });
    assert.equal(badBody.status, 400);
    assert.equal(badBody.body.code, "VALIDATION_ERROR");

    const { rows } = await app.pg.query(`SELECT COUNT(*)::int AS n FROM games`);
    assert.equal(rows[0].n, 0);
  });

  test("a bot game can't be opened as a live game", async () => {
    const { body: game } = await save({
      botId: "club-bot",
      color: "white",
      pgn: "1. e4 e5",
      endReason: "resignation",
    });
    const socket = await connect(baseUrl, `/game/${game.id}`, player.clerkId);
    try {
      const error = await socket.next("error");
      assert.match(error.data.message, /computer/);
    } finally {
      await socket.close();
    }
  });
});
