import type { FastifyInstance } from "fastify";
import { AppError } from "../errors/AppError.js";
import { calculatePuzzleRating } from "../utils/puzzleRating.js";
import { statsCacheKey } from "./statsService.js";

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

export interface ThemeCount {
  theme: string;
  count: number;
}

/**
 * Rated mode starts this far below the user's puzzle rating, so a session
 * opens at about their level (expected score ~0.57) and climbs from there.
 */
const RATED_START_BELOW = 50;
const THEMES_CACHE_KEY = "puzzles:themes";
/** Themes only change when puzzles are imported. */
const THEMES_CACHE_SECONDS = 6 * 60 * 60;

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
   * Records an attempt. The user's first attempt at a puzzle is rated: Elo
   * against the puzzle rating, stored in puzzle_attempts. Later attempts are
   * unrated. A successful attempt (rated or not) also marks the puzzle solved.
   *
   * The user row is locked for the whole transaction, so concurrent attempts
   * by the same user run one after another and each sees the rating the
   * previous one wrote; the (userId, puzzleId) primary key makes a duplicate
   * submit unrated instead of counting twice.
   */
  async attempt(userId: number, puzzleId: string, success: boolean): Promise<AttemptResult> {
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

    // Profile stats show the puzzle rating
    if (result.rated) await this.fastify.redis.del(statsCacheKey(userId));
    return result;
  }

  /** Every theme with its puzzle count, most common first. Cached in Redis. */
  async themes(): Promise<ThemeCount[]> {
    const hit = await this.fastify.redis.get(THEMES_CACHE_KEY);
    if (hit) return JSON.parse(hit) as ThemeCount[];
    const { rows } = await this.fastify.pg.query<ThemeCount>(
      `SELECT t AS theme, COUNT(*)::int AS count
       FROM puzzles, unnest(themes) AS t
       GROUP BY t ORDER BY count DESC, theme`
    );
    await this.fastify.redis.set(THEMES_CACHE_KEY, JSON.stringify(rows), {
      EX: THEMES_CACHE_SECONDS,
    });
    return rows;
  }
}
