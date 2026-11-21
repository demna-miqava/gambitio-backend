import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { MAX_PENDING_INVITES } from "../src/services/puzzleDuelService.js";
import { createGame } from "../src/services/gameService.js";
import { isRatedPool } from "../src/services/puzzleService.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";

/** Puzzles for these tests, all in the unrated half (ids end in an odd character code: "a") */
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const TEST_PUZZLES = Array.from({ length: 30 }, (_, i) => ({
  id: `zduel${String(i).padStart(2, "0")}a`,
  // Three plies: the solver's e4, the reply e5, the solver's Nf3
  fen: START,
  moves: "e2e4 e7e5 g1f3",
  rating: 600 + i * 45,
}));

describe("puzzle duels", { skip }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const sockets: TestSocket[] = [];
  let alice: { id: number; clerkId: string };
  let bob: { id: number; clerkId: string };
  let carol: { id: number; clerkId: string };

  const request = (method: "GET" | "POST", url: string, who: { clerkId: string }, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${who.clerkId}` }, ...(payload && { payload }) });
  const befriend = (a: number, b: number) =>
    app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [a, b]);
  const notifications = async (who: { clerkId: string }) => {
    const socket = await connect(baseUrl, "/notifications", who.clerkId);
    sockets.push(socket);
    return socket;
  };
  const invite = (from: { clerkId: string }, to: { id: number }) =>
    request("POST", "/api/puzzle-duels/invites", from, { recipientId: to.id });
  /** Alice invites Bob, Bob accepts, and the countdown is skipped */
  const startDuel = async () => {
    const inv = (await invite(alice, bob)).json().data;
    const accepted = await request("POST", `/api/puzzle-duels/invites/${inv.id}/accept`, bob);
    assert.equal(accepted.statusCode, 200, accepted.body);
    const { duelId } = accepted.json().data;
    await app.pg.query(
      `UPDATE puzzle_duels SET "startsAt" = now() - interval '1 second', "endsAt" = now() + interval '3 minutes'
       WHERE id = $1`,
      [duelId]
    );
    return duelId as number;
  };
  const state = async (duelId: number, who: { clerkId: string }) => {
    const res = await request("GET", `/api/puzzle-duels/${duelId}`, who);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data;
  };
  const move = (duelId: number, who: { clerkId: string }, index: number, uci: string) =>
    request("POST", `/api/puzzle-duels/${duelId}/moves`, who, { index, move: uci });
  /** The stored solution of the duel's puzzle at `index` */
  const solutionOf = async (duelId: number, index: number) => {
    const { rows } = await app.pg.query<{ moves: string }>(
      `SELECT p.moves FROM puzzle_duels d JOIN puzzles p ON p.id = d."puzzleIds"[$2::int + 1] WHERE d.id = $1`,
      [duelId, index]
    );
    return rows[0]!.moves.split(" ");
  };
  /** Solves the puzzle at `index` with its solution's moves */
  const solve = async (duelId: number, who: { clerkId: string }, index: number) => {
    const line = await solutionOf(duelId, index);
    let last;
    for (let i = 0; i < line.length; i += 2) {
      last = await move(duelId, who, index, line[i]!);
      assert.equal(last.statusCode, 200, last.body);
    }
    return last!.json().data;
  };
  /** A legal move that isn't the solution's first move */
  const wrongMove = async (duelId: number, who: { clerkId: string }, index: number) => {
    const line = await solutionOf(duelId, index);
    const { Chess } = await import("chess.js");
    const { rows } = await app.pg.query<{ fen: string }>(
      `SELECT p.fen FROM puzzle_duels d JOIN puzzles p ON p.id = d."puzzleIds"[$2::int + 1] WHERE d.id = $1`,
      [duelId, index]
    );
    const chess = new Chess(rows[0]!.fen);
    const other = chess.moves({ verbose: true }).find((m) => {
      const uci = m.from + m.to + (m.promotion ?? "");
      if (uci === line[0]) return false;
      const after = new Chess(rows[0]!.fen);
      after.move(m);
      return !after.isCheckmate();
    })!;
    const res = await move(duelId, who, index, other.from + other.to + (other.promotion ?? ""));
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data;
  };

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
    for (const p of TEST_PUZZLES) {
      assert.equal(isRatedPool(p.id), false);
      await app.pg.query(
        `INSERT INTO puzzles (id, fen, moves, rating, themes) VALUES ($1, $2, $3, $4, '{}') ON CONFLICT (id) DO NOTHING`,
        [p.id, p.fen, p.moves, p.rating]
      );
    }
  });
  after(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
    await app.pg.query(`DELETE FROM puzzles WHERE id LIKE 'zduel%'`);
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
    alice = await createUser(app, "alice");
    bob = await createUser(app, "bob");
    carol = await createUser(app, "carol");
    await befriend(alice.id, bob.id);
  });

  test("an invite reaches a friend live; strangers, blocks and floods are refused", async () => {
    const bobInbox = await notifications(bob);
    const aliceInbox = await notifications(alice);
    const res = await invite(alice, bob);
    assert.equal(res.statusCode, 201, res.body);
    const got = await bobInbox.next("duel_invite");
    assert.equal(got.data.from.username, "alice");
    assert.ok(new Date(got.data.expiresAt).getTime() > Date.now());
    await aliceInbox.next("duel_invite_sent");
    assert.equal((await invite(alice, bob)).json().code, "ALREADY_INVITED");
    assert.equal((await request("GET", "/api/puzzle-duels/invites", bob)).json().data.incoming.length, 1);

    // Not friends
    assert.equal((await invite(alice, carol)).statusCode, 403);
    // A block either way, even between friends
    await befriend(alice.id, carol.id);
    await app.pg.query(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [carol.id, alice.id]);
    assert.equal((await invite(alice, carol)).json().code, "NOT_FRIENDS");
    assert.equal((await invite(carol, alice)).json().code, "NOT_FRIENDS");

    // Bob declines; Alice hears
    await request("POST", `/api/puzzle-duels/invites/${got.data.id}/decline`, bob);
    assert.equal((await aliceInbox.next("duel_invite_closed")).data.status, "declined");

    // At most a few waiting at once
    const friends = [];
    for (let i = 0; i < MAX_PENDING_INVITES + 1; i++) {
      const f = await createUser(app, `friend${i}`);
      await befriend(alice.id, f.id);
      friends.push(f);
    }
    for (let i = 0; i < MAX_PENDING_INVITES; i++) assert.equal((await invite(alice, friends[i]!)).statusCode, 201);
    assert.equal((await invite(alice, friends[MAX_PENDING_INVITES]!)).json().code, "TOO_MANY_INVITES");
  });

  test("invites lapse after a few minutes", async () => {
    const aliceInbox = await notifications(alice);
    const inv = (await invite(alice, bob)).json().data;
    await app.pg.query(`UPDATE puzzle_duel_invites SET "expiresAt" = now() - interval '1 second'`);
    assert.equal((await request("POST", `/api/puzzle-duels/invites/${inv.id}/accept`, bob)).statusCode, 404);
    await app.puzzleDuels.sweep();
    assert.equal((await aliceInbox.next("duel_invite_closed")).data.status, "expired");
    // And Alice can invite again
    assert.equal((await invite(alice, bob)).statusCode, 201);
  });

  test("both players get the same puzzles in the same order, getting harder, without solutions", async () => {
    const aliceInbox = await notifications(alice);
    const duelId = await startDuel();
    assert.equal((await aliceInbox.next("duel_started")).data.duelId, duelId);

    const a = await state(duelId, alice);
    const b = await state(duelId, bob);
    assert.deepEqual(a.puzzle, b.puzzle);
    assert.equal(a.puzzle.index, 0);
    // Neither the id nor the solution is sent while it's being played
    assert.equal("puzzleId" in a.puzzle, false);
    assert.equal("solution" in a.puzzle, false);
    assert.deepEqual(a.puzzle.played, []);
    assert.deepEqual(a.finishedPuzzles, []);

    const { rows } = await app.pg.query<{ puzzleIds: string[] }>(`SELECT "puzzleIds" FROM puzzle_duels`);
    const ids = rows[0]!.puzzleIds;
    assert.ok(ids.length >= 10);
    assert.ok(ids.every((id) => !isRatedPool(id)), "only the unrated half");
    const { rows: ratings } = await app.pg.query<{ id: string; rating: number }>(
      `SELECT id, rating FROM puzzles WHERE id = ANY($1::text[])`,
      [ids]
    );
    const byId = new Map(ratings.map((r) => [r.id, r.rating]));
    const ladder = ids.map((id) => byId.get(id)!);
    assert.deepEqual(ladder, [...ladder].sort((x, y) => x - y), "easiest first");

    // A move in the middle of a puzzle answers with the reply only
    const first = await move(duelId, alice, 0, (await solutionOf(duelId, 0))[0]!);
    const body = first.json().data;
    if (body.outcome === "continue") {
      assert.equal(body.finishedPuzzle, null);
      assert.equal(JSON.stringify(body).includes("solution"), false);
    }
  });

  test("scoring, strikes and live progress; three strikes and you're out; both out ends it", async () => {
    const aliceInbox = await notifications(alice);
    const bobInbox = await notifications(bob);
    const duelId = await startDuel();

    const solved = await solve(duelId, alice, 0);
    assert.equal(solved.outcome, "solved");
    assert.equal(solved.score, 1);
    assert.equal(solved.finishedPuzzle.index, 0);
    assert.ok(solved.finishedPuzzle.solution.length > 0);
    assert.equal(solved.nextPuzzle.index, 1);
    // Bob sees Alice's score, not her board
    const progress = await bobInbox.next("duel_progress");
    assert.deepEqual(progress.data, { duelId, userId: alice.id, score: 1, strikes: 0, out: false });

    const missed = await wrongMove(duelId, bob, 0);
    assert.equal(missed.outcome, "wrong");
    assert.equal(missed.strikes, 1);
    assert.equal(missed.finishedPuzzle.index, 0, "the missed puzzle comes back with its solution");
    assert.equal(missed.nextPuzzle.index, 1, "and Bob moves on");
    await aliceInbox.next("duel_progress", (m) => m.data.userId === bob.id);

    // A stale or illegal move costs nothing
    assert.equal((await move(duelId, bob, 0, "e2e4")).json().code, "STALE_PUZZLE");
    assert.equal((await move(duelId, bob, 1, "e2e5")).json().code, "ILLEGAL_MOVE");

    await wrongMove(duelId, bob, 1);
    const third = await wrongMove(duelId, bob, 2);
    assert.equal(third.out, true);
    assert.equal(third.nextPuzzle, null);
    assert.equal((await move(duelId, bob, 3, "e2e4")).json().code, "DUEL_OUT");

    // Alice goes on alone, then strikes out too: the duel ends
    await solve(duelId, alice, 1);
    for (const index of [2, 3, 4]) await wrongMove(duelId, alice, index);
    const ended = await bobInbox.next("duel_ended");
    assert.equal(ended.data.winnerId, alice.id);
    assert.equal(ended.data.endReason, "both_out");

    // The result: both players' right and wrong, every puzzle either reached, in full
    const result = await state(duelId, bob);
    assert.equal(result.status, "finished");
    const aliceRow = result.players.find((p: { userId: number }) => p.userId === alice.id);
    const bobRow = result.players.find((p: { userId: number }) => p.userId === bob.id);
    assert.deepEqual(
      aliceRow.results.map((r: { solved: boolean }) => r.solved),
      [true, true, false, false, false]
    );
    assert.deepEqual(bobRow.results.map((r: { solved: boolean }) => r.solved), [false, false, false]);
    assert.equal(result.finishedPuzzles.length, 5);
    assert.deepEqual(result.finishedPuzzles, (await state(duelId, alice)).finishedPuzzles);
  });

  test("the clock ends the duel; equal scores draw; nothing rated or solved is recorded", async () => {
    const duelId = await startDuel();
    await solve(duelId, alice, 0);
    await solve(duelId, bob, 0);
    await app.pg.query(`UPDATE puzzle_duels SET "endsAt" = now() - interval '1 second' WHERE id = $1`, [duelId]);
    assert.equal((await move(duelId, alice, 1, "e2e4")).json().code, "DUEL_OVER");
    await app.puzzleDuels.sweep();
    const { rows } = await app.pg.query(`SELECT status, "endReason", "winnerId" FROM puzzle_duels WHERE id = $1`, [
      duelId,
    ]);
    assert.deepEqual(rows[0], { status: "finished", endReason: "time", winnerId: null });

    const { rows: users } = await app.pg.query<{ puzzleRating: number; puzzleAttempts: number }>(
      `SELECT "puzzleRating", "puzzleAttempts" FROM users WHERE id = ANY($1::int[])`,
      [[alice.id, bob.id]]
    );
    assert.ok(users.every((u) => u.puzzleAttempts === 0));
    assert.equal((await app.pg.query(`SELECT 1 FROM puzzle_attempts`)).rowCount, 0);
    assert.equal((await app.pg.query(`SELECT 1 FROM solved_puzzles`)).rowCount, 0);
  });

  test("a player who comes back finds the duel where they left it, clock still running", async () => {
    const duelId = await startDuel();
    assert.equal((await request("GET", "/api/puzzle-duels/active", alice)).json().data.duelId, duelId);
    await solve(duelId, alice, 0);
    const line = await solutionOf(duelId, 1);
    const first = (await move(duelId, alice, 1, line[0]!)).json().data;

    const back = await state(duelId, alice);
    assert.equal(back.status, "active");
    assert.ok(back.endsAt > back.serverNow);
    assert.equal(back.puzzle.index, 1);
    if (first.outcome === "continue") assert.deepEqual(back.puzzle.played, line.slice(0, 2));
    assert.equal(back.players.find((p: { userId: number }) => p.userId === alice.id).score, 1);
    // Their finished puzzle is theirs to see in full; the other's progress isn't shown move by move
    assert.equal(back.finishedPuzzles.length, 1);
    const bobView = await state(duelId, bob);
    assert.equal(bobView.finishedPuzzles.length, 0);
    assert.equal("results" in bobView.players.find((p: { userId: number }) => p.userId === alice.id), false);

    // Not for anyone else; not before the countdown; one duel at a time
    assert.equal((await request("GET", `/api/puzzle-duels/${duelId}`, carol)).statusCode, 404);
    await befriend(alice.id, carol.id);
    assert.equal((await invite(alice, carol)).json().code, "IN_DUEL");
  });

  test("moves before the countdown ends are refused, and the puzzle isn't shown yet", async () => {
    const inv = (await invite(alice, bob)).json().data;
    const { duelId } = (await request("POST", `/api/puzzle-duels/invites/${inv.id}/accept`, bob)).json().data;
    const early = await state(duelId, alice);
    assert.equal(early.puzzle, null);
    assert.ok(early.startsAt > early.serverNow);
    assert.equal((await move(duelId, alice, 0, "e2e4")).json().code, "DUEL_NOT_STARTED");
  });

  test("nobody is invited from or into a game being played", async () => {
    await befriend(alice.id, carol.id);
    const game = await app.pg.transact((tx) =>
      createGame(tx, { whiteId: bob.id, blackId: carol.id, time: 300, increment: 0 })
    );
    // Bob is playing: Alice can't invite him, and he can't invite her
    const toPlayer = await invite(alice, bob);
    assert.equal(toPlayer.statusCode, 409, toPlayer.body);
    assert.equal(toPlayer.json().code, "IN_GAME");
    const fromPlayer = await invite(bob, alice);
    assert.equal(fromPlayer.statusCode, 409, fromPlayer.body);
    assert.equal(fromPlayer.json().code, "IN_GAME");
    assert.equal((await app.pg.query(`SELECT 1 FROM puzzle_duel_invites`)).rowCount, 0);
    // Once the game is over, they can
    await app.pg.query(`UPDATE games SET status = 'finished', result = 'draw', "endedAt" = now() WHERE id = $1`, [
      game.id,
    ]);
    assert.equal((await invite(alice, bob)).statusCode, 201);
  });

  test("two friends accepting each other's invite at once start one duel, and both get it", async () => {
    for (let round = 0; round < 5; round++) {
      await app.pg.query(`DELETE FROM puzzle_duel_invites`);
      await app.pg.query(`DELETE FROM puzzle_duels`);
      const toBob = (await invite(alice, bob)).json().data;
      const toAlice = (await invite(bob, alice)).json().data;
      const [byBob, byAlice] = await Promise.all([
        request("POST", `/api/puzzle-duels/invites/${toBob.id}/accept`, bob),
        request("POST", `/api/puzzle-duels/invites/${toAlice.id}/accept`, alice),
      ]);
      assert.equal(byBob.statusCode, 200, byBob.body);
      assert.equal(byAlice.statusCode, 200, byAlice.body);
      assert.equal(byBob.json().data.duelId, byAlice.json().data.duelId);
      assert.equal((await app.pg.query(`SELECT 1 FROM puzzle_duels`)).rowCount, 1);
      assert.equal((await app.pg.query(`SELECT 1 FROM puzzle_duel_invites WHERE status = 'pending'`)).rowCount, 0);
    }
  });

  test("a rematch is an invite the other side gets live", async () => {
    const bobInbox = await notifications(bob);
    const duelId = await startDuel();
    await app.pg.query(`UPDATE puzzle_duels SET "endsAt" = now() - interval '1 second' WHERE id = $1`, [duelId]);
    await app.puzzleDuels.finishIfOver(duelId);
    const res = await request("POST", "/api/puzzle-duels/invites", alice, { recipientId: bob.id, rematchOf: duelId });
    assert.equal(res.statusCode, 201, res.body);
    const rematch = await bobInbox.next("duel_invite", (m) => m.data.rematchOf !== null);
    assert.equal(rematch.data.rematchOf, duelId);
    // Not for a duel between other players, even for a friend of one of them
    await befriend(alice.id, carol.id);
    assert.equal(
      (await request("POST", "/api/puzzle-duels/invites", carol, { recipientId: alice.id, rematchOf: duelId }))
        .statusCode,
      404
    );
  });
});
