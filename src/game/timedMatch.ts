import type { GameResult } from "./engine.js";
import { arenaPoints, lastPairingMs, nextStreak, outcomeFor } from "./arena.js";

/**
 * Timed matches (migration 039): two friends play as many games as fit in a
 * fixed time, scored like an arena tournament. Only arithmetic here; the
 * database side is in src/services/seriesService.ts.
 */

/** The match lengths a challenge can ask for, in minutes */
export const MATCH_MINUTES = [5, 10, 15, 20, 30, 45, 60] as const;
export type MatchMinutes = (typeof MATCH_MINUTES)[number];

/** A timed match is stored as a series with this bestOf */
export const TIMED_MATCH_BEST_OF = 0;

/** How long after a game ends the next one starts: long enough to see the result */
export const NEXT_GAME_DELAY_MS = 3_000;

/** Games in a row ending with a player who never moved, after which the match ends */
export const MAX_NO_SHOWS = 2;

/** A game's longest plausible length: both clocks, and the increment over 40 moves each. */
const longestGameSeconds = (time: number, increment: number) => 2 * (time + 40 * increment);

/**
 * Whether a game with this clock fits in a match of `minutes`: at least one
 * whole game has to, or the match would be one game with a deadline on it.
 * `time` is the longer clock when the match has time odds.
 */
export const gameFitsMatch = (time: number, increment: number, minutes: number): boolean =>
  longestGameSeconds(time, increment) <= minutes * 60;

/**
 * The last moment a new game may start (ms): none in the final stretch, as
 * in an arena (lastPairingMs). A game started before it is played out and
 * counts, however long it runs past the end.
 */
export const lastGameStartAt = (endsAt: number, time: number): number => endsAt - lastPairingMs(time);

/** The arena side of a timed match's score, as stored on its row. */
export interface TimedScore {
  playerOneId: number;
  playerTwoId: number;
  playerOnePoints: number;
  playerTwoPoints: number;
  playerOneStreak: number;
  playerTwoStreak: number;
  noShows: number;
}

/**
 * The score after one game: arena points and streaks for both players, and
 * the count of no-show games in a row (`noShow`: the game ended with a
 * player who never made their first move). An aborted game changes nothing.
 */
export function scoreTimedGame<S extends TimedScore>(
  score: S,
  game: { whiteId: number; blackId: number; result: GameResult },
  noShow: boolean
): S {
  const colorOf = (playerId: number) => (game.whiteId === playerId ? "white" : "black");
  const one = outcomeFor(game.result, colorOf(score.playerOneId));
  const two = outcomeFor(game.result, colorOf(score.playerTwoId));
  if (!one || !two) return score;
  return {
    ...score,
    playerOnePoints: score.playerOnePoints + arenaPoints(one, score.playerOneStreak),
    playerTwoPoints: score.playerTwoPoints + arenaPoints(two, score.playerTwoStreak),
    playerOneStreak: nextStreak(one, score.playerOneStreak),
    playerTwoStreak: nextStreak(two, score.playerTwoStreak),
    noShows: noShow ? score.noShows + 1 : 0,
  };
}

/** Who won on points; null for a drawn match. */
export function timedMatchWinner(score: TimedScore): number | null {
  if (score.playerOnePoints === score.playerTwoPoints) return null;
  return score.playerOnePoints > score.playerTwoPoints ? score.playerOneId : score.playerTwoId;
}

/**
 * Who wins a match that ended because players kept not showing up. If one
 * player missed every one of the last MAX_NO_SHOWS games, the other wins,
 * whatever the points (otherwise a player in the lead could end the match
 * early by walking away); if each missed some, it is decided on points.
 * `absentees` are the players who missed those games, newest first.
 */
export function abandonedMatchWinner(score: TimedScore, absentees: readonly number[]): number | null {
  const last = absentees.slice(0, MAX_NO_SHOWS);
  const absent = last[0];
  if (last.length === MAX_NO_SHOWS && last.every((id) => id === absent)) {
    return absent === score.playerOneId ? score.playerTwoId : score.playerOneId;
  }
  return timedMatchWinner(score);
}

/**
 * Whether the match is over once a game has ended at `now` (ms): the time
 * for new games is up, or players kept not showing up (`absentees`: who
 * missed the no-show games in a row that just ended, newest first; see
 * abandonedMatchWinner). Null while it goes on.
 */
export function timedMatchEnd(
  score: TimedScore,
  match: { endsAt: number; time: number },
  now: number,
  absentees: readonly number[] = []
): { winnerId: number | null; endReason: "time_up" | "abandoned" } | null {
  if (now >= lastGameStartAt(match.endsAt, match.time)) {
    return { winnerId: timedMatchWinner(score), endReason: "time_up" };
  }
  if (score.noShows >= MAX_NO_SHOWS) {
    return { winnerId: abandonedMatchWinner(score, absentees), endReason: "abandoned" };
  }
  return null;
}
