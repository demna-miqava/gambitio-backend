import type { FastifyInstance } from "fastify";
import { Chess, type Square } from "chess.js";
import { AppError } from "../errors/AppError.js";
import { calculatePuzzleRating } from "../utils/puzzleRating.js";
import { invalidatePuzzleStats } from "./statsService.js";
import { cachedValue } from "../utils/cache.js";

export interface PuzzleRow {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  themes: string[] | null;
}

export interface PuzzleQuery {
  userId: number;
  cursor?: { rating: number; id: string } | undefined;
  limit: number;
  theme?: string | undefined;
  /** "rated": Infinite mode, served near the user's puzzle rating. */
  mode: "ascending" | "rated";
}

export interface AttemptResult {
  /** False for repeat attempts, which don't change the rating. */
  rated: boolean;
  puzzleRating: number;
  highestPuzzleRating: number;
  ratingChange: number;
}

/** POST /puzzles/:id/check and /reveal */
export type CheckResult =
  | { result: "continue"; line: string[] }
  | { result: "solved" | "failed"; line: string[]; attempt: AttemptResult };

export interface ThemeCount {
  theme: string;
  count: number;
}

/**
 * Rated mode starts this far below the user's puzzle rating, so a session
 * opens at about their level (expected score ~0.57) and climbs from there.
 */
const RATED_START_BELOW = 50;
const THEMES_CACHE_KEY = "puzzles:theme-counts";

/**
 * The puzzles are split in two by id. Rated mode only serves (and only
 * rates) one half, and never sends its solutions: the server checks each
 * move. Rush and Survival serve the other half with solutions, to play
 * locally. Otherwise one account could read a solution from the unrated
 * feed and play it for rating. (Lichess ids use [0-9A-Za-z], which splits
 * evenly by character code parity.) Each half has its own index on
 * (rating, id), whose WHERE is exactly these expressions (migration 031).
 */
export const RATED_POOL_SQL = (alias: string) => `ascii(right(${alias}.id, 1)) % 2 = 0`;
export const isRatedPool = (puzzleId: string) => puzzleId.charCodeAt(puzzleId.length - 1) % 2 === 0;

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
 * Themes only change when puzzles are imported, and the counts are read
 * from a small table the import fills, so a stale entry is served while it
 * is refreshed.
 */
const THEMES_CACHE_SECONDS = 60 * 60;
const THEMES_STALE_SECONDS = 24 * 60 * 60;

export class PuzzleService {
  constructor(private fastify: FastifyInstance) {}

  /**
   * One keyset page ordered by (rating, id). Unsolved puzzles only; rated mode
   * also skips puzzles already attempted (a repeat couldn't be rated). Rated
   * mode's first page starts near the user's puzzle rating; when nothing is
   * left from there up, it falls back to the easiest remaining puzzles. Later
   * pages follow the cursor either way, so paging stays gap-free.
   * Returns limit + 1 rows at most (the extra one means there's a next page).
   */
  async findPage(q: PuzzleQuery): Promise<PuzzleRow[]> {
    if (q.mode === "rated" && !q.cursor) {
      const { rows } = await this.fastify.pg.query<{ puzzleRating: number }>(
        `SELECT "puzzleRating" FROM users WHERE id = $1`,
        [q.userId]
      );
      const start = { rating: (rows[0]?.puzzleRating ?? 1500) - RATED_START_BELOW, id: "" };
      const near = await this.query({ ...q, cursor: start });
      if (near.length > 0) return near;
    }
    return this.query(q);
  }

