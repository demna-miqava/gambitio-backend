import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMove, loadGame, timeoutOutcome } from "../src/game/engine.js";
import {
  addTime,
  afterMove,
  chargedTime,
  deadline,
  FIRST_MOVE_TIMEOUT_MS,
  INITIAL_LAG_BUDGET_MS,
  isFlagged,
  LAG_BUDGET_REFILL_MS,
  MAX_CLOCK_MS,
  MAX_LAG_COMPENSATION_MS,
  remainingAt,
} from "../src/game/clock.js";
import { calculateRatingChanges, RATING_FLOOR } from "../src/utils/ratingHelpers.js";
import { ratingRangeFor } from "../src/services/matchmakingService.js";
import { redactUrl } from "../src/app.js";
import { toSolverFirst } from "../scripts/import-lichess-puzzles.js";
import { readFileSync } from "node:fs";
import { Chess } from "chess.js";

function play(moves: string[]) {
  let pgn = "";
  let last;
  for (const m of moves) {
    last = applyMove(pgn, { from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] as "q" | undefined });
    assert.ok(last.ok, `move ${m} should be legal`);
    pgn = last.pgn;
  }
  return last!;
}

test("rejects illegal moves without throwing", () => {
  assert.deepEqual(applyMove("", { from: "e2", to: "e5" }), { ok: false, reason: "Illegal move" });
  assert.equal(applyMove("", { from: "e7", to: "e5" }).ok, false, "black can't move first");
});

test("detects checkmate with the right winner", () => {
  const result = play(["f2f3", "e7e5", "g2g4", "d8h4"]);
  assert.ok(result.ok);
  assert.deepEqual(result.outcome, { result: "black_win", reason: "checkmate" });
});

test("detects threefold repetition", () => {
  const result = play(["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"]);
  assert.ok(result.ok);
  assert.deepEqual(result.outcome, { result: "draw", reason: "threefold_repetition" });
});

test("timeout against a lone king is a draw", () => {
  const chess = loadGame(null);
  chess.load("4k3/8/8/8/8/8/8/4K2Q w - - 0 1");
  // Black has only a king, so white flagging can't lose
  assert.deepEqual(timeoutOutcome(chess, "white"), {
    result: "draw",
    reason: "timeout_vs_insufficient_material",
  });
  assert.deepEqual(timeoutOutcome(chess, "black"), { result: "white_win", reason: "timeout" });
});

test("clock does not run before both first moves, then counts down with increment", () => {
  const start = { whiteMs: 60_000, blackMs: 60_000, lastMoveAt: 0, ply: 0 };
  assert.equal(deadline(start), FIRST_MOVE_TIMEOUT_MS);
  const afterWhite = afterMove(start, 10_000, 2_000);
  assert.equal(afterWhite.whiteMs, 60_000, "first move is free and gets no increment");
  const afterBlack = afterMove(afterWhite, 15_000, 2_000);
  assert.equal(afterBlack.blackMs, 60_000);

  // From ply 2 on, white's clock runs
  assert.deepEqual(remainingAt(afterBlack, 25_000), { whiteMs: 50_000, blackMs: 60_000 });
  const third = afterMove(afterBlack, 25_000, 2_000);
  assert.equal(third.whiteMs, 52_000);
  // The deadline waits for a move that may still be on its way
  assert.equal(deadline(third), 25_000 + 60_000 + MAX_LAG_COMPENSATION_MS);
  assert.equal(isFlagged(third, 85_000), true);
  assert.equal(isFlagged(third, 84_999), false);
});

test("network delay is forgiven as far as the server can back it up", () => {
  // Black to move with 2s left, the clock running since t=10s
  const state = { whiteMs: 30_000, blackMs: 2_000, lastMoveAt: 10_000, ply: 21 };

  // Black moved with 0.14s left on their screen; the move reached the
  // server 400ms of network later, after the 2s were up there. The server
  // measured a 380ms round trip on their socket
  const arrived = 10_000 + 2_000 + 400 - 140;
  const timing = { thinkMs: 1_860, measuredRttMs: 380 };
  assert.equal(isFlagged(state, arrived), true, "without a report, the server's time counts");
  assert.equal(isFlagged(state, arrived, timing), false);
  const after = afterMove(state, arrived, 0, timing);
  assert.equal(after.blackMs, 140);
  assert.equal(after.blackLagBudgetMs, INITIAL_LAG_BUDGET_MS + LAG_BUDGET_REFILL_MS, "measured: no budget spent");
  assert.equal(after.whiteLagBudgetMs, undefined, "the other player's budget is untouched");

  // Never more than MAX_LAG_COMPENSATION_MS, whatever was measured
  assert.equal(chargedTime(state, 15_000, { thinkMs: 0, measuredRttMs: 5_000 }), 5_000 - MAX_LAG_COMPENSATION_MS);
  assert.equal(isFlagged(state, 10_000 + 2_000 + MAX_LAG_COMPENSATION_MS, { thinkMs: 0, measuredRttMs: 5_000 }), true);
  // ...and never more than the server measured
  assert.equal(chargedTime(state, 11_000, { thinkMs: 9_999 }), 1_000);
  // No time is charged before both first moves
  assert.equal(chargedTime({ ...state, ply: 1 }, 50_000, { thinkMs: 40_000 }), 0);
});

