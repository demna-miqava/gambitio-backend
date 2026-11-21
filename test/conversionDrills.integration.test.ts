import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { Chess } from "chess.js";
import { createUser, integrationEnabled, resetDb, startTestApp } from "./helpers.js";
import { CANDIDATE_WINDOW } from "../src/services/conversionDrillService.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";

// 20 half-moves of an Italian; White is to move after an even number of them
const MOVES = "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O a4 a5 h3 h6 Re1 Re8 Nbd2 Be6".split(" ");
const chess = new Chess();
for (const san of MOVES) chess.move(san);
const PGN = chess.pgn();
const fenAfter = (ply: number) => {
  const c = new Chess();
  for (const san of MOVES.slice(0, ply)) c.move(san);
  return c.fen();
};

describe("conversion drills", { skip }, () => {
  let app: FastifyInstance;
  let alice: { id: number; clerkId: string };
  let bob: { id: number; clerkId: string };

  const request = async (method: "GET" | "POST" | "DELETE", url: string, clerkId: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${clerkId}` }, ...(payload && { payload }) });

  /** A finished game between Alice (White) and Bob */
  const game = async (result: string, { numMoves = MOVES.length, ago = 0 } = {}) =>
    (
      await app.pg.query<{ id: number }>(
        `INSERT INTO games ("whiteId", "blackId", "whiteUsername", "blackUsername", "whiteRating", "blackRating",
           time, increment, status, result, "endReason", "numMoves", pgn, fen, "endedAt", "createdAt")
         VALUES ($1, $2, 'alice', 'bobby', 1200, 1200, 180, 0, 'finished', $3, 'resignation', $4, $5, '', now(),
           now() - make_interval(mins => $6))
         RETURNING id`,
        [alice.id, bob.id, result, numMoves, PGN, ago]
      )
    ).rows[0]!.id;

  before(async () => {
    ({ app } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(app);
    alice = await createUser(app, "alice");
    bob = await createUser(app, "bobby");
  });

  test("only games the player didn't win are scanned, newest first, and once", async () => {
    const lost = await game("black_win", { ago: 3 });
    const drawn = await game("draw", { ago: 2 });
    await game("white_win", { ago: 1 });
    await game("aborted");
    await game("draw", { numMoves: 6 });

    const forAlice = (await request("GET", "/api/conversion-drills/candidates", alice.clerkId)).json();
    assert.deepEqual(
      forAlice.games.map((g: any) => [g.gameId, g.color]),
      [
        [drawn, "white"],
        [lost, "white"],
      ]
    );
    assert.equal(forAlice.games[0].pgn, PGN);
    // Bob won one of them: his are the draw and the game Alice won
    const forBob = (await request("GET", "/api/conversion-drills/candidates", bob.clerkId)).json();
    assert.equal(forBob.games.length, 2);
    assert.ok(forBob.games.every((g: any) => g.color === "black" && g.gameId !== lost));

    const none = await request("POST", "/api/conversion-drills/scans", alice.clerkId, { gameId: drawn, drill: null });
    assert.deepEqual(none.json(), { drill: null });
    const after = (await request("GET", "/api/conversion-drills/candidates", alice.clerkId)).json();
    assert.deepEqual(
      after.games.map((g: any) => g.gameId),
      [lost]
    );
  });

  test("only each colour's most recent CANDIDATE_WINDOW games are looked through", async () => {
    // An old loss, then a window's worth of newer games Alice won
    const old = await game("black_win", { ago: CANDIDATE_WINDOW + 10 });
    await app.pg.query(
      `INSERT INTO games ("whiteId", "blackId", "whiteUsername", "blackUsername", "whiteRating", "blackRating",
         time, increment, status, result, "endReason", "numMoves", pgn, fen, "endedAt", "createdAt")
       SELECT $1, $2, 'alice', 'bobby', 1200, 1200, 180, 0, 'finished', 'white_win', 'resignation', $3, $4, '', now(),
         now() - make_interval(mins => n)
       FROM generate_series(1, ${CANDIDATE_WINDOW}) n`,
      [alice.id, bob.id, MOVES.length, PGN]
    );
    const candidates = async () =>
      (await request("GET", "/api/conversion-drills/candidates", alice.clerkId)).json().games.map((g: any) => g.gameId);
    assert.deepEqual(await candidates(), []);
    // One game fewer in the window, and the loss is in it again
    await app.pg.query(
      `DELETE FROM games WHERE id = (SELECT id FROM games WHERE "whiteId" = $1 AND result = 'white_win'
         ORDER BY "createdAt" DESC LIMIT 1)`,
      [alice.id]
    );
    assert.deepEqual(await candidates(), [old]);
    // As Black, Alice's games are a window of their own
    const asBlack = (
      await app.pg.query<{ id: number }>(
        `INSERT INTO games ("whiteId", "blackId", "whiteUsername", "blackUsername", "whiteRating", "blackRating",
           time, increment, status, result, "endReason", "numMoves", pgn, fen, "endedAt")
         VALUES ($1, $2, 'bobby', 'alice', 1200, 1200, 180, 0, 'finished', 'draw', 'draw_agreement', $3, $4, '', now())
         RETURNING id`,
        [bob.id, alice.id, MOVES.length, PGN]
      )
    ).rows[0]!.id;
    assert.deepEqual(await candidates(), [asBlack, old]);
  });

  test("a reported position becomes a drill computed from the game itself", async () => {
    const gameId = await game("draw");
    const res = await request("POST", "/api/conversion-drills/scans", alice.clerkId, {
      gameId,
      drill: { ply: 12, eval: { cp: 420 } },
    });
    assert.equal(res.statusCode, 200);
    const { drill } = res.json();
    assert.deepEqual(
      [drill.gameId, drill.ply, drill.fen, drill.color, drill.eval, drill.attempts],
      [gameId, 12, fenAfter(12), "white", { cp: 420 }, 0]
    );
    assert.deepEqual(drill.game.opponent, { id: bob.id, username: "bobby", avatarUrl: null });
    assert.equal(drill.game.result, "draw");

    // A second report for the same game keeps the first drill
    await request("POST", "/api/conversion-drills/scans", alice.clerkId, {
      gameId,
      drill: { ply: 14, eval: { mate: 3 } },
    });
    const { drills } = (await request("GET", "/api/conversion-drills", alice.clerkId)).json();
    assert.deepEqual(
      drills.map((d: any) => d.ply),
      [12]
    );
    // Not Bob's
    assert.equal((await request("GET", `/api/conversion-drills/${drill.id}`, bob.clerkId)).statusCode, 404);
  });

  test("positions that aren't the player's, aren't winning, or come from a won game are refused", async () => {
    const drawn = await game("draw");
    const won = await game("white_win");
    const scan = (clerkId: string, gameId: number, drill: object | null) =>
      request("POST", "/api/conversion-drills/scans", clerkId, { gameId, drill });

    // Black is to move after 13 half-moves
    assert.equal((await scan(alice.clerkId, drawn, { ply: 13, eval: { cp: 500 } })).json().code, "BAD_POSITION");
    assert.equal((await scan(alice.clerkId, drawn, { ply: 40, eval: { cp: 500 } })).json().code, "BAD_POSITION");
    assert.equal((await scan(alice.clerkId, drawn, { ply: 12, eval: { cp: 120 } })).json().code, "NOT_WINNING");
    assert.equal((await scan(alice.clerkId, drawn, { ply: 12, eval: { mate: -2 } })).json().code, "NOT_WINNING");
    assert.equal((await scan(alice.clerkId, won, { ply: 12, eval: { cp: 500 } })).json().code, "NOT_A_MISSED_WIN");
    const carol = await createUser(app, "carol");
    assert.equal((await scan(carol.clerkId, drawn, null)).statusCode, 404);
    // Nothing was stored, and the game is still to be scanned
    assert.equal((await request("GET", "/api/conversion-drills", alice.clerkId)).json().drills.length, 0);
    assert.equal(
      (await request("GET", "/api/conversion-drills/candidates", alice.clerkId)).json().games.length,
      1
    );
  });

  test("attempts are counted and schedule the next review", async () => {
    const gameId = await game("black_win");
    const { drill } = (
      await request("POST", "/api/conversion-drills/scans", alice.clerkId, {
        gameId,
        drill: { ply: 10, eval: { cp: 350 } },
      })
    ).json();
    const attempt = async (success: boolean, moves: number) =>
      (await request("POST", `/api/conversion-drills/${drill.id}/attempts`, alice.clerkId, { success, moves })).json()
        .drill;

    const failed = await attempt(false, 12);
    assert.deepEqual([failed.attempts, failed.successes, failed.streak, failed.bestMoves], [1, 0, 0, null]);
    assert.ok(new Date(failed.dueAt).getTime() <= Date.now());

    const converted = await attempt(true, 30);
    assert.deepEqual([converted.attempts, converted.successes, converted.streak, converted.bestMoves], [2, 1, 1, 30]);
    const days = (new Date(converted.dueAt).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 0.9 && days < 1.1, `due in ${days} days`);

    const again = await attempt(true, 24);
    assert.deepEqual([again.streak, again.bestMoves], [2, 24]);
    assert.ok((new Date(again.dueAt).getTime() - Date.now()) / 86_400_000 > 2.9);

    // Several at once (connections opened first, so they really overlap):
    // each counts, and the streak counts all of them
    await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => app.pg.query(`SELECT pg_sleep(0.02)`)));
    await Promise.all([1, 2, 3].map(() => attempt(true, 40)));
    const after = (await request("GET", "/api/conversion-drills", alice.clerkId)).json().drills[0];
    assert.deepEqual([after.attempts, after.successes, after.streak], [6, 5, 5]);

    assert.equal((await request("DELETE", `/api/conversion-drills/${drill.id}`, alice.clerkId)).statusCode, 204);
    assert.equal((await request("GET", "/api/conversion-drills", alice.clerkId)).json().drills.length, 0);
  });
});
