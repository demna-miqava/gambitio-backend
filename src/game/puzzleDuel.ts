import { Chess, type Square } from "chess.js";

/**
 * Puzzle duel rules, without the database (PuzzleDuelService runs them).
 * Puzzle Rush's rules: a wrong move is a strike and moves the player to the
 * next puzzle; three strikes and they're out. The higher score when the
 * clock ends, or when both are out, wins; equal scores are a draw.
 */

/** How long a duel runs */
export const DUEL_MS = 3 * 60_000;
/** The countdown between the accept and the first puzzle */
export const DUEL_COUNTDOWN_MS = 5_000;
export const DUEL_MAX_STRIKES = 3;
/** Puzzles prepared for a duel: more than anyone solves in three minutes */
export const DUEL_PUZZLE_COUNT = 60;
/** An unanswered invite lapses after this */
export const DUEL_INVITE_TTL_MS = 3 * 60_000;

/** The first puzzle's rating, and how much harder each next one is */
const LADDER_START = 600;
const LADDER_STEP = 40;

/** The rating each puzzle of a duel is picked near: easy first, then harder */
export const duelRatingLadder = (count = DUEL_PUZZLE_COUNT): number[] =>
  Array.from({ length: count }, (_, i) => LADDER_START + i * LADDER_STEP);

export type DuelMoveOutcome =
  /** Right, and the puzzle goes on: the opponent's reply */
  | { kind: "continue"; move: string; reply: string }
  /** Right, and that was the last move (or a mate) */
  | { kind: "solved"; move: string }
  /** A legal move that isn't the solution */
  | { kind: "wrong"; move: string };

/** Plays a UCI move; null if it's illegal. */
function play(chess: Chess, uci: string) {
  try {
    return chess.move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      ...(uci[4] ? { promotion: uci[4] } : {}),
    });
  } catch {
    return null;
  }
}

/**
 * Judges the player's next move in a puzzle. `fen` and `solution` are the
 * puzzle as stored (the solver moves first: their moves are at even
 * indices), `progress` the player's own moves so far (all right). Null for
 * an illegal move or a puzzle that's already over, which the caller
 * refuses without a strike. As in rated puzzles, any mate counts, and a
 * promotion on the right squares counts as the solution's promotion.
 */
export function judgeDuelMove(
  fen: string,
  solution: readonly string[],
  progress: readonly string[],
  sent: string
): DuelMoveOutcome | null {
  const chess = new Chess(fen);
  // Replay what has been played so far: the player's moves and the replies
  for (let i = 0; i < progress.length; i++) {
    if (!play(chess, solution[2 * i]!) || !play(chess, solution[2 * i + 1] ?? "")) return null;
  }
  const expected = solution[2 * progress.length];
  if (!expected) return null;
  const move = sent.slice(0, 4) === expected.slice(0, 4) && expected.length === 5 ? expected : sent;
  if (!play(chess, move)) return null;
  if (move !== expected && !chess.isCheckmate()) return { kind: "wrong", move };
  const reply = solution[2 * progress.length + 1];
  if (chess.isCheckmate() || !reply) return { kind: "solved", move };
  return { kind: "continue", move, reply };
}

export interface DuelPlayerScore {
  userId: number;
  score: number;
  strikes: number;
}

/** The winner's id, or null for a draw */
export const duelWinner = (players: readonly DuelPlayerScore[]): number | null => {
  const [a, b] = players;
  if (!a || !b || a.score === b.score) return null;
  return a.score > b.score ? a.userId : b.userId;
};

/** Both players are out of strikes (or out of puzzles), so the duel is over before its clock */
export const allOut = (players: readonly { strikes: number; current: number }[], puzzleCount: number) =>
  players.length === 2 && players.every((p) => p.strikes >= DUEL_MAX_STRIKES || p.current >= puzzleCount);