  private async query(q: PuzzleQuery): Promise<PuzzleRow[]> {
    const values: unknown[] = [q.userId];
    const where: string[] = [
      `NOT EXISTS (SELECT 1 FROM solved_puzzles s WHERE s."userId" = $1 AND s."puzzleId" = p.id)`,
      q.mode === "rated" ? RATED_POOL_SQL("p") : `NOT (${RATED_POOL_SQL("p")})`,
    ];
    if (q.mode === "rated") {
      where.push(
        `NOT EXISTS (SELECT 1 FROM puzzle_attempts a WHERE a."userId" = $1 AND a."puzzleId" = p.id)`
      );
    }
    if (q.cursor) {
      values.push(q.cursor.rating, q.cursor.id);
      where.push(`(p.rating, p.id) > ($${values.length - 1}::int, $${values.length}::text)`);
    }
    if (q.theme) {
      values.push(q.theme);
      // @> so the GIN index on themes can be used
      where.push(`p.themes @> ARRAY[$${values.length}::text]`);
    }
    values.push(q.limit + 1);
    const { rows } = await this.fastify.pg.query<PuzzleRow>(
      `SELECT p.id, p.fen, p.moves, p.rating, p.themes FROM puzzles p
       WHERE ${where.join(" AND ")}
       ORDER BY p.rating, p.id LIMIT $${values.length}`,
      values
    );
    return rows;
  }

  /**
   * Checks the moves the user has played so far on a rated puzzle (UCI,
   * their own moves only, in order) against the solution, which the client
   * never sees until the puzzle is over. Returns the opponent's reply to
   * continue, or the outcome with the full solution; the outcome is recorded
   * as the rated attempt (see attempt()), so the rating never depends on
   * what the client claims.
   *
   * Any checkmate is accepted, like on Lichess. A promotion on the right
   * squares counts as the solution's promotion (the board promotes to a queen
   * by default; the line returned says which piece it really was).
   */
  async check(userId: number, puzzleId: string, userMoves: string[]): Promise<CheckResult> {
    const puzzle = await this.ratedPuzzle(puzzleId);
    const line = puzzle.moves.split(" ");
    const chess = new Chess(puzzle.fen);
    const known: string[] = [];

    for (let i = 0; i < userMoves.length; i++) {
      const expected = line[2 * i];
      if (!expected) throw new AppError("The puzzle is already over", "PUZZLE_OVER", 400);
      const sent = userMoves[i]!;
      const move = sent.slice(0, 4) === expected.slice(0, 4) && expected.length === 5 ? expected : sent;
      if (!play(chess, move)) throw new AppError("Illegal move", "ILLEGAL_MOVE", 400);
      known.push(move);

      const correct = move === expected || chess.isCheckmate();
      if (!correct) return this.finish(userId, puzzleId, line, false);
      if (chess.isCheckmate() || 2 * i + 1 >= line.length) return this.finish(userId, puzzleId, line, true);

      const reply = line[2 * i + 1]!;
      play(chess, reply);
      known.push(reply);
    }
    return { result: "continue", line: known };
  }

  /**
   * The solution of a rated puzzle, for a hint or "show solution". Before
   * the puzzle is over this counts as a miss, as a hinted solve always has.
   */
  async reveal(userId: number, puzzleId: string): Promise<CheckResult> {
    const puzzle = await this.ratedPuzzle(puzzleId);
    return this.finish(userId, puzzleId, puzzle.moves.split(" "), false);
  }

  private async ratedPuzzle(puzzleId: string): Promise<{ fen: string; moves: string }> {
    if (!isRatedPool(puzzleId)) throw new AppError("Puzzle not found", "PUZZLE_NOT_FOUND", 404);
    const { rows } = await this.fastify.pg.query<{ fen: string; moves: string }>(
      `SELECT fen, moves FROM puzzles WHERE id = $1`,
      [puzzleId]
    );
    if (!rows[0]) throw new AppError("Puzzle not found", "PUZZLE_NOT_FOUND", 404);
    return rows[0];
  }

  private async finish(userId: number, puzzleId: string, line: string[], success: boolean): Promise<CheckResult> {
    const attempt = await this.attempt(userId, puzzleId, success);
    return { result: success ? "solved" : "failed", line, attempt };
  }

