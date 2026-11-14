import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { AppError } from "../errors/AppError.js";

/**
 * Endgame practice lab progress. The exercises are played in the browser
 * against the engine, so the server only keeps score: attempts, when an
 * exercise was first completed, and the fewest moves it took.
 */
const exerciseParams = z.object({ exerciseId: z.string().regex(/^[a-z0-9-]{1,60}$/) });
const attemptSchema = z
  .object({
    success: z.boolean(),
    // The player's own moves in this attempt
    moves: z.number().int().min(0).max(500),
  })
  .strict();

/** Exercises one player may have progress on (ids are free-form slugs) */
const MAX_EXERCISES_PER_USER = 500;

interface ProgressRow {
  exerciseId: string;
  attempts: number;
  completedAt: Date | null;
  bestMoves: number | null;
}

export async function endgameRoutes(fastify: FastifyInstance) {
  /** GET /endgames/progress - The signed-in player's progress on every exercise they tried */
  fastify.get("/endgames/progress", { preHandler: authMiddleware }, async (request) => {
    const { rows } = await fastify.pg.query<ProgressRow>(
      `SELECT "exerciseId", attempts, "completedAt", "bestMoves" FROM endgame_progress WHERE "userId" = $1`,
      [request.user!.id]
    );
    return { progress: rows };
  });

  /** POST /endgames/:exerciseId/attempts - Record a finished attempt */
  fastify.post(
    "/endgames/:exerciseId/attempts",
    { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const { exerciseId } = exerciseParams.parse(request.params);
      const { success, moves } = attemptSchema.parse(request.body);
      const { rows } = await fastify.pg.query<ProgressRow>(
        `INSERT INTO endgame_progress ("userId", "exerciseId", attempts, "completedAt", "bestMoves")
         SELECT $1::int, $2::varchar, 1, CASE WHEN $3::boolean THEN now() END, CASE WHEN $3::boolean THEN $4::smallint END
         WHERE EXISTS (SELECT 1 FROM endgame_progress WHERE "userId" = $1 AND "exerciseId" = $2)
           OR (SELECT COUNT(*) FROM endgame_progress WHERE "userId" = $1) < $5
         ON CONFLICT ("userId", "exerciseId") DO UPDATE SET
           attempts = endgame_progress.attempts + 1,
           "completedAt" = COALESCE(endgame_progress."completedAt", EXCLUDED."completedAt"),
           "bestMoves" = CASE
             WHEN NOT $3 THEN endgame_progress."bestMoves"
             ELSE LEAST(COALESCE(endgame_progress."bestMoves", $4::smallint), $4::smallint)
           END,
           "updatedAt" = now()
         RETURNING "exerciseId", attempts, "completedAt", "bestMoves"`,
        [request.user!.id, exerciseId, success, moves, MAX_EXERCISES_PER_USER]
      );
      if (!rows[0]) {
        throw new AppError("Too many endgame exercises recorded", "TOO_MANY_EXERCISES", 409);
      }
      return { progress: rows[0] };
    }
  );
}
