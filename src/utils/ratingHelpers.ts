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

export function calculateRatingChanges(
  whiteRating: number,
  blackRating: number,
  result: "white_win" | "black_win" | "draw" | "aborted"
): RatingChange {
  // Rule 1: Aborted games - no rating change
  if (result === "aborted") {
    return {
      whiteRatingChange: 0,
      blackRatingChange: 0,
      whiteNewRating: whiteRating,
      blackNewRating: blackRating,
    };
  }

  const ratingDiff = Math.abs(whiteRating - blackRating);
  const brackets = Math.floor(ratingDiff / 50);
  const higherRatedIsWhite = whiteRating > blackRating;

  // Determine the rating change multiplier based on result
  // 1 for white win, -1 for black win, 0 for draw (handled separately)
  let whiteMultiplier = 0;

  if (result === "draw") {
    // Rule 2: Draw - for every 50 rating points, higher loses 1, lower gains 1
    const change = brackets;
    whiteMultiplier = higherRatedIsWhite ? -1 : 1;

    return {
      whiteRatingChange: whiteMultiplier * brackets,
      blackRatingChange: -whiteMultiplier * brackets,
      whiteNewRating: whiteRating + whiteMultiplier * brackets,
      blackNewRating: blackRating - whiteMultiplier * brackets,
    };
  }

  // Rule 3: Win/Loss
  const baseChange = 8;
  // const adjustment = brackets;

  // Calculate the change amount based on who won and who was higher rated
  let change: number;

  if (result === "white_win") {
    // White wins: if white is higher rated, gain less; if lower rated, gain more
    change = higherRatedIsWhite ? baseChange - brackets : baseChange + brackets;
    whiteMultiplier = 1;
  } else {
    // Black wins: if black is higher rated, gain less; if lower rated, gain more
    change = higherRatedIsWhite ? baseChange + brackets : baseChange - brackets;
    whiteMultiplier = -1;
  }

  return {
    whiteRatingChange: whiteMultiplier * change,
    blackRatingChange: -whiteMultiplier * change,
    whiteNewRating: whiteRating + whiteMultiplier * change,
    blackNewRating: blackRating - whiteMultiplier * change,
  };
}
