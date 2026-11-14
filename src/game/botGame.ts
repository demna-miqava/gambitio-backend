import { Chess } from "chess.js";
import type { PlayerColor } from "../models/common.js";
import { AppError } from "../errors/AppError.js";
import { detectOutcome, winFor, type Outcome } from "./engine.js";

/** Longest PGN accepted for a bot game. A 300-move game is about 5 KB. */
export const MAX_BOT_GAME_PGN_LENGTH = 16_000;

export interface ReplayedBotGame {
  /** Moves only, no headers: the same format live games store */
  pgn: string;
  fen: string;
  /** Half-moves played */
  numMoves: number;
  outcome: Outcome;
}

const invalid = (message: string) => new AppError(message, "INVALID_BOT_GAME", 400);

/**
 * Replays a finished bot game sent by the browser and works out its result.
 * Every move must be legal from the standard starting position, and the game
 * must not go on after it was already over. The result comes from the final
 * position (checkmate, stalemate, draws); only a resignation, which leaves
 * no trace on the board, is taken from the client, and only the player can
 * resign (bots never do).
 */
export function replayBotGame(
  pgn: string,
  playerColor: PlayerColor,
  claimedReason: string
): ReplayedBotGame {
  if (pgn.length > MAX_BOT_GAME_PGN_LENGTH) throw invalid("Game is too long");

  const parsed = new Chess();
  try {
    parsed.loadPgn(pgn);
  } catch {
    throw invalid("The PGN isn't a legal game");
  }
  const headers = parsed.getHeaders();
  if (headers.FEN || headers.SetUp === "1") {
    throw invalid("Games must start from the standard position");
  }
  const sans = parsed.history();
  if (sans.length === 0) throw invalid("The game has no moves");

  // Replay on a clean board so nothing from the client's headers carries over
  const chess = new Chess();
  for (let i = 0; i < sans.length; i++) {
    chess.move(sans[i]!);
    if (i < sans.length - 1 && detectOutcome(chess)) {
      throw invalid("Moves were played after the game was over");
    }
  }

  const fromPosition = detectOutcome(chess);
  let outcome: Outcome;
  if (fromPosition) {
    outcome = fromPosition;
  } else if (claimedReason === "resignation") {
    outcome = { result: winFor(playerColor === "white" ? "black" : "white"), reason: "resignation" };
  } else {
    throw invalid("The game isn't over");
  }

  return { pgn: chess.pgn(), fen: chess.fen(), numMoves: sans.length, outcome };
}
