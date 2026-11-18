import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createUser, integrationEnabled, resetDb, startTestApp } from "./helpers.js";
import { createGame } from "../src/services/gameService.js";
import { SHARE_TOKEN_PATTERN, newShareToken } from "../src/utils/shareToken.js";

describe("shared games", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let white: { id: number; clerkId: string };
  let black: { id: number; clerkId: string };
  let other: { id: number; clerkId: string };

  /** `clerkId` null: no Authorization header at all (someone who isn't signed in). */
  const request = async (clerkId: string | null, method: "GET" | "POST" | "DELETE", path: string) => {
    const res = await fetch(`http://${baseUrl}/api${path}`, {
      method,
      headers: clerkId ? { authorization: `Bearer ${clerkId}` } : {},
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as any) : null };
  };
  const share = (clerkId: string | null, gameId: number) => request(clerkId, "POST", `/games/${gameId}/share`);
  const unshare = (clerkId: string | null, gameId: number) => request(clerkId, "DELETE", `/games/${gameId}/share`);
  const open = (token: string, clerkId: string | null = null) => request(clerkId, "GET", `/shared-games/${token}`);

  const newGame = () =>
    app.pg.transact((tx) => createGame(tx, { whiteId: white.id, blackId: black.id, time: 180, increment: 2 }));
  /** A game with a couple of moves that white then resigned. */
  const finishedGame = async () => {
    const game = await newGame();
    await app.liveGames.move(game.id, white.id, { from: "e2", to: "e4" });
    await app.liveGames.move(game.id, black.id, { from: "e7", to: "e5" });
    await app.liveGames.resign(game.id, white.id);
    return game;
  };

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(app);
    white = await createUser(app, "sharer", 1500);
    black = await createUser(app, "opponent", 1480);
    other = await createUser(app, "bystander");
  });

  test("a player gets one link for a finished game, and anyone can open it", async () => {
    const game = await finishedGame();

    const first = await share(white.clerkId, game.id);
    assert.equal(first.status, 200);
    assert.match(first.body.token, SHARE_TOKEN_PATTERN);
    // The same link again, and for the other player too
    assert.equal((await share(white.clerkId, game.id)).body.token, first.body.token);
    assert.equal((await share(black.clerkId, game.id)).body.token, first.body.token);

    // No sign-in needed
    const opened = await open(first.body.token);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.id, game.id);
    assert.equal(opened.body.status, "finished");
    assert.equal(opened.body.result, "black_win");
    assert.equal(opened.body.endReason, "resignation");
    assert.match(opened.body.pgn, /1\. e4 e5/);
    assert.equal(opened.body.time, 180);
    assert.equal(opened.body.increment, 2);
    assert.deepEqual(
      [opened.body.whitePlayer.username, opened.body.whitePlayer.rating, opened.body.blackPlayer.username],
      ["sharer", 1500, "opponent"]
    );
    // The same game a signed-in user gets, and nothing more: no link, no e-mail
    const signedIn = await request(other.clerkId, "GET", `/games/${game.id}`);
    assert.deepEqual(opened.body, signedIn.body);
    assert.ok(!JSON.stringify(opened.body).includes(first.body.token));
    assert.ok(!JSON.stringify(opened.body).includes("@test.local"));
    assert.ok(!("shareToken" in signedIn.body));
    // A signed-in visitor gets it the same way
    assert.equal((await open(first.body.token, other.clerkId)).status, 200);
    assert.match(opened.headers.get("cache-control") ?? "", /private/);
  });

  test("only the players can share, and only once the game is over", async () => {
    const live = await newGame();
    assert.equal((await share(null, live.id)).status, 401);
    assert.deepEqual(await share(white.clerkId, live.id).then((r) => [r.status, r.body.code]), [
      409,
      "GAME_NOT_FINISHED",
    ]);
    // A game in progress has no link, even if a token were on its row
    const planted = newShareToken();
    await app.pg.query(`UPDATE games SET "shareToken" = $2 WHERE id = $1`, [live.id, planted]);
    assert.equal((await open(planted)).status, 404);
    await app.pg.query(`UPDATE games SET "shareToken" = NULL WHERE id = $1`, [live.id]);

    await app.liveGames.abort(live.id, white.id);
    assert.deepEqual(await share(white.clerkId, live.id).then((r) => [r.status, r.body.code]), [409, "GAME_ABORTED"]);

    const game = await finishedGame();
    assert.deepEqual(await share(other.clerkId, game.id).then((r) => [r.status, r.body.code]), [403, "NOT_YOUR_GAME"]);
    assert.deepEqual(await share(white.clerkId, 999_999).then((r) => [r.status, r.body.code]), [404, "GAME_NOT_FOUND"]);
    assert.equal((await share(white.clerkId, "abc" as unknown as number)).status, 400);
    // Nothing above made a link
    const { rows } = await app.pg.query(`SELECT count(*)::int AS n FROM games WHERE "shareToken" IS NOT NULL`);
    assert.equal(rows[0].n, 0);
  });

  test("links that don't exist all look the same", async () => {
    const game = await finishedGame();
    const { token } = (await share(white.clerkId, game.id)).body;
    for (const bad of [newShareToken(), "short", `${token}x`, token.slice(1), "a".repeat(90), "%27%20OR%201=1", String(game.id)]) {
      const res = await open(bad);
      assert.deepEqual([res.status, res.body.code], [404, "SHARED_GAME_NOT_FOUND"], bad);
    }
  });

  test("either player can turn the link off; sharing again makes a new one", async () => {
    const game = await finishedGame();
    const { token } = (await share(white.clerkId, game.id)).body;

    assert.equal((await unshare(null, game.id)).status, 401);
    assert.equal((await unshare(other.clerkId, game.id)).status, 403);
    assert.equal((await unshare(white.clerkId, 999_999)).status, 404);
    assert.equal((await open(token)).status, 200);

    assert.equal((await unshare(black.clerkId, game.id)).status, 204);
    assert.equal((await open(token)).status, 404);
    // Off already: still fine
    assert.equal((await unshare(white.clerkId, game.id)).status, 204);

    const again = (await share(black.clerkId, game.id)).body.token;
    assert.notEqual(again, token);
    assert.equal((await open(token)).status, 404);
    assert.equal((await open(again)).status, 200);
  });

  test("a bot game can be shared by the one who played it", async () => {
    const saved = await fetch(`http://${baseUrl}/api/games/bot`, {
      method: "POST",
      headers: { authorization: `Bearer ${white.clerkId}`, "content-type": "application/json" },
      body: JSON.stringify({
        botId: "casual-bot",
        color: "black",
        pgn: "1. f3 e5 2. g4 Qh4# 0-1",
        endReason: "checkmate",
      }),
    });
    assert.equal(saved.status, 201);
    const { id } = (await saved.json()) as { id: number };

    assert.equal((await share(black.clerkId, id)).status, 403);
    const { token } = (await share(white.clerkId, id)).body;
    const opened = await open(token);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.botId, "casual-bot");
    assert.equal(opened.body.whitePlayer.id, null);
    assert.equal(opened.body.blackPlayer.username, "sharer");
  });

  test("a shared game of a deleted account no longer names them", async () => {
    const game = await finishedGame();
    const { token } = (await share(black.clerkId, game.id)).body;
    const deleted = await request(white.clerkId, "DELETE", "/users/me");
    assert.equal(deleted.status, 204);

    const opened = await open(token);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.whitePlayer.username, `deleted-${white.id}`);
    assert.equal(opened.body.whitePlayer.avatarUrl, null);
    assert.equal(opened.body.blackPlayer.username, "opponent");
  });

  test("the public route is limited per address", async () => {
    const game = await finishedGame();
    const { token } = (await share(white.clerkId, game.id)).body;
    // 60 a minute for this address, counting the requests of the tests above
    const statuses = await Promise.all(Array.from({ length: 70 }, () => open(token).then((r) => r.status)));
    const served = statuses.filter((s) => s === 200).length;
    assert.ok(served > 0 && served <= 60, `${served} served`);
    assert.equal(statuses.filter((s) => s === 429).length, 70 - served);
    // Signed-in routes are counted per user, so the player is unaffected
    assert.equal((await share(white.clerkId, game.id)).status, 200);
  });
});
