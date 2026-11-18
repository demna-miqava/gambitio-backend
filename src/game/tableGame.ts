import type { PlayerColor } from "../models/common.js";
import { AppError } from "../errors/AppError.js";
import { detectOutcome, timeoutOutcome, type EndReason, type GameResult, type Outcome } from "./engine.js";
import { playBrowserPgn } from "./botGame.js";
import { stripInvisibleText } from "./chatText.js";

/**
 * Table mode: two people at a real board use one phone as the clock and the
 * move recorder. The game is played in the browser and stored once it is
 * over (POST /api/games/table), like a bot game: the server replays the PGN
 * and checks the result the browser claims against it. Table games are
 * never rated and touch no ratings, stats, head-to-head, leaderboard
 * counters, series or repertoire checks: they show in history and review,
 * and nowhere else (migration 040).
 */

/** Longest PGN accepted (the same room as bot games: some 500 moves) */
export const MAX_TABLE_GAME_PGN_LENGTH = 8_000;
/** Games one player may save a day */
export const TABLE_GAMES_PER_DAY = 100;
/** Games waiting for one friend to confirm, from one player */
export const MAX_PENDING_TABLE_GAMES_PER_PAIR = 5;
/** A guest is stored as a name only; the games table holds up to 30 characters */
export const MAX_GUEST_NAME_LENGTH = 30;

/** How a table game can end, as the browser reports it */
export const TABLE_END_REASONS = [
  "checkmate",
  "stalemate",
  "insufficient_material",
  "threefold_repetition",
  "fifty_move_rule",
  "resignation",
  "draw_agreement",
  "timeout",
  "timeout_vs_insufficient_material",
] as const satisfies readonly EndReason[];
export type TableEndReason = (typeof TABLE_END_REASONS)[number];

export interface TableGameClaim {
  result: Exclude<GameResult, "aborted">;
  endReason: TableEndReason;
}

export interface ReplayedTableGame {
  /** Moves only, no headers: the format live games store */
  pgn: string;
  fen: string;
  numMoves: number;
  outcome: Outcome;
}

const invalid = (message: string) => new AppError(message, "INVALID_TABLE_GAME", 400);
const mismatch = () => invalid("The result doesn't match the game");

/**
 * Replays a finished table game and checks the result the browser claims.
 * A result the final position decides (mate, stalemate and the automatic
 * draws) must be that one. Otherwise the board can't tell, so the claim
 * stands if it fits: a resignation is a win for either side, an agreed draw
 * a draw, and a flag falls for the side to move, whose result is the
 * server's own rule (timeoutOutcome: a flag against a side that can't mate
 * is a draw).
 */
export function replayTableGame(pgn: string, claim: TableGameClaim): ReplayedTableGame {
  if (pgn.length > MAX_TABLE_GAME_PGN_LENGTH) throw invalid("Game is too long");
  const { chess, pgn: stored, numMoves } = playBrowserPgn(pgn, invalid);

  let outcome: Outcome;
  const fromPosition = detectOutcome(chess);
  if (fromPosition) {
    outcome = fromPosition;
  } else {
    switch (claim.endReason) {
      case "resignation":
        if (claim.result === "draw") throw mismatch();
        outcome = { result: claim.result, reason: "resignation" };
        break;
      case "draw_agreement":
        if (claim.result !== "draw") throw mismatch();
        outcome = { result: "draw", reason: "draw_agreement" };
        break;
      case "timeout":
      case "timeout_vs_insufficient_material": {
        const flagged: PlayerColor = chess.turn() === "w" ? "white" : "black";
        outcome = timeoutOutcome(chess, flagged);
        break;
      }
      default:
        // Mate, stalemate or an automatic draw the position doesn't show
        throw mismatch();
    }
  }
  if (outcome.result !== claim.result || outcome.reason !== claim.endReason) throw mismatch();
  return { pgn: stored, fen: chess.fen(), numMoves, outcome };
}

/**
 * A guest's name as stored: invisible and control characters removed (as in
 * chat), whitespace collapsed, trimmed. Null when nothing visible is left
 * or it is too long.
 */
export function cleanGuestName(raw: string): string | null {
  const name = stripInvisibleText(raw).replace(/\s+/gu, " ").trim();
  if (!/[^\s‌‍︀-️]/u.test(name)) return null;
  if ([...name].length > MAX_GUEST_NAME_LENGTH || name.length > MAX_GUEST_NAME_LENGTH) return null;
  return name;
}
