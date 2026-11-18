import type { GameResult } from "./engine.js";

/**
 * Arena tournament rules, with nothing but arithmetic: what a result scores,
 * how the standings break ties, and who plays whom next. The database side
 * is in src/services/tournamentService.ts.
 */

/** Wins in a row after which a player is "on a streak" and scores double. */
export const STREAK_AFTER = 2;

export type ArenaOutcome = "win" | "draw" | "loss";

/** The outcome of a game for the player with `color`, or null for an aborted game. */
export function outcomeFor(result: GameResult, color: "white" | "black"): ArenaOutcome | null {
  if (result === "aborted") return null;
  if (result === "draw") return "draw";
  return (result === "white_win") === (color === "white") ? "win" : "loss";
}

/**
 * Points for a game: 2 for a win, 1 for a draw, 0 for a loss. A player who
 * came into the game with STREAK_AFTER wins in a row scores double (4 and 2)
 * until a game they don't win.
 */
export function arenaPoints(outcome: ArenaOutcome, streak: number): number {
  const base = outcome === "win" ? 2 : outcome === "draw" ? 1 : 0;
  return streak >= STREAK_AFTER ? base * 2 : base;
}

/** The streak after a game: one longer for a win, gone otherwise. */
export const nextStreak = (outcome: ArenaOutcome, streak: number): number =>
  outcome === "win" ? streak + 1 : 0;

/**
 * Performance rating over a tournament's games, the standings' tiebreak:
 * the average opponent rating, plus 400 for every game won more than lost,
 * averaged over the games. 0 before the first game.
 */
export function performance(stats: {
  games: number;
  wins: number;
  draws: number;
  opponentRatingSum: number;
}): number {
  if (stats.games <= 0) return 0;
  const losses = stats.games - stats.wins - stats.draws;
  return Math.round((stats.opponentRatingSum + 400 * (stats.wins - losses)) / stats.games);
}

/** What a game changes on a player's tournament row. */
export interface ScoredGame {
  points: number;
  score: number;
  streak: number;
  games: number;
  wins: number;
  draws: number;
  opponentRatingSum: number;
  performance: number;
  /** The score sheet with this game's digit added */
  sheet: string;
}

/** The most digits a score sheet keeps (the newest ones). */
export const SHEET_MAX = 200;

export function scoreGame(
  player: {
    score: number;
    streak: number;
    games: number;
    wins: number;
    draws: number;
    opponentRatingSum: number;
    sheet: string;
  },
  outcome: ArenaOutcome,
  opponentRating: number
): ScoredGame {
  const points = arenaPoints(outcome, player.streak);
  const stats = {
    games: player.games + 1,
    wins: player.wins + (outcome === "win" ? 1 : 0),
    draws: player.draws + (outcome === "draw" ? 1 : 0),
    opponentRatingSum: player.opponentRatingSum + opponentRating,
  };
  return {
    points,
    score: player.score + points,
    streak: nextStreak(outcome, player.streak),
    ...stats,
    performance: performance(stats),
    sheet: `${player.sheet}${points}`.slice(-SHEET_MAX),
  };
}

/** A player waiting for a game, as the pairing reads them. */
export interface WaitingPlayer {
  userId: number;
  score: number;
  performance: number;
  /** Games they have had the white pieces in */
  whites: number;
  /** Games played */
  games: number;
  lastOpponentId: number | null;
  /** When they started waiting (ms): the longest wait breaks ties */
  waitingSince: number;
}

export interface ArenaPairing {
  whiteId: number;
  blackId: number;
}

/** Standings order: more points, then the better performance, then the lower id. */
export function compareStanding(
  a: { score: number; performance: number; userId: number },
  b: { score: number; performance: number; userId: number }
): number {
  return b.score - a.score || b.performance - a.performance || a.userId - b.userId;
}

/**
 * Who plays whom, out of the players waiting now.
 *
 * Neighbours in the standings meet: the list is sorted as the standings are
 * and paired from the top, each player with the nearest one below them they
 * may play. Two players may not play when one has blocked the other
 * (`blocked`), and are kept apart when they have just played each other, as
 * long as either has someone else to play in this round. With an odd number
 * the last one left sits out, unless they sat out longest already: the
 * player waiting longest is paired first when the count is odd, so nobody
 * sits out twice in a row.
 *
 * The side with fewer games as white (relative to games played) gets white;
 * `coin` breaks an even count and is injected so tests are repeatable.
 */
export function pairArena(
  waiting: readonly WaitingPlayer[],
  options: {
    /** True when the two must not be paired at all (a block between them) */
    blocked?: (a: number, b: number) => boolean;
    coin?: () => boolean;
  } = {}
): ArenaPairing[] {
  const blocked = options.blocked ?? (() => false);
  const coin = options.coin ?? (() => Math.random() < 0.5);
  const order = [...waiting].sort(compareStanding);
  // With an odd count somebody sits out; make sure it isn't whoever has
  // waited longest, by seating them first
  if (order.length % 2 === 1 && order.length > 1) {
    const longest = order.reduce((a, b) => (b.waitingSince < a.waitingSince ? b : a));
    order.splice(order.indexOf(longest), 1);
    order.unshift(longest);
  }

  const justPlayed = (a: WaitingPlayer, b: WaitingPlayer) =>
    a.lastOpponentId === b.userId || b.lastOpponentId === a.userId;
  const pairs: ArenaPairing[] = [];
  const left = order;
  while (left.length > 1) {
    const player = left.shift()!;
    // First someone they haven't just played; a repeat only when nobody
    // else is left for them
    let index = left.findIndex((other) => !blocked(player.userId, other.userId) && !justPlayed(player, other));
    if (index === -1) index = left.findIndex((other) => !blocked(player.userId, other.userId));
    if (index === -1) continue; // blocked with everyone still waiting: sits out
    const [opponent] = left.splice(index, 1) as [WaitingPlayer];
    pairs.push(colours(player, opponent, coin));
  }
  return pairs;
}

/** White goes to whoever has had it less often; a coin toss when that's even. */
function colours(a: WaitingPlayer, b: WaitingPlayer, coin: () => boolean): ArenaPairing {
  // Whites minus blacks: positive means they are owed the black pieces
  const balance = (p: WaitingPlayer) => 2 * p.whites - p.games;
  const diff = balance(a) - balance(b);
  const aIsWhite = diff === 0 ? coin() : diff < 0;
  return aIsWhite ? { whiteId: a.userId, blackId: b.userId } : { whiteId: b.userId, blackId: a.userId };
}

/**
 * How long before the end the last games are started: a game that can't
 * reasonably be played before the tournament closes shouldn't begin. The
 * tournament's clock in seconds, capped at a minute.
 */
export const lastPairingMs = (timeSeconds: number): number => Math.min(60, timeSeconds) * 1000;