  /**
   * Records an attempt. The user's first attempt at a puzzle is rated: Elo
   * against the puzzle rating, stored in puzzle_attempts. Later attempts are
   * unrated. A successful attempt (rated or not) also marks the puzzle solved.
   *
   * The user row is locked for the whole transaction, so concurrent attempts
   * by the same user run one after another and each sees the rating the
   * previous one wrote; the (userId, puzzleId) primary key makes a duplicate
   * submit unrated instead of counting twice.
   */
  private async attempt(userId: number, puzzleId: string, success: boolean): Promise<AttemptResult> {
    const result = await this.fastify.pg.transact(async (tx) => {
      const { rows: puzzles } = await tx.query<{ rating: number }>(
        `SELECT rating FROM puzzles WHERE id = $1`,
        [puzzleId]
      );
      const puzzle = puzzles[0];
      if (!puzzle) throw new AppError("Puzzle not found", "PUZZLE_NOT_FOUND", 404);

      const { rows: users } = await tx.query<{
        puzzleRating: number;
        highestPuzzleRating: number;
        puzzleAttempts: number;
      }>(
        `SELECT "puzzleRating", "highestPuzzleRating", "puzzleAttempts"
         FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );
      const user = users[0];
      if (!user) throw new AppError("User not found", "USER_NOT_FOUND", 404);

      if (success) {
        await tx.query(
          `INSERT INTO solved_puzzles ("userId", "puzzleId") VALUES ($1, $2)
           ON CONFLICT ("userId", "puzzleId") DO NOTHING`,
          [userId, puzzleId]
        );
      }

      const { newRating, ratingChange } = calculatePuzzleRating(
        user.puzzleRating,
        puzzle.rating,
        success,
        user.puzzleAttempts
      );
      const inserted = await tx.query(
        `INSERT INTO puzzle_attempts ("userId", "puzzleId", success, "ratingBefore", "ratingChange")
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("userId", "puzzleId") DO NOTHING`,
        [userId, puzzleId, success, user.puzzleRating, ratingChange]
      );
      if (inserted.rowCount === 0) {
        return {
          rated: false,
          puzzleRating: user.puzzleRating,
          highestPuzzleRating: Math.max(user.highestPuzzleRating, user.puzzleRating),
          ratingChange: 0,
        };
      }

      const { rows: updated } = await tx.query<{ puzzleRating: number; highestPuzzleRating: number }>(
        `UPDATE users SET "puzzleRating" = $2,
           "highestPuzzleRating" = GREATEST("highestPuzzleRating", "puzzleRating", $2),
           "puzzleAttempts" = "puzzleAttempts" + 1
         WHERE id = $1
         RETURNING "puzzleRating", "highestPuzzleRating"`,
        [userId, newRating]
      );
      return { rated: true, ...updated[0]!, ratingChange };
    });

    // Profile stats show the puzzle rating (cached apart from the game stats)
    if (result.rated) {
      await invalidatePuzzleStats(this.fastify.redis, userId).catch((err) =>
        this.fastify.log.warn({ err }, "Failed to clear puzzle stats cache")
      );
    }
    return result;
  }

  /**
   * Every theme with its puzzle count, most common first. Counted when
   * puzzles are imported (puzzle_theme_counts, migration 031), not here:
   * counting means reading every puzzle. Cached in Redis.
   */
  async themes(): Promise<ThemeCount[]> {
    return cachedValue(
      this.fastify.redis,
      this.fastify.log,
      THEMES_CACHE_KEY,
      THEMES_CACHE_SECONDS,
      async () => {
        const { rows } = await this.fastify.pg.query<ThemeCount>(
          `SELECT theme, count FROM puzzle_theme_counts ORDER BY count DESC, theme`
        );
        return rows;
      },
      { staleSeconds: THEMES_STALE_SECONDS }
    );
  }
}
