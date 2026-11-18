import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { cleanGuestName, MAX_TABLE_GAME_PGN_LENGTH, replayTableGame } from "../src/game/tableGame.js";

const pgnOf = (...sans: string[]) => {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.pgn();
};
const FOOLS_MATE = pgnOf("f3", "e5", "g4", "Qh4#");
const code = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string; message: string }).message;
  }
};

describe("table games: replay and result check", () => {
  test("a result the board decides must be the board's", () => {
    const game = replayTableGame(FOOLS_MATE, { result: "black_win", endReason: "checkmate" });
    assert.equal(game.numMoves, 4);
    assert.deepEqual(game.outcome, { result: "black_win", reason: "checkmate" });
    assert.match(game.pgn, /1\. f3 e5 2\. g4 Qh4#/);
    // Claiming something else over a mate is refused
    assert.match(code(() => replayTableGame(FOOLS_MATE, { result: "white_win", endReason: "resignation" }))!, /doesn't match/);
    assert.match(code(() => replayTableGame(FOOLS_MATE, { result: "white_win", endReason: "checkmate" }))!, /doesn't match/);
  });

  test("resignations and agreed draws stand when they fit", () => {
    const pgn = pgnOf("e4", "e5");
    assert.equal(replayTableGame(pgn, { result: "white_win", endReason: "resignation" }).outcome.reason, "resignation");
    assert.equal(replayTableGame(pgn, { result: "black_win", endReason: "resignation" }).outcome.result, "black_win");
    assert.equal(replayTableGame(pgn, { result: "draw", endReason: "draw_agreement" }).outcome.result, "draw");
    assert.match(code(() => replayTableGame(pgn, { result: "draw", endReason: "resignation" }))!, /doesn't match/);
    assert.match(code(() => replayTableGame(pgn, { result: "white_win", endReason: "draw_agreement" }))!, /doesn't match/);
    // A mate or automatic draw the position doesn't show
    assert.match(code(() => replayTableGame(pgn, { result: "white_win", endReason: "checkmate" }))!, /doesn't match/);
    assert.match(code(() => replayTableGame(pgn, { result: "draw", endReason: "stalemate" }))!, /doesn't match/);
  });

  test("a flag falls for the side to move, under the server's rule for insufficient material", () => {
    // White to move after 1. e4 e5: White's flag fell
    const pgn = pgnOf("e4", "e5");
    assert.deepEqual(replayTableGame(pgn, { result: "black_win", endReason: "timeout" }).outcome, {
      result: "black_win",
      reason: "timeout",
    });
    assert.match(code(() => replayTableGame(pgn, { result: "white_win", endReason: "timeout" }))!, /doesn't match/);

    // From the standard position only: a FEN header is refused
    assert.match(
      code(() =>
        replayTableGame(`[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]\n[SetUp "1"]\n\n1. e3 *`, {
          result: "draw",
          endReason: "timeout_vs_insufficient_material",
        })
      )!,
      /standard/
    );
  });

  test("a flag against a side whose opponent can't mate is a draw", () => {
    // A real game from the start (seeded random play) where the side to
    // move still has material and the other side has a bare king
    let seed = 7;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    let found: Chess | null = null;
    for (let attempt = 0; attempt < 500 && !found; attempt++) {
      const chess = new Chess();
      while (!chess.isGameOver()) {
        const moves = chess.moves();
        chess.move(moves[Math.floor(random() * moves.length)]!);
        const waiting = chess.turn() === "w" ? "b" : "w";
        const theirs = chess.board().flat().filter((p) => p && p.color === waiting);
        const mine = chess.board().flat().filter((p) => p && p.color === chess.turn());
        if (!chess.isGameOver() && theirs.length === 1 && mine.length > 2) {
          found = chess;
          break;
        }
      }
    }
    assert.ok(found, "no such game found");
    const flagged = found.turn() === "w" ? "white" : "black";
    const win = flagged === "white" ? "black_win" : "white_win";
    const pgn = found.pgn();
    assert.deepEqual(replayTableGame(pgn, { result: "draw", endReason: "timeout_vs_insufficient_material" }).outcome, {
      result: "draw",
      reason: "timeout_vs_insufficient_material",
    });
    assert.match(code(() => replayTableGame(pgn, { result: win, endReason: "timeout" }))!, /doesn't match/);
  });

  test("both sides able to mate: a flag is a loss, not a draw", () => {
    const pgn = pgnOf("e4", "e5");
    assert.match(
      code(() => replayTableGame(pgn, { result: "draw", endReason: "timeout_vs_insufficient_material" }))!,
      /doesn't match/
    );
  });

  test("refuses illegal, empty, too long and finished-then-continued games", () => {
    assert.match(code(() => replayTableGame("1. e5", { result: "draw", endReason: "draw_agreement" }))!, /legal/);
    assert.match(code(() => replayTableGame("*", { result: "draw", endReason: "draw_agreement" }))!, /no moves/);
    assert.match(
      code(() => replayTableGame("x".repeat(MAX_TABLE_GAME_PGN_LENGTH + 1), { result: "draw", endReason: "draw_agreement" }))!,
      /too long/
    );
    assert.match(
      code(() => replayTableGame("1. f3 e5 2. g4 Qh4# 3. a3", { result: "black_win", endReason: "checkmate" }))!,
      /after the game was over/
    );
  });
});

describe("guest names", () => {
  test("are cleaned like chat and kept short", () => {
    assert.equal(cleanGuestName("  Uncle​   Bob \n"), "Uncle Bob");
    assert.equal(cleanGuestName("‮evil"), "evil");
    assert.equal(cleanGuestName("   "), null);
    assert.equal(cleanGuestName("​"), null);
    assert.equal(cleanGuestName("x".repeat(31)), null);
    assert.equal(cleanGuestName("x".repeat(30)), "x".repeat(30));
  });
});
