import { Chess, type Square } from "chess.js";
import type { PlayerColor } from "../models/common.js";

export type GameResult = "white_win" | "black_win" | "draw" | "aborted";

export type EndReason =
  | "checkmate"
  | "resignation"
  | "timeout"
  | "timeout_vs_insufficient_material"
  | "stalemate"
  | "draw_agreement"
  | "threefold_repetition"
  | "insufficient_material"
  | "fifty_move_rule"
  | "aborted";

export interface Outcome {
  result: GameResult;
  reason: EndReason;
}

export interface MoveInput {
  from: string;
  to: string;
  promotion?: "q" | "r" | "b" | "n" | undefined;
}

export interface AppliedMove {
  from: string;
  to: string;
  promotion?: string;
  san: string;
  lan: string;
}

export type ApplyMoveResult =
  | {
      ok: true;
      move: AppliedMove;
      mover: PlayerColor;
      fen: string;
      pgn: string;
      ply: number;
      outcome: Outcome | null;
    }
  | { ok: false; reason: string };

export const STARTING_FEN = new Chess().fen();

/** Rebuilds the position from stored PGN. The PGN is always produced by this module. */
export function loadGame(pgn: string | null | undefined): Chess {
  const chess = new Chess();
  if (pgn) chess.loadPgn(pgn);
  return chess;
}

export function colorToMove(chess: Chess): PlayerColor {
  return chess.turn() === "w" ? "white" : "black";
}

export function winFor(color: PlayerColor): GameResult {
  return color === "white" ? "white_win" : "black_win";
}

/** Game-ending conditions that follow from the position alone. */
export function detectOutcome(chess: Chess): Outcome | null {
  if (chess.isCheckmate()) {
    // The side to move is mated
    const winner: PlayerColor = chess.turn() === "w" ? "black" : "white";
    return { result: winFor(winner), reason: "checkmate" };
  }
  if (chess.isStalemate()) return { result: "draw", reason: "stalemate" };
  if (chess.isInsufficientMaterial()) return { result: "draw", reason: "insufficient_material" };
  if (chess.isThreefoldRepetition()) return { result: "draw", reason: "threefold_repetition" };
  if (chess.isDrawByFiftyMoves()) return { result: "draw", reason: "fifty_move_rule" };
  return null;
}

/**
 * Validates and applies a move to the stored game. Illegal input never throws;
 * it returns ok: false so the caller can tell the client to resync.
 */
export function applyMove(pgn: string | null | undefined, input: MoveInput): ApplyMoveResult {
  const chess = loadGame(pgn);
  const mover = colorToMove(chess);

  let move;
  try {
    move = chess.move({
      from: input.from as Square,
      to: input.to as Square,
      ...(input.promotion ? { promotion: input.promotion } : {}),
    });
  } catch {
    return { ok: false, reason: "Illegal move" };
  }

  return {
    ok: true,
    move: {
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
      san: move.san,
      lan: move.lan,
    },
    mover,
    fen: chess.fen(),
    pgn: chess.pgn(),
    ply: chess.history().length,
    outcome: detectOutcome(chess),
  };
}

/**
 * FIDE 6.9: if a player's flag falls but the opponent cannot checkmate by any
 * sequence of legal moves, the game is drawn. This approximates "cannot mate"
 * as having only a king, or king plus a single bishop or knight.
 */
export function canStillMate(chess: Chess, color: PlayerColor): boolean {
  const side = color === "white" ? "w" : "b";
  const pieces = chess
    .board()
    .flat()
    .filter((sq) => sq !== null && sq.color === side && sq.type !== "k");
  if (pieces.length === 0) return false;
  if (pieces.length === 1 && (pieces[0]!.type === "b" || pieces[0]!.type === "n")) return false;
  return true;
}

/** Result when `flagged` runs out of time. */
export function timeoutOutcome(chess: Chess, flagged: PlayerColor): Outcome {
  const opponent: PlayerColor = flagged === "white" ? "black" : "white";
  if (!canStillMate(chess, opponent)) {
    return { result: "draw", reason: "timeout_vs_insufficient_material" };
  }
  return { result: winFor(opponent), reason: "timeout" };
}
