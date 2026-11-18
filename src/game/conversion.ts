import { Chess } from "chess.js";
import type { PlayerColor } from "../models/common.js";
import type { GameResult } from "./engine.js";
import { loadGame } from "./engine.js";

/**
 * Conversion drills (migration 037): positions from a player's own games
 * where they were clearly winning and did not win.
 *
 * The browser picks the position with Stockfish (the frontend's
 * features/conversion-drills: the first stretch where the player was at
 * least CONVERSION_MIN_CP ahead on two of their own moves in a row) and
 * replays it against the engine at full strength. These are the server's
 * checks on what it reports.
 */

/** "Clearly winning": at least this many centipawns up, from the player's side */
export const CONVERSION_MIN_CP = 300;
/** Largest evaluation stored (Stockfish's mate-free scores stay far below) */
export const CONVERSION_MAX_CP = 10_000;
export const CONVERSION_MAX_MATE = 100;

/** Games shorter than this many half-moves are never scanned: nothing to convert yet */
export const CONVERSION_MIN_PLIES = 16;

/** Whether `color` failed to win a game that ended with `result` (an aborted game doesn't count). */
export function notWonBy(color: PlayerColor, result: GameResult | null): boolean {
  if (result === null || result === "aborted") return false;
  return result !== (color === "white" ? "white_win" : "black_win");
}

/**
 * The position after the first `ply` half-moves of `pgn`, when `color` is to
 * move there and the game isn't over on the board; null otherwise. The
 * drill starts from it, so the server computes it rather than taking the
 * browser's.
 */
export function drillPosition(pgn: string, ply: number, color: PlayerColor): string | null {
  let moves: string[];
  try {
    moves = loadGame(pgn).history();
  } catch {
    return null;
  }
  if (!Number.isInteger(ply) || ply < 0 || ply >= moves.length) return null;
  const chess = new Chess();
  for (const san of moves.slice(0, ply)) chess.move(san);
  if ((chess.turn() === "w" ? "white" : "black") !== color) return null;
  if (chess.isGameOver()) return null;
  return chess.fen();
}

/** Whether a reported evaluation (the player's side) is "clearly winning". */
export function isClearlyWinning(evaluation: { cp: number } | { mate: number }): boolean {
  if ("mate" in evaluation) return evaluation.mate > 0 && evaluation.mate <= CONVERSION_MAX_MATE;
  return evaluation.cp >= CONVERSION_MIN_CP && evaluation.cp <= CONVERSION_MAX_CP;
}
