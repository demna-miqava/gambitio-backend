import { Chess } from "chess.js";
import type { PlayerColor } from "../models/common.js";
import { AppError } from "../errors/AppError.js";

/** Longest line a repertoire may hold, in half-moves. */
export const MAX_LINE_PLIES = 60;
/** Lines one player may keep. */
export const MAX_LINES_PER_USER = 300;

const invalidLine = (message: string) => new AppError(message, "INVALID_LINE", 400);

/**
 * Plays a line from the standard starting position and returns it in
 * chess.js's own SAN (so "Nf3" and "Ng1f3" are stored the same way).
 * Throws INVALID_LINE on an illegal or over-long line.
 */
export function normalizeLine(moves: string[]): string[] {
  if (moves.length === 0) throw invalidLine("The line has no moves");
  if (moves.length > MAX_LINE_PLIES) {
    throw invalidLine(`Lines can be at most ${MAX_LINE_PLIES} half-moves long`);
  }
  const chess = new Chess();
  return moves.map((san, i) => {
    try {
      return chess.move(san).san;
    } catch {
      throw invalidLine(`Move ${i + 1} (${san}) isn't legal there`);
    }
  });
}

/**
 * The part of a FEN that identifies a position for opening purposes: the
 * board, side to move, castling rights and en passant square. Move counters
 * are left out so transpositions meet.
 */
export function positionKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

export interface BookLine {
  id: number;
  name: string;
  /** SAN from the starting position */
  moves: string[];
}

/** Moves the repertoire has at a position, each with the lines that play it. */
export type Book = Map<string, Map<string, { lineIds: number[]; lineNames: string[] }>>;

const STARTING_FEN = new Chess().fen();

/**
 * Every position lines pass through, with the moves played from it, built
 * one line at a time (so a caller can let other work run in between: a few
 * hundred lines take a while on a small CPU). Lines that start the same way
 * (most of a repertoire) share their opening moves, which are played once:
 * a move is only played on a board when no earlier line already went that way.
 */
export class BookBuilder {
  readonly book: Book = new Map();
  // Moves from the start, joined by spaces -> the position they lead to
  private reached = new Map<string, { fen: string; san: string }>();

  add(line: BookLine): void {
    let path = "";
    let fen = STARTING_FEN;
    // A board at `fen`, made only when a move must actually be played
    let chess: Chess | null = null;
    for (const san of line.moves) {
      const next = path ? `${path} ${san}` : san;
      let step = this.reached.get(next);
      if (step) {
        chess = null; // the board would now be behind; made again from the FEN if needed
      } else {
        chess ??= new Chess(fen);
        let move;
        try {
          move = chess.move(san);
        } catch {
          break; // stored lines are normalised; a bad one just stops here
        }
        step = { fen: chess.fen(), san: move.san };
        this.reached.set(next, step);
      }

      const key = positionKey(fen);
      let moves = this.book.get(key);
      if (!moves) this.book.set(key, (moves = new Map()));
      const entry = moves.get(step.san) ?? { lineIds: [], lineNames: [] };
      if (!entry.lineIds.includes(line.id)) {
        entry.lineIds.push(line.id);
        entry.lineNames.push(line.name);
      }
      moves.set(step.san, entry);
      path = next;
      fen = step.fen;
    }
  }
}

/** Every position the lines pass through, with the moves played from it. */
export function buildBook(lines: BookLine[]): Book {
  const builder = new BookBuilder();
  for (const line of lines) builder.add(line);
  return builder.book;
}

/** Result tokens that end PGN movetext. */
const PGN_RESULT = /^(1-0|0-1|1\/2-1\/2|\*)$/;

/**
 * The moves of a stored game, in SAN, read from its PGN text without
 * replaying it (checkGame plays them, once). Stored PGNs are written by the
 * server (appendToPgn, chess.js's pgn()): tag lines, then "1. e4 e5 2. Nf3 *".
 * Comments, variations, annotations and NAGs are skipped as well, in case a
 * PGN has them. A game set up from another position has no moves here (the
 * repertoire starts from the standard one). At most `max` moves are read:
 * checkGame never looks further than a line can be long.
 */