test("given time is added to time left now and moves the deadline", () => {
  // Black to move since t=10s with 5s stored: 2s left at t=13s
  const state = { whiteMs: 30_000, blackMs: 5_000, lastMoveAt: 10_000, ply: 21 };
  const given = addTime(state, "black", 10_000);
  assert.deepEqual(remainingAt(given, 13_000), { whiteMs: 30_000, blackMs: 12_000 });
  assert.equal(deadline(given), deadline(state) + 10_000);
  assert.equal(given.lastMoveAt, state.lastMoveAt);

  // Time for the side not to move just waits on their clock
  const toWhite = addTime(state, "white", 10_000);
  assert.equal(toWhite.whiteMs, 40_000);
  assert.equal(deadline(toWhite), deadline(state));

  // Capped
  assert.equal(addTime({ ...state, whiteMs: MAX_CLOCK_MS - 1_000 }, "white", 10_000).whiteMs, MAX_CLOCK_MS);
  assert.equal(addTime({ ...state, whiteMs: MAX_CLOCK_MS + 5 }, "white", 10_000).whiteMs, MAX_CLOCK_MS + 5);
});

test("winner always gains and loser always loses", () => {
  for (const [white, black] of [
    [1400, 800],
    [800, 1400],
    [1200, 1200],
  ] as const) {
    const whiteWins = calculateRatingChanges(white, black, "white_win");
    assert.ok(whiteWins.whiteRatingChange > 0, `${white} beating ${black} gains`);
    assert.ok(whiteWins.blackRatingChange < 0);
    const blackWins = calculateRatingChanges(white, black, "black_win");
    assert.ok(blackWins.blackRatingChange > 0);
    assert.ok(blackWins.whiteRatingChange < 0);
  }
  assert.equal(calculateRatingChanges(1200, 1200, "white_win").whiteRatingChange, 8);
  assert.equal(calculateRatingChanges(1400, 800, "black_win").blackRatingChange, 16, "upsets are capped");
});

test("ratings never drop below the floor", () => {
  const result = calculateRatingChanges(RATING_FLOOR + 2, RATING_FLOOR + 2, "black_win");
  assert.equal(result.whiteNewRating, RATING_FLOOR);
  assert.equal(result.whiteRatingChange, -2);
});

test("draws move ratings toward each other", () => {
  const r = calculateRatingChanges(1300, 1000, "draw");
  assert.equal(r.whiteRatingChange, -6);
  assert.equal(r.blackRatingChange, 6);
  assert.deepEqual(calculateRatingChanges(1000, 1000, "draw").whiteRatingChange, 0);
});

test("matchmaking rating range widens with wait time", () => {
  assert.equal(ratingRangeFor(0), 50);
  assert.equal(ratingRangeFor(5_000), 100);
  assert.equal(ratingRangeFor(10 * 60_000), 500);
});

test("tokens are redacted from logged URLs", () => {
  assert.equal(
    redactUrl("/api/ws/game/5?token=abc.def&x=1"),
    "/api/ws/game/5?token=[REDACTED]&x=1"
  );
});

test("Lichess puzzles are converted so the solver moves first", () => {
  // Lichess puzzle 00008: black's f2g3 is the opponent move; white solves with e6e7
  const converted = toSolverFirst("r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24", [
    "f2g3", "e6e7", "b2b1", "b3c1", "b1c1", "h6c1",
  ]);
  assert.ok(converted);
  assert.equal(converted.fen.split(" ")[1], "w");
  assert.equal(converted.moves, "e6e7 b2b1 b3c1 b1c1 h6c1");
  assert.equal(toSolverFirst("8/8/8/8/8/8/8/8 w - - 0 1", ["e2e4", "e7e5"]), null);
});

test("seeded puzzles replay legally and mate puzzles end in checkmate", () => {
  const sql = readFileSync(new URL("../migrations/005_fix_puzzle_seed.sql", import.meta.url), "utf8");
  const insert = sql.slice(sql.indexOf("INSERT INTO puzzles"));
  const rows = [...insert.matchAll(/\('(\w+)', '([^']+)', '([^']+)', \d+, ARRAY\[([^\]]*)\]\)/g)];
  assert.ok(rows.length > 0);
  for (const [, id, fen, moves = "", themes = ""] of rows) {
    const chess = new Chess(fen);
    for (const uci of moves.split(" ")) {
      assert.doesNotThrow(
        () => chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] && { promotion: uci[4] }) }),
        `puzzle ${id}: ${uci} should be legal`
      );
    }
    if (themes.includes("'mate'")) assert.ok(chess.isCheckmate(), `puzzle ${id} should end in mate`);
  }
});
