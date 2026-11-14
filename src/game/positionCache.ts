import type { Chess } from "chess.js";
import { loadGame } from "./engine.js";

interface Entry {
  chess: Chess;
  /** The stored PGN `chess` corresponds to */
  pgn: string;
  ply: number;
}

/** Live games whose position is kept; the least recently used is dropped beyond this. */
const MAX_ENTRIES = 2_000;

/**
 * Parsed positions of live games, so a move doesn't replay the whole game
 * from its PGN (which costs tens of milliseconds of CPU in a long game).
 *
 * An entry is only used when it matches the row just read under the game's
 * row lock (same ply and PGN), so a stale entry (a move made on another
 * server instance, a rolled-back transaction) is never trusted; it is
 * rebuilt from the PGN instead.
 */
export class PositionCache {
  private entries = new Map<number, Entry>();

  /**
   * The position after `pgn`, for the caller to read or play a move on.
   * Callers must hold the game's row lock and call commit() or drop() once
   * they know whether the move was stored.
   */
  checkout(gameId: number, pgn: string | null, ply: number): Chess {
    const stored = pgn ?? "";
    const entry = this.entries.get(gameId);
    // Taken out while in use: a failed transaction can't leave a mutated
    // position behind
    this.entries.delete(gameId);
    if (entry && entry.ply === ply && entry.pgn === stored) return entry.chess;
    return loadGame(stored);
  }

  /** Stores the position after a committed move. */
  commit(gameId: number, chess: Chess, pgn: string, ply: number): void {
    this.entries.delete(gameId);
    this.entries.set(gameId, { chess, pgn, ply });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  drop(gameId: number): void {
    this.entries.delete(gameId);
  }

  get size(): number {
    return this.entries.size;
  }
}