export function pgnSans(pgn: string, max = Infinity): string[] {
  // The tag pairs, one per line
  const tags = pgn.match(/^\s*\[.*\]\s*$/gm) ?? [];
  if (tags.some((tag) => /^\s*\[\s*(FEN|SetUp)\s/.test(tag))) return [];
  let text = pgn
    .replace(/^\s*\[.*\]\s*$/gm, " ")
    .replace(/\{[^}]*\}/g, " ") // {comments}
    .replace(/;[^\n]*/g, " "); // comments to the end of the line
  // (Variations), which can be nested: innermost first
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/\([^()]*\)/g, " ");
  }

  const sans: string[] = [];
  for (const token of text.split(/\s+/)) {
    if (sans.length >= max) break;
    // A move number ("12." or "12...") may be written against its move ("12.e4")
    const move = token.replace(/^\d+\.+/, "").replace(/[!?]+$/, "");
    if (!move || move.startsWith("$")) continue;
    if (PGN_RESULT.test(move)) break;
    sans.push(move);
  }
  return sans;
}

export type GameCheckStatus =
  /** The game followed the preparation to its end (or the game ended first) */
  | "followed"
  /** The player left their own preparation */
  | "you_deviated"
  /** The opponent played a move the preparation doesn't cover */
  | "opponent_deviated"
  /** The very first position of the player's colour had no preparation */
  | "not_covered";

export interface GameCheck {
  status: GameCheckStatus;
  /** Half-moves played inside the preparation */
  pliesInBook: number;
  /** Where the game left the preparation (not set for "followed") */
  divergence: {
    /** 1-based half-move number of the move that left the book */
    ply: number;
    moveNumber: number;
    /** Who was to move */
    color: PlayerColor;
    played: string;
    /** The repertoire's moves in that position */
    expected: string[];
    /** Position before the move */
    fen: string;
    /** Lines that reach that position */
    lineNames: string[];
  } | null;
}

/**
 * Compares a game with the player's repertoire for the colour they played.
 * Walks the game while its positions are in the book: at the player's turn
 * a move the book doesn't have is "you_deviated"; at the opponent's turn
 * it is "opponent_deviated". A position the book reaches but has no moves
 * for is the end of the preparation ("followed").
 */
export function checkGame(book: Book, gameSans: string[], color: PlayerColor): GameCheck {
  const chess = new Chess();
  const playerTurn = color === "white" ? "w" : "b";
  for (let i = 0; i < gameSans.length; i++) {
    const fen = chess.fen();
    const moves = book.get(positionKey(fen));
    if (!moves || moves.size === 0) {
      return { status: i === 0 ? "not_covered" : "followed", pliesInBook: i, divergence: null };
    }
    let played;
    try {
      played = chess.move(gameSans[i]!).san;
    } catch {
      return { status: "followed", pliesInBook: i, divergence: null };
    }
    if (!moves.has(played)) {
      const lineNames = [...new Set([...moves.values()].flatMap((m) => m.lineNames))];
      return {
        status: chess.turn() === playerTurn ? "opponent_deviated" : "you_deviated",
        pliesInBook: i,
        divergence: {
          ply: i + 1,
          moveNumber: Math.floor(i / 2) + 1,
          color: i % 2 === 0 ? "white" : "black",
          played,
          expected: [...moves.keys()],
          fen,
          lineNames,
        },
      };
    }
  }
  return { status: "followed", pliesInBook: gameSans.length, divergence: null };
}

/** Days until a line is due again after `streak` correct recalls in a row. */
const INTERVAL_DAYS = [1, 3, 7, 14, 30, 60];

export function nextDue(now: Date, correct: boolean, streak: number): { streak: number; dueAt: Date } {
  if (!correct) return { streak: 0, dueAt: now };
  const next = streak + 1;
  const days = INTERVAL_DAYS[Math.min(next, INTERVAL_DAYS.length) - 1]!;
  return { streak: next, dueAt: new Date(now.getTime() + days * 24 * 60 * 60_000) };
}
