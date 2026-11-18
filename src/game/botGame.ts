import { Chess } from "chess.js";
import type { PlayerColor } from "../models/common.js";
import { AppError } from "../errors/AppError.js";
import { detectOutcome, winFor, type Outcome } from "./engine.js";

/**
 * Longest PGN accepted for a bot game. The browser sends chess.js's pgn()
 * with seven short headers (about 150 characters plus the two names) and
 * the moves: "123. Kf2 Kg7 " is about 13 characters a full move, a capture
 * with check a few more. A 300-move game, longer than practically any game
 * against a bot (they end by mate, repetition or the 50-move rule), is
 * about 5 KB; 8,000 characters leaves room for some 500 moves.
 */
export const MAX_BOT_GAME_PGN_LENGTH = 8_000;

export interface ReplayedBotGame {
  /** Moves only, no headers: the same format live games store */
  pgn: string;
  fen: string;
  /** Half-moves played */
  numMoves: number;
  outcome: Outcome;
}

const invalid = (message: string) => new AppError(message, "INVALID_BOT_GAME", 400);
const notLegal = () => invalid("The PGN isn't a legal game");

/**
 * chess.js's pgn() for a game from the initial position with no headers
 * set (the seven-tag roster), without its result token: what live games
 * store before their moves (see appendToPgn in engine.ts).
 */
const PGN_HEADER = new Chess().pgn().replace(/\n \*$/, "");

const RESULT_TOKENS = new Set(["1-0", "0-1", "1/2-1/2", "*"]);

/**
 * Reads a PGN's tag pairs and the moves of its main line, in one pass over
 * the text and without playing them: comments ({...} and ; to the end of
 * the line), variations ((...), nested), NAGs ($n), move numbers and the
 * result are skipped, as chess.js's loadPgn skips them. Throws on an
 * unclosed comment, tag or variation, or moves after the result.
 */
export function readPgn(pgn: string): { headers: Map<string, string>; sans: string[] } {
  const headers = new Map<string, string>();
  const sans: string[] = [];
  let depth = 0;
  let ended = false;
  let i = 0;
  const n = pgn.length;

  const token = (text: string) => {
    if (depth > 0) return;
    // "12." or "12..." before a move, with or without a space after it
    const move = text.replace(/^\d+\.+/, "");
    if (move === "" || /^\$\d+$/.test(move)) return;
    if (RESULT_TOKENS.has(move)) {
      ended = true;
      return;
    }
    if (ended) throw invalid("Moves were played after the game was over");
    sans.push(move);
  };

  while (i < n) {
    const c = pgn[i]!;
    if (c === "{") {
      const close = pgn.indexOf("}", i + 1);
      if (close === -1) throw notLegal();
      i = close + 1;
    } else if (c === ";") {
      const newline = pgn.indexOf("\n", i + 1);
      i = newline === -1 ? n : newline + 1;
    } else if (c === "%" && (i === 0 || pgn[i - 1] === "\n")) {
      // An escaped line
      const newline = pgn.indexOf("\n", i + 1);
      i = newline === -1 ? n : newline + 1;
    } else if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      if (--depth < 0) throw notLegal();
      i++;
    } else if (c === "[" && depth === 0) {
      // A tag pair: [Name "value"], where the value may contain \" and \\
      const match = /^\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/.exec(pgn.slice(i, i + 1_000));
      if (!match) throw notLegal();
      headers.set(match[1]!, match[2]!.replace(/\\(.)/g, "$1"));
      i += match[0].length;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let end = i;
      while (end < n && !/[\s{}();[\]]/.test(pgn[end]!)) end++;
      token(pgn.slice(i, end));
      i = end;
    }
  }
  if (depth !== 0) throw notLegal();
  return { headers, sans };
}

/**
 * Replays a finished bot game sent by the browser and works out its result.
 * Every move must be legal from the standard starting position, and the game
 * must not go on after it was already over. The result comes from the final
 * position (checkmate, stalemate, draws); only a resignation, which leaves
 * no trace on the board, is taken from the client, and only the player can
 * resign (bots never do).
 *
 * The moves are played once: the text is read without chess.js (readPgn),
 * each move is played and checked on one board, and the stored PGN is
 * written from the moves as played, in exactly the format chess.js's pgn()
 * gives (which would replay the game again, as loadPgn and history() do).
 */
export function replayBotGame(
  pgn: string,
  playerColor: PlayerColor,
  claimedReason: string
): ReplayedBotGame {
  if (pgn.length > MAX_BOT_GAME_PGN_LENGTH) throw invalid("Game is too long");

  const { headers, sans } = readPgn(pgn);
  if (headers.has("FEN") || headers.get("SetUp") === "1") {
    throw invalid("Games must start from the standard position");
  }
  if (sans.length === 0) throw invalid("The game has no moves");

  // A clean board, so nothing from the client's headers carries over
  const chess = new Chess();
  const movetext: string[] = [];
  for (let i = 0; i < sans.length; i++) {
    let san: string;
    try {
      san = chess.move(sans[i]!).san;
    } catch {
      throw notLegal();
    }
    movetext.push(i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san);
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

  return {
    pgn: `${PGN_HEADER}\n\n${movetext.join(" ")} *`,
    fen: chess.fen(),
    numMoves: sans.length,
    outcome,
  };
}
