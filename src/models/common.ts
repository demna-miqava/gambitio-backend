/**
 * Common types used across the application
 */

export type TimeControl = "bullet" | "blitz" | "rapid";
export type PlayerColor = "white" | "black";

/**
 * Helper to determine time control type from time in seconds
 */
/**
 * The base times (seconds) of each time control, [from, below); null is no
 * upper bound. getTimeControl's rule as ranges, for filtering in SQL.
 */
export const TIME_CONTROL_SECONDS: Record<TimeControl, [number, number | null]> = {
  bullet: [0, 180],
  blitz: [180, 600],
  rapid: [600, null],
};

export function getTimeControl(timeInSeconds: number): TimeControl {
  if (timeInSeconds < 180) return "bullet"; // < 3 minutes
  if (timeInSeconds < 600) return "blitz"; // < 10 minutes
  return "rapid";
}

/**
 * `games` counts finished, non-aborted (rated) games in that time control
 * (migration 010). `rd`, `volatility` and `ratedAt` are the rest of the
 * Glicko-2 rating (src/utils/glicko2.ts, migration 032).
 */
const RATING_COLUMNS = {
  bullet: {
    rating: "bulletRating",
    highest: "highestBulletRating",
    games: "bulletGames",
    rd: "bulletRd",
    volatility: "bulletVolatility",
    ratedAt: "bulletRatedAt",
    provisional: "bulletProvisional",
  },
  blitz: {
    rating: "blitzRating",
    highest: "highestBlitzRating",
    games: "blitzGames",
    rd: "blitzRd",
    volatility: "blitzVolatility",
    ratedAt: "blitzRatedAt",
    provisional: "blitzProvisional",
  },
  rapid: {
    rating: "rapidRating",
    highest: "highestRapidRating",
    games: "rapidGames",
    rd: "rapidRd",
    volatility: "rapidVolatility",
    ratedAt: "rapidRatedAt",
    provisional: "rapidProvisional",
  },
} as const;

export const TIME_CONTROLS = ["bullet", "blitz", "rapid"] as const satisfies readonly TimeControl[];

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
