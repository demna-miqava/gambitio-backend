import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { PuzzleService } from "../services/puzzleService.js";

/** Keyset cursor "<rating>:<id>" of the last puzzle on the previous page. */
const cursorSchema = z
  .string()
  // Rating fits the integer column (a longer one was a 500)
  .regex(/^\d{1,9}:[A-Za-z0-9_-]+$/)
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
   * ascending: easiest first (Rush / Survival), solutions included.
   * rated: Infinite mode, starts near the user's puzzle rating, skips
   * puzzles already attempted, and sends no solutions. The two modes serve
   * disjoint halves of the puzzles (see RATED_POOL_SQL).
   */
  mode: z.enum(["ascending", "rated"]).default("ascending"),
});

const solveParams = z.object({ id: z.string().min(1).max(32) });
const uci = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
const checkBody = z.object({ moves: z.array(uci).min(1).max(30) });

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
        // Rated puzzles are checked move by move (POST /puzzles/:id/check);
        // their solution is only sent once the puzzle is over
        moves: mode === "rated" ? [] : p.moves.split(" "),
        ...(mode === "rated" && { hidden: true }),
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
   * POST /api/puzzles/:id/check { moves: ["e2e4", ...] }
   * Rated mode (Infinite). The user's moves so far; the server answers with
   * the reply to play ({ result: "continue", line }) or the outcome with the
   * full solution and the rating change ({ result: "solved" | "failed",
   * line, attempt }). Only the first outcome on a puzzle is rated.
   */
  fastify.post(
    "/puzzles/:id/check",
    { preHandler: authMiddleware, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = solveParams.parse(request.params);
      const { moves } = checkBody.parse(request.body);
      return puzzleService.check(request.user!.id, id, moves);
    }
  );

  /**
   * POST /api/puzzles/:id/reveal
   * Rated mode: the solution, for a hint or "show solution". Counts as a miss
   * if the puzzle wasn't over yet.
   */
  fastify.post(
    "/puzzles/:id/reveal",
    { preHandler: authMiddleware, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = solveParams.parse(request.params);
      return puzzleService.reveal(request.user!.id, id);
    }
  );

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
