import type { GameResult } from "./engine.js";

/** Allowed series lengths; 1 is a plain single game. */
export const SERIES_LENGTHS = [3, 5] as const;
export type SeriesLength = (typeof SERIES_LENGTHS)[number];

export type SeriesStatus = "active" | "finished";
/**
 * "played_out": decided by the games; "resignation": a player gave it up;
 * "expired": nobody played on for SERIES_IDLE_EXPIRY_MS (decided on points)
 */
export type SeriesEndReason = "played_out" | "resignation" | "expired";

/** How long a series may go without a game before it expires */
export const SERIES_IDLE_EXPIRY_MS = 7 * 24 * 60 * 60_000;

/** The scoring state of a series, as stored on its row. */
export interface SeriesScore {
  playerOneId: number;
  playerTwoId: number;
  playerOneStartsWhite: boolean;
  bestOf: number;
  /** Points doubled, so a draw is one each */
  playerOneHalfPoints: number;
  playerTwoHalfPoints: number;
  /** Games that counted (aborted games don't) */
  gamesPlayed: number;
}

/**
 * Who has which colour in a game of the series (1-based). Colours alternate:
 * player one has the colour they chose in odd games, the other in even games.
 */
export function seriesColors(
  series: Pick<SeriesScore, "playerOneId" | "playerTwoId" | "playerOneStartsWhite">,
  gameNumber: number
): { whiteId: number; blackId: number } {
  const playerOneWhite = (gameNumber % 2 === 1) === series.playerOneStartsWhite;
  return playerOneWhite
    ? { whiteId: series.playerOneId, blackId: series.playerTwoId }
    : { whiteId: series.playerTwoId, blackId: series.playerOneId };
}

/**
 * The clocks of a series game with the given colours, when the series has
 * time odds: each player keeps their own clock whichever colour they have.
 */
export function seriesOdds(
  series: { playerOneId: number; playerOneTime: number | null; playerTwoTime: number | null },
  colors: { whiteId: number }
): { whiteTime: number; blackTime: number } | null {
  const { playerOneTime: one, playerTwoTime: two } = series;
  if (one === null || two === null) return null;
  return colors.whiteId === series.playerOneId
    ? { whiteTime: one, blackTime: two }
    : { whiteTime: two, blackTime: one };
}

/**
 * The score after one game. An aborted game changes nothing (it is replayed
 * with the same colours, since the game number is gamesPlayed + 1).
 */
export function scoreGame(
  series: SeriesScore,
  game: { whiteId: number; blackId: number; result: GameResult }
): SeriesScore {
  if (game.result === "aborted") return series;
  let one = 0;
  let two = 0;
  if (game.result === "draw") {
    one = 1;
    two = 1;
  } else {
    const winnerId = game.result === "white_win" ? game.whiteId : game.blackId;
    if (winnerId === series.playerOneId) one = 2;
    else two = 2;
  }
  return {
    ...series,
    playerOneHalfPoints: series.playerOneHalfPoints + one,
    playerTwoHalfPoints: series.playerTwoHalfPoints + two,
    gamesPlayed: series.gamesPlayed + 1,
  };
}

/** The result of a series that expired: whoever leads on points, or drawn. */
export function expiredSeriesDecision(series: SeriesScore): { winnerId: number | null } {
  const { playerOneHalfPoints: one, playerTwoHalfPoints: two } = series;
  if (one === two) return { winnerId: null };
  return { winnerId: one > two ? series.playerOneId : series.playerTwoId };
}

/**
 * Whether the series is over, and who won it (null winner: drawn series).
 * A player with more than half the points on offer has clinched it, since
 * the other can no longer catch up; otherwise it ends after `bestOf` games.
 */
export function seriesDecision(
  series: SeriesScore
): { decided: false } | { decided: true; winnerId: number | null } {
  const { playerOneHalfPoints: one, playerTwoHalfPoints: two, bestOf } = series;
  // More than bestOf / 2 points is more than bestOf half points
  if (one > bestOf) return { decided: true, winnerId: series.playerOneId };
  if (two > bestOf) return { decided: true, winnerId: series.playerTwoId };
  if (series.gamesPlayed >= bestOf) {
    if (one === two) return { decided: true, winnerId: null };
    return { decided: true, winnerId: one > two ? series.playerOneId : series.playerTwoId };
  }
  return { decided: false };
}
