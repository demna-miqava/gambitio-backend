import { test } from "node:test";
import assert from "node:assert/strict";
import { calculatePuzzleRating } from "../src/utils/puzzleRating.js";

test("puzzle Elo: even match moves K/2 either way", () => {
  assert.deepEqual(calculatePuzzleRating(1500, 1500, true, 0), { newRating: 1520, ratingChange: 20 });
  assert.deepEqual(calculatePuzzleRating(1500, 1500, false, 0), { newRating: 1480, ratingChange: -20 });
  // Established players (20+ rated attempts) use K = 20
  assert.deepEqual(calculatePuzzleRating(1500, 1500, true, 20), { newRating: 1510, ratingChange: 10 });
});

test("puzzle Elo: harder puzzles are worth more, easy ones little", () => {
  assert.equal(calculatePuzzleRating(1200, 1300, true, 0).ratingChange, 26);
  assert.equal(calculatePuzzleRating(1200, 1300, false, 0).ratingChange, -14);
  assert.equal(calculatePuzzleRating(1500, 600, true, 0).ratingChange, 0);
  assert.equal(calculatePuzzleRating(1500, 600, false, 0).ratingChange, -40);
});

test("puzzle Elo: never drops below the rating floor", () => {
  assert.deepEqual(calculatePuzzleRating(110, 110, false, 0), { newRating: 100, ratingChange: -10 });
});
