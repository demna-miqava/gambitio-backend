import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import {
  findOpening,
  OPENING_IDS,
  OPENINGS,
  openingAllowsRating,
  openingPosition,
  openingSummary,
} from "../src/game/openings.js";
import { applyMove, takebackPlies } from "../src/game/engine.js";
import { afterMove, chargedTime, deadline, FIRST_MOVE_TIMEOUT_MS, isClockRunning, type ClockState } from "../src/game/clock.js";
import { scoreGame, seriesDecision, type SeriesScore } from "../src/game/series.js";

describe("openings", () => {
  test("every opening is legal, has a unique id and starts the game where its moves end", () => {
    assert.equal(new Set(OPENING_IDS).size, OPENINGS.length);
    for (const opening of OPENINGS) {
      const position = openingPosition(opening.id)!;
      assert.equal(position.ply, opening.moves.length);
      const chess = new Chess();
      chess.loadPgn(position.pgn);
      assert.deepEqual(chess.history(), opening.moves, opening.id);
      assert.equal(chess.fen(), position.fen, opening.id);
    }
  });

  test("the picker's favourites are there", () => {
    for (const id of ["sicilian", "queens-gambit", "italian", "ruy-lopez", "french", "caro-kann", "kings-indian"]) {
      assert.ok(findOpening(id), id);
    }
    assert.equal(findOpening("nope"), null);
    assert.equal(openingSummary(null), null);
    assert.deepEqual(openingSummary("sicilian"), { id: "sicilian", eco: "B20", name: "Sicilian Defense" });
  });

  test("the players' moves are appended to the opening's PGN in the engine's format", () => {
    const position = openingPosition("queens-gambit")!;
    // 1. d4 d5 2. c4: Black is to move
    const result = applyMove(position.pgn, { from: "e7", to: "e6" });
    assert.ok(result.ok);
    assert.equal(result.ply, 4);
    assert.equal(result.mover, "black");
    const chess = new Chess();
    chess.loadPgn(position.pgn);
    chess.move("e6");
    assert.equal(result.pgn, chess.pgn());
  });
});

describe("rating games from an opening", () => {
  test("only a mirror match from an opening may be rated", () => {
    const single = { bestOf: 1, matchMinutes: null };
    assert.equal(openingAllowsRating(null, single), true);
    assert.equal(openingAllowsRating(undefined, { bestOf: 3, matchMinutes: null }), true);
    assert.equal(openingAllowsRating(null, { bestOf: 0, matchMinutes: 15 }), true);
    assert.equal(openingAllowsRating("sicilian", single), false);
    assert.equal(openingAllowsRating("sicilian", { bestOf: 3, matchMinutes: null }), false);
    assert.equal(openingAllowsRating("sicilian", { bestOf: 5, matchMinutes: null }), false);
    assert.equal(openingAllowsRating("sicilian", { bestOf: 0, matchMinutes: 15 }), false);
    assert.equal(openingAllowsRating("sicilian", { bestOf: 1, matchMinutes: 15 }), false);
    assert.equal(openingAllowsRating("sicilian", { bestOf: 2, matchMinutes: null }), true);
  });
});

describe("rules counted from an opening's last move", () => {
  test("clocks start once both players have made a move of their own", () => {
    // Queen's Gambit: 3 plies played, Black moves first
    assert.equal(isClockRunning(3, 3), false);
    assert.equal(isClockRunning(4, 3), false);
    assert.equal(isClockRunning(5, 3), true);
    assert.equal(isClockRunning(2), true);

    const start: ClockState = { whiteMs: 60_000, blackMs: 60_000, lastMoveAt: 0, ply: 3, startPly: 3 };
    // Both first moves are free, and each has the first-move timeout
    assert.equal(chargedTime(start, 20_000), 0);
    assert.equal(deadline(start), FIRST_MOVE_TIMEOUT_MS);
    const afterBlack = afterMove(start, 20_000, 0);
    assert.deepEqual([afterBlack.blackMs, afterBlack.ply, afterBlack.startPly], [60_000, 4, 3]);
    const afterWhite = afterMove(afterBlack, 40_000, 0);
    assert.equal(afterWhite.whiteMs, 60_000);
    // Now Black's clock runs
    assert.equal(chargedTime(afterWhite, 45_000), 5_000);
    assert.equal(deadline(afterWhite) > FIRST_MOVE_TIMEOUT_MS + 40_000, true);
  });

  test("a takeback never reaches into the opening", () => {
    // Sicilian: 2 plies played, White to move
    assert.equal(takebackPlies(2, "white", 2), null);
    assert.equal(takebackPlies(3, "white", 2), null);
    // As from the initial position, neither player's first move goes back
    assert.equal(takebackPlies(4, "black", 2), null);
    assert.equal(takebackPlies(4, "white", 2), null);
    assert.equal(takebackPlies(5, "white", 2), 1);
    assert.equal(takebackPlies(6, "white", 2), 2);
  });
});

describe("mirror match scoring", () => {
  const base: SeriesScore = {
    playerOneId: 1,
    playerTwoId: 2,
    playerOneStartsWhite: true,
    bestOf: 2,
    playerOneHalfPoints: 0,
    playerTwoHalfPoints: 0,
    gamesPlayed: 0,
  };

  test("is never decided after the first game", () => {
    const s = scoreGame(base, { whiteId: 1, blackId: 2, result: "white_win" });
    assert.deepEqual(seriesDecision(s), { decided: false });
  });

  test("a win each is a drawn match, a win and a draw wins it", () => {
    const one = scoreGame(base, { whiteId: 1, blackId: 2, result: "white_win" });
    assert.deepEqual(seriesDecision(scoreGame(one, { whiteId: 2, blackId: 1, result: "white_win" })), {
      decided: true,
      winnerId: null,
    });
    assert.deepEqual(seriesDecision(scoreGame(one, { whiteId: 2, blackId: 1, result: "draw" })), {
      decided: true,
      winnerId: 1,
    });
  });

  test("an aborted game is replayed, so the match still has two games", () => {
    const aborted = scoreGame(base, { whiteId: 1, blackId: 2, result: "aborted" });
    assert.deepEqual(seriesDecision(aborted), { decided: false });
    assert.equal(aborted.gamesPlayed, 0);
  });
});
