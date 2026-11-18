import type { UserSkill } from "../models/User.js";
import { ratePlayer, type GameScore, type RatingState } from "./glicko2.js";

export function getRatingsBySkill(skill: UserSkill): number {
  const ratingMap: Record<UserSkill, number> = {
    new: 200,
    beginner: 400,
    intermediate: 1000,
    advanced: 1400,
  };
  return ratingMap[skill];
}

export const RATING_FLOOR = 100;

/** A player's rating in one time control, as stored on their users row. */
export type PlayerRating = RatingState;

export interface RatedGame {
  white: PlayerRating;
  black: PlayerRating;
}

/**
 * The most one game can move a rating. Glicko-2 alone lets a brand-new
 * player gain over 600 points for one win against someone rated far above
 * them (a friend's challenge, an opponent who lost on time); with the cap a
 * player whose rating is far off still gets where they belong in a few games.
 */
export const MAX_RATING_CHANGE = 300;

/**
 * Both players' ratings after a rated game, by Glicko-2 (src/utils/glicko2.ts)
 * from what they had when it ended. Ratings are whole numbers, move by at
 * most MAX_RATING_CHANGE a game and never drop below RATING_FLOOR.
 *
 * The winner never loses points and the loser never gains any, but the two
 * changes differ in size: each depends on how settled that player's own
 * rating is. A heavy favourite can gain 0 for a win.
 */
export function rateGame(
  white: PlayerRating,
  black: PlayerRating,
  result: "white_win" | "black_win" | "draw",
  now: Date
): RatedGame {
  const whiteScore = result === "white_win" ? 1 : result === "black_win" ? 0 : 0.5;
  const settle = (before: PlayerRating, rated: RatingState): PlayerRating => {
    const change = Math.round(rated.rating) - before.rating;
    const capped = Math.min(MAX_RATING_CHANGE, Math.max(-MAX_RATING_CHANGE, change));
    return { ...rated, rating: Math.max(RATING_FLOOR, before.rating + capped) };
  };
  return {
    white: settle(white, ratePlayer(white, black, whiteScore, now)),
    black: settle(black, ratePlayer(black, white, (1 - whiteScore) as GameScore, now)),
  };
}
