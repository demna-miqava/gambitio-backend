import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  expiredSeriesDecision,
  scoreGame,
  seriesColors,
  seriesDecision,
  type SeriesScore,
} from "../src/game/series.js";

const base = (bestOf = 3): SeriesScore => ({
  playerOneId: 1,
  playerTwoId: 2,
  playerOneStartsWhite: true,
  bestOf,
  playerOneHalfPoints: 0,
  playerTwoHalfPoints: 0,
  gamesPlayed: 0,
});

describe("series", () => {
  test("colours alternate from the challenger's choice", () => {
    const s = base();
    assert.deepEqual(seriesColors(s, 1), { whiteId: 1, blackId: 2 });
    assert.deepEqual(seriesColors(s, 2), { whiteId: 2, blackId: 1 });
    assert.deepEqual(seriesColors(s, 3), { whiteId: 1, blackId: 2 });
    const black = { ...s, playerOneStartsWhite: false };
    assert.deepEqual(seriesColors(black, 1), { whiteId: 2, blackId: 1 });
    assert.deepEqual(seriesColors(black, 2), { whiteId: 1, blackId: 2 });
  });

  test("wins, draws and aborts are scored", () => {
    let s = scoreGame(base(), { whiteId: 1, blackId: 2, result: "black_win" });
    assert.equal(s.playerTwoHalfPoints, 2);
    assert.equal(s.gamesPlayed, 1);
    s = scoreGame(s, { whiteId: 2, blackId: 1, result: "draw" });
    assert.deepEqual([s.playerOneHalfPoints, s.playerTwoHalfPoints, s.gamesPlayed], [1, 3, 2]);
    const aborted = scoreGame(s, { whiteId: 1, blackId: 2, result: "aborted" });
    assert.equal(aborted, s);
  });

  test("a best of three is clinched with two wins", () => {
    let s = base(3);
    s = scoreGame(s, { whiteId: 1, blackId: 2, result: "white_win" });
    assert.deepEqual(seriesDecision(s), { decided: false });
    s = scoreGame(s, { whiteId: 2, blackId: 1, result: "black_win" });
    assert.deepEqual(seriesDecision(s), { decided: true, winnerId: 1 });
  });

  test("1.5 points of 3 is not enough until the games run out", () => {
    let s = base(3);
    s = scoreGame(s, { whiteId: 1, blackId: 2, result: "white_win" });
    s = scoreGame(s, { whiteId: 2, blackId: 1, result: "draw" });
    assert.deepEqual(seriesDecision(s), { decided: false });
    s = scoreGame(s, { whiteId: 1, blackId: 2, result: "black_win" });
    // 1.5 - 1.5 after three games
    assert.deepEqual(seriesDecision(s), { decided: true, winnerId: null });
  });

  test("a best of five ends early once the lead can't be caught", () => {
    let s = base(5);
    for (let i = 0; i < 3; i++) s = scoreGame(s, { whiteId: 2, blackId: 1, result: "white_win" });
    assert.deepEqual(seriesDecision(s), { decided: true, winnerId: 2 });
  });

  test("an expired series goes to the leader on points, or is drawn", () => {
    let s = base(5);
    assert.deepEqual(expiredSeriesDecision(s), { winnerId: null });
    s = scoreGame(s, { whiteId: 1, blackId: 2, result: "white_win" });
    assert.deepEqual(expiredSeriesDecision(s), { winnerId: 1 });
    s = scoreGame(s, { whiteId: 2, blackId: 1, result: "white_win" });
    assert.deepEqual(expiredSeriesDecision(s), { winnerId: null });
    s = scoreGame(s, { whiteId: 1, blackId: 2, result: "draw" });
    s = scoreGame(s, { whiteId: 2, blackId: 1, result: "black_win" });
    assert.deepEqual(expiredSeriesDecision(s), { winnerId: 1 });
  });
});
