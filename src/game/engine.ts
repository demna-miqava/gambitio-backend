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
 *
 * Replays the whole game first; the live game service uses applyMoveTo on a
 * cached position instead (see LiveGameService).
 */
export function applyMove(pgn: string | null | undefined, input: MoveInput): ApplyMoveResult {
  const chess = loadGame(pgn);
  return applyMoveTo(chess, pgn ?? "", chess.history().length, input);
}

/**
 * Applies a move to `chess` in place, which must be the position after `pgn`
 * (`ply` half-moves played). Costs one move generation regardless of game
 * length: the new PGN is the old one plus this move, never a replay. On an
 * illegal move `chess` is left unchanged.
 */
export function applyMoveTo(chess: Chess, pgn: string, ply: number, input: MoveInput): ApplyMoveResult {
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
    pgn: appendToPgn(pgn, ply, move.san) ?? chess.pgn(),
    ply: ply + 1,
    outcome: detectOutcome(chess),
  };
}

/**
 * Least ply a takeback may go back to: both players have moved, so the clock
 * keeps running and the first-move window (abort, FIRST_MOVE_TIMEOUT_MS)
 * never opens again.
 */
export const MIN_TAKEBACK_PLY = 2;

/**
 * Half-moves undone when `requester` asks for a takeback at `ply`: their own
 * last move, plus the opponent's reply when there is one (it's the
 * requester's turn). Null when that would go back before MIN_TAKEBACK_PLY,
 * which also covers a requester who hasn't moved yet.
 */
export function takebackPlies(ply: number, requester: PlayerColor): number | null {
  const toMove: PlayerColor = ply % 2 === 0 ? "white" : "black";
  const plies = toMove === requester ? 2 : 1;
  return ply - plies >= MIN_TAKEBACK_PLY ? plies : null;
}

/**
 * Takes back the last `plies` half-moves of `chess` in place, which must be
 * the position after `pgn` (`ply` half-moves). The new PGN is `pgn` with
 * those moves cut off (truncatePgn), not chess.pgn(), which replays the
 * whole game to write it; chess.pgn() is only the fallback for a PGN in
 * another format (or without `pgn`), and writes the same format.
 */
export function undoMoves(
  chess: Chess,
  ply: number,
  plies: number,
  pgn?: string
): { fen: string; pgn: string; ply: number } {
  const undone: string[] = [];
  for (let i = 0; i < plies; i++) {
    const move = chess.undo();
    if (move) undone.unshift(move.san);
  }
  const cut = pgn !== undefined && undone.length === plies ? truncatePgn(pgn, ply, undone) : null;
  return { fen: chess.fen(), pgn: cut ?? chess.pgn(), ply: ply - plies };
}

/** Space-separated tokens ("1.", "e4", "e5", "2.", ...) for `ply` half-moves in appendToPgn's format */
const moveTokens = (ply: number) => ply + Math.ceil(ply / 2);

/**
 * `pgn` (`ply` half-moves, in appendToPgn's format) without its last moves,
 * which must be `undone` (their SAN, in order); null if it isn't in that
 * format or the moves don't match, so the caller can fall back to
 * chess.pgn(). Keeps at least one move: an empty game's PGN is formatted
 * differently.
 */
export function truncatePgn(pgn: string, ply: number, undone: string[]): string | null {
  const kept = ply - undone.length;
  if (kept < 1 || !pgn.startsWith(`${PGN_HEADER}\n\n`) || !pgn.endsWith(PGN_TAIL)) return null;
  const tokens = pgn.slice(PGN_HEADER.length + 2, -PGN_TAIL.length).split(" ");
  if (tokens.length !== moveTokens(ply)) return null;
  const removed = tokens.slice(moveTokens(kept)).filter((token) => !/^\d+\.$/.test(token));
  if (removed.join(" ") !== undone.join(" ")) return null;
  return `${PGN_HEADER}\n\n${tokens.slice(0, moveTokens(kept)).join(" ")}${PGN_TAIL}`;
}

/**
 * chess.js's pgn() output for a game started from the initial position with
 * no headers set: the seven-tag roster, a blank line, the moves, then the
 * result token, which stays "*" (chess.js never sets Result).
 */
const PGN_HEADER = new Chess().pgn().replace(/\n \*$/, "");
const PGN_TAIL = " *";

/**
 * The PGN after appending the move `san` at half-move `ply` (0-based), in
 * exactly chess.js's format, so clients comparing against their own
 * chess.pgn() see equal strings. Returns null when `pgn` isn't in that
 * format, so the caller can fall back to chess.pgn().
 */
export function appendToPgn(pgn: string, ply: number, san: string): string | null {
  const prefix = ply % 2 === 0 ? `${ply / 2 + 1}. ` : "";
  if (ply === 0) return pgn ? null : `${PGN_HEADER}\n\n${prefix}${san}${PGN_TAIL}`;
  if (!pgn.startsWith(`${PGN_HEADER}\n\n`) || !pgn.endsWith(PGN_TAIL)) return null;
  return `${pgn.slice(0, -PGN_TAIL.length)} ${prefix}${san}${PGN_TAIL}`;
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
