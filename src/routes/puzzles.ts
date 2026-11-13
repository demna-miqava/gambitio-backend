import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { PuzzleService } from "../services/puzzleService.js";

/** Keyset cursor "<rating>:<id>" of the last puzzle on the previous page. */
const cursorSchema = z
  .string()
  .regex(/^\d+:[A-Za-z0-9_-]+$/)
  .transform((c) => {
    const i = c.indexOf(":");
    return { rating: Number(c.slice(0, i)), id: c.slice(i + 1) };
  });

const puzzlesQuery = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(5),
  /** Lichess theme key, e.g. "fork" or "mateIn2" */
  theme: z.string().regex(/^[A-Za-z0-9]{1,40}$/).optional(),
  /**
   * ascending: easiest first (Rush / Survival).
   * rated: Infinite mode, starts near the user's puzzle rating and skips
   * puzzles already attempted.
   */
  mode: z.enum(["ascending", "rated"]).default("ascending"),
});

const solveParams = z.object({ id: z.string().min(1).max(32) });
const attemptBody = z.object({ success: z.boolean() });

export async function puzzleRoutes(fastify: FastifyInstance) {
  const puzzleService = new PuzzleService(fastify);

  /**
   * GET /api/puzzles?cursor=<rating>:<id>&limit=5&theme=fork&mode=ascending|rated
   * Puzzles the user hasn't solved, ordered by rating. Keyset pagination, so
   * puzzles dropping out as they're solved can't shift later pages.
   * nextCursor is null when there are no more.
   */
  fastify.get("/puzzles", { preHandler: authMiddleware }, async (request) => {
    const { cursor, limit, theme, mode } = puzzlesQuery.parse(request.query);
    const rows = await puzzleService.findPage({ userId: request.user!.id, cursor, limit, theme, mode });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map((p) => ({
        id: p.id,
        fen: p.fen,
        moves: p.moves.split(" "),
        rating: p.rating,
        themes: p.themes ?? [],
      })),
      nextCursor: rows.length > limit && last ? `${last.rating}:${last.id}` : null,
    };
  });

  /**
   * GET /api/puzzles/themes
   * All puzzle themes with their puzzle counts, most common first.
   */
  fastify.get("/puzzles/themes", { preHandler: authMiddleware }, async () => {
    return { data: await puzzleService.themes() };
  });

  /**
   * POST /api/puzzles/:id/attempt { success }
   * Rated mode (Infinite). The first attempt at a puzzle changes the user's
   * puzzle rating; repeats are unrated. Success also marks it solved.
   * Returns { rated, puzzleRating, highestPuzzleRating, ratingChange }.
   */
  fastify.post("/puzzles/:id/attempt", { preHandler: authMiddleware }, async (request) => {
    const { id } = solveParams.parse(request.params);
    const { success } = attemptBody.parse(request.body);
    return puzzleService.attempt(request.user!.id, id, success);
  });

  /**
   * POST /api/puzzles/:id/solve
   * Unrated modes (Rush / Survival): marks a puzzle solved for the user so it
   * isn't served again. Idempotent.
   */
  fastify.post("/puzzles/:id/solve", { preHandler: authMiddleware }, async (request, reply) => {
    const { id } = solveParams.parse(request.params);
    const { rowCount } = await fastify.pg.query(
      `INSERT INTO solved_puzzles ("userId", "puzzleId")
       SELECT $1, id FROM puzzles WHERE id = $2
       ON CONFLICT ("userId", "puzzleId") DO NOTHING`,
      [request.user!.id, id]
    );
    if (rowCount === 0) {
      const exists = await fastify.pg.query("SELECT 1 FROM puzzles WHERE id = $1", [id]);
      if (exists.rowCount === 0) return reply.status(404).send({ error: "Puzzle not found" });
    }
    return reply.status(204).send();
  });
}
