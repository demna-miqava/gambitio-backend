import type { UserSkill } from "../models/User.js";

export function getRatingsBySkill(skill: UserSkill): number {
  const ratingMap: Record<UserSkill, number> = {
    new: 200,
    beginner: 400,
    intermediate: 1000,
    advanced: 1400,
  };
  return ratingMap[skill];
}

export interface RatingChange {
  whiteRatingChange: number;
  blackRatingChange: number;
  whiteNewRating: number;
  blackNewRating: number;
}

export const RATING_FLOOR = 100;
const BASE_CHANGE = 8;
const MIN_WIN_CHANGE = 1;
const MAX_WIN_CHANGE = 16;
const MAX_DRAW_CHANGE = 8;
const POINTS_PER_BRACKET = 50;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * Rating deltas for a finished game, from the ratings both players had when it
 * started.
 * - Win: 8 points, ±1 per 50-point gap (upsets gain more), clamped to 1..16 so
 *   the winner always gains and the loser always loses.
 * - Draw: the lower-rated player gains 1 per 50-point gap (max 8), the higher
 *   loses the same.
 * New ratings never drop below RATING_FLOOR.
 */
export function calculateRatingChanges(
  whiteRating: number,
  blackRating: number,
  result: "white_win" | "black_win" | "draw" | "aborted"
): RatingChange {
  if (result === "aborted") {
    return {
      whiteRatingChange: 0,
      blackRatingChange: 0,
      whiteNewRating: whiteRating,
      blackNewRating: blackRating,
    };
  }

  const brackets = Math.floor(Math.abs(whiteRating - blackRating) / POINTS_PER_BRACKET);
  const whiteIsHigher = whiteRating > blackRating;

  let whiteDelta: number;
  if (result === "draw") {
    const change = Math.min(brackets, MAX_DRAW_CHANGE);
    whiteDelta = whiteIsHigher ? -change : change;
  } else {
    const winnerIsHigher = (result === "white_win") === whiteIsHigher && whiteRating !== blackRating;
    const change = clamp(
      winnerIsHigher ? BASE_CHANGE - brackets : BASE_CHANGE + brackets,
      MIN_WIN_CHANGE,
      MAX_WIN_CHANGE
    );
    whiteDelta = result === "white_win" ? change : -change;
  }

  const whiteNewRating = Math.max(RATING_FLOOR, whiteRating + whiteDelta);
  const blackNewRating = Math.max(RATING_FLOOR, blackRating - whiteDelta);

  return {
    whiteRatingChange: whiteNewRating - whiteRating,
    blackRatingChange: blackNewRating - blackRating,
    whiteNewRating,
    blackNewRating,
  };
}
