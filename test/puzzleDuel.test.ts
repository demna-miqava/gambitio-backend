import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { allOut, duelRatingLadder, duelWinner, judgeDuelMove } from "../src/game/puzzleDuel.js";

// White to move: Qxf7# is mate (scholar's mate position)
const MATE_FEN = "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4";
// A three-move line from the start (any legal line works as a "solution" here)
const LINE_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const LINE = ["e2e4", "e7e5", "g1f3"];

describe("puzzle duel rules", () => {
  test("a right move goes on with the reply, the last right move solves", () => {
    assert.deepEqual(judgeDuelMove(LINE_FEN, LINE, [], "e2e4"), { kind: "continue", move: "e2e4", reply: "e7e5" });
    assert.deepEqual(judgeDuelMove(LINE_FEN, LINE, ["e2e4"], "g1f3"), { kind: "solved", move: "g1f3" });
    assert.deepEqual(judgeDuelMove(LINE_FEN, LINE, ["e2e4"], "d2d4"), { kind: "wrong", move: "d2d4" });
  });

  test("any mate counts, even another one", () => {
    assert.deepEqual(judgeDuelMove(MATE_FEN, ["h5f7"], [], "h5f7"), { kind: "solved", move: "h5f7" });
  });

  test("a legal wrong move is wrong; an illegal one or a finished puzzle is refused", () => {
    assert.deepEqual(judgeDuelMove(MATE_FEN, ["h5f7"], [], "h5h7"), { kind: "wrong", move: "h5h7" });
    assert.equal(judgeDuelMove(MATE_FEN, ["h5f7"], [], "h5h8"), null);
    assert.equal(judgeDuelMove(MATE_FEN, ["h5f7"], ["h5f7"], "a2a3"), null);
  });

  test("a promotion on the right squares counts as the solution's", () => {
    const fen = "8/P6k/8/8/8/8/8/K7 w - - 0 1";
    assert.deepEqual(judgeDuelMove(fen, ["a7a8n"], [], "a7a8q"), { kind: "solved", move: "a7a8n" });
  });

  test("the higher score wins; equal scores draw", () => {
    assert.equal(duelWinner([{ userId: 1, score: 5, strikes: 3 }, { userId: 2, score: 4, strikes: 0 }]), 1);
    assert.equal(duelWinner([{ userId: 1, score: 2, strikes: 0 }, { userId: 2, score: 7, strikes: 3 }]), 2);
    assert.equal(duelWinner([{ userId: 1, score: 3, strikes: 1 }, { userId: 2, score: 3, strikes: 2 }]), null);
  });

  test("the duel ends early once both are out of strikes or puzzles", () => {
    assert.equal(allOut([{ strikes: 3, current: 4 }, { strikes: 2, current: 9 }], 60), false);
    assert.equal(allOut([{ strikes: 3, current: 4 }, { strikes: 3, current: 9 }], 60), true);
    assert.equal(allOut([{ strikes: 3, current: 4 }, { strikes: 0, current: 60 }], 60), true);
  });

  test("puzzles get harder one after another", () => {
    const ladder = duelRatingLadder();
    assert.equal(ladder.length, 60);
    assert.ok(ladder.every((r, i) => i === 0 || r > ladder[i - 1]!));
  });
});
