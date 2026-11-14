/**
 * Common types used across the application
 */

export type TimeControl = "bullet" | "blitz" | "rapid";
export type PlayerColor = "white" | "black";

/**
 * Helper to determine time control type from time in seconds
 */
export function getTimeControl(timeInSeconds: number): TimeControl {
  if (timeInSeconds < 180) return "bullet"; // < 3 minutes
  if (timeInSeconds < 600) return "blitz"; // < 10 minutes
  return "rapid";
}

/** `games` counts finished, non-aborted (rated) games in that time control (migration 010). */
const RATING_COLUMNS = {
  bullet: { rating: "bulletRating", highest: "highestBulletRating", games: "bulletGames" },
  blitz: { rating: "blitzRating", highest: "highestBlitzRating", games: "blitzGames" },
  rapid: { rating: "rapidRating", highest: "highestRapidRating", games: "rapidGames" },
} as const;

/** Column names for a time control. Values come from a fixed map, so they are safe to interpolate into SQL. */
export function ratingColumns(timeControl: TimeControl) {
  return RATING_COLUMNS[timeControl];
}

/** Allowed time settings for new games (seconds). */
export const TIME_LIMITS = {
  minTime: 15,
  maxTime: 3 * 60 * 60,
  maxIncrement: 180,
} as const;
