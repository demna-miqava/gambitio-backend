import { RATING_FLOOR } from "./ratingHelpers.js";

/** Rated attempts during which a player's puzzle rating is provisional. */
export const PUZZLE_PROVISIONAL_ATTEMPTS = 20;
/** Faster convergence while provisional (default 1500 can be far off). */
export const PUZZLE_K_PROVISIONAL = 40;
export const PUZZLE_K = 20;

export interface PuzzleRatingResult {
  newRating: number;
  /** Change actually applied (after the rating floor). */
  ratingChange: number;
}

/**
 * Elo update for one rated puzzle attempt, treating the puzzle as an opponent
 * rated at its puzzle rating:
 *   expected = 1 / (1 + 10^((puzzleRating - userRating) / 400))
 *   change   = round(K * (score - expected)),  score = 1 solved, 0 failed
 * K is 40 for the first 20 rated attempts, 20 afterwards. The puzzle's own
 * rating is not changed. New ratings never drop below RATING_FLOOR.
 */
export function calculatePuzzleRating(
  userRating: number,
  puzzleRating: number,
  success: boolean,
  ratedAttempts: number
): PuzzleRatingResult {
  const k = ratedAttempts < PUZZLE_PROVISIONAL_ATTEMPTS ? PUZZLE_K_PROVISIONAL : PUZZLE_K;
  const expected = 1 / (1 + 10 ** ((puzzleRating - userRating) / 400));
  const raw = Math.round(k * ((success ? 1 : 0) - expected));
  const newRating = Math.max(RATING_FLOOR, userRating + raw);
  return { newRating, ratingChange: newRating - userRating };
}
