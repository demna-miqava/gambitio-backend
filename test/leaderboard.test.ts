import { test } from "node:test";
import assert from "node:assert/strict";
import { assignRanks, LEADERBOARD_VARIANT_NAMES } from "../src/models/Leaderboard.js";

const rows = (...ratings: number[]) =>
  ratings.map((rating, i) => ({
    id: i + 1,
    username: `user${i + 1}`,
    avatarUrl: null,
    rating,
    highestRating: rating,
    gamesPlayed: 1,
  }));

test("assignRanks gives tied ratings the same rank (1, 2, 2, 4)", () => {
  assert.deepEqual(
    assignRanks(rows(1500, 1400, 1400, 1300), 0, 1).map((e) => e.rank),
    [1, 2, 2, 4]
  );
});

test("assignRanks continues a tie from the previous page", () => {
  // Page 2 (offset 3) starts with a 1400 that ties with ranks 2-3 on page 1
  assert.deepEqual(assignRanks(rows(1400, 1400, 1200), 3, 2).map((e) => e.rank), [2, 2, 6]);
});

test("assignRanks handles empty pages", () => {
  assert.deepEqual(assignRanks([], 20, 0), []);
});

test("leaderboard variants are the three time controls plus puzzles", () => {
  assert.deepEqual(LEADERBOARD_VARIANT_NAMES, ["bullet", "blitz", "rapid", "puzzle"]);
});
