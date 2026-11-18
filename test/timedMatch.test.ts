import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  abandonedMatchWinner,
  gameFitsMatch,
  lastGameStartAt,
  MAX_NO_SHOWS,
  scoreTimedGame,
  timedMatchEnd,
  timedMatchWinner,
  type TimedScore,
} from "../src/game/timedMatch.js";

const start: TimedScore = {
  playerOneId: 1,
  playerTwoId: 2,
  playerOnePoints: 0,
  playerTwoPoints: 0,
  playerOneStreak: 0,
  playerTwoStreak: 0,
  noShows: 0,
};
const oneWhite = { whiteId: 1, blackId: 2 };
const twoWhite = { whiteId: 2, blackId: 1 };

describe("timed matches", () => {
  test("scores like an arena: 2 / 1 / 0, doubled after two wins in a row", () => {
    let s = scoreTimedGame(start, { ...oneWhite, result: "white_win" }, false);
    s = scoreTimedGame(s, { ...twoWhite, result: "black_win" }, false);
    assert.deepEqual([s.playerOnePoints, s.playerOneStreak], [4, 2]);
    // On a streak: a win scores 4, a draw 2 (and ends the streak)
    s = scoreTimedGame(s, { ...oneWhite, result: "white_win" }, false);
    assert.deepEqual([s.playerOnePoints, s.playerOneStreak], [8, 3]);
    s = scoreTimedGame(s, { ...twoWhite, result: "draw" }, false);
    assert.deepEqual([s.playerOnePoints, s.playerOneStreak, s.playerTwoPoints], [10, 0, 1]);
    s = scoreTimedGame(s, { ...oneWhite, result: "black_win" }, false);
    assert.deepEqual([s.playerOnePoints, s.playerTwoPoints, s.playerTwoStreak], [10, 3, 1]);
  });

  test("an aborted game changes nothing; no-shows are counted in a row", () => {
    assert.equal(scoreTimedGame(start, { ...oneWhite, result: "aborted" }, false), start);
    let s = scoreTimedGame(start, { ...oneWhite, result: "black_win" }, true);
    assert.deepEqual([s.noShows, s.playerTwoPoints], [1, 2]);
    s = scoreTimedGame(s, { ...twoWhite, result: "draw" }, false);
    assert.equal(s.noShows, 0);
  });

  test("the winner is whoever has more points; equal points is drawn", () => {
    assert.equal(timedMatchWinner(start), null);
    assert.equal(timedMatchWinner({ ...start, playerTwoPoints: 3, playerOnePoints: 2 }), 2);
  });

  test("a game has to fit in the match", () => {
    assert.ok(gameFitsMatch(180, 2, 15)); // 3+2 in 15 minutes
    assert.ok(gameFitsMatch(300, 0, 15));
    assert.ok(!gameFitsMatch(600, 0, 15)); // 10+0 needs 20 minutes
    assert.ok(gameFitsMatch(600, 0, 20));
    assert.ok(gameFitsMatch(60, 0, 5));
    assert.ok(!gameFitsMatch(180, 0, 5));
  });

  test("ends once no new game may start, or after repeated no-shows", () => {
    const endsAt = 1_000_000;
    // A 3-minute clock: no new game in the last minute
    assert.equal(lastGameStartAt(endsAt, 180), endsAt - 60_000);
    // A 30-second clock: none in the last 30 seconds
    assert.equal(lastGameStartAt(endsAt, 30), endsAt - 30_000);
    const match = { endsAt, time: 180 };
    const leading = { ...start, playerOnePoints: 4 };
    assert.equal(timedMatchEnd(leading, match, endsAt - 60_001), null);
    assert.deepEqual(timedMatchEnd(leading, match, endsAt - 60_000), { winnerId: 1, endReason: "time_up" });
    assert.deepEqual(timedMatchEnd({ ...leading, noShows: MAX_NO_SHOWS }, match, 0), {
      winnerId: 1,
      endReason: "abandoned",
    });
  });

  test("an abandoned match goes to the player who showed up", () => {
    const leading = { ...start, playerOnePoints: 10, playerTwoPoints: 4, noShows: MAX_NO_SHOWS };
    const match = { endsAt: 1_000_000, time: 180 };
    // Player one, in the lead, missed both games: player two wins anyway
    assert.equal(abandonedMatchWinner(leading, [1, 1]), 2);
    assert.deepEqual(timedMatchEnd(leading, match, 0, [1, 1]), { winnerId: 2, endReason: "abandoned" });
    assert.equal(abandonedMatchWinner({ ...leading, playerOnePoints: 0 }, [2, 2]), 1);
    // Each missed one: on points
    assert.equal(abandonedMatchWinner(leading, [2, 1]), 1);
    assert.equal(abandonedMatchWinner({ ...leading, playerTwoPoints: 10 }, [1, 2]), null);
    // Not knowing the earlier game: on points
    assert.equal(abandonedMatchWinner(leading, [1]), 1);
    // Older no-shows don't count
    assert.equal(abandonedMatchWinner(leading, [2, 1, 1]), 1);
  });
});
