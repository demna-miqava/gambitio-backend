import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";

/**
 * Coordinates trainer (migration 043). The drill runs in the browser: a
 * square name appears and the player clicks it, as many as they can before
 * the clock runs out. The server can't see the clicks, so a score is the
 * player's own claim: it is kept as their personal record (best per run
 * length and side of the board, plus their latest runs) and never ranked
 * against anyone else's. Scores nobody could reach in the time are refused.
 */

export const COORDINATE_SECONDS = [30, 60, 120] as const;

/**
 * Correct squares per second no one sustains: the fastest players manage
 * around one and a half. Anything above this over a run is made up.
 */
export const MAX_CORRECT_PER_SECOND = 3;
/** Clicks per second (right and wrong together) above which a run is made up */
export const MAX_CLICKS_PER_SECOND = 6;
/** Latest runs kept per account, to show progress */
export const RECENT_RUNS_KEPT = 20;

const runSchema = z
  .object({
    mode: z.literal("find").default("find"),
    seconds: z.union([z.literal(30), z.literal(60), z.literal(120)]),
    perspective: z.enum(["white", "black"]),
    withPieces: z.boolean(),
    score: z.number().int().min(0),
    misses: z.number().int().min(0),
  })
  .strict()
  .refine((run) => run.score <= run.seconds * MAX_CORRECT_PER_SECOND, {
    message: "Score is higher than anyone could reach in the time",
    path: ["score"],
  })
  .refine((run) => run.score + run.misses <= run.seconds * MAX_CLICKS_PER_SECOND, {
    message: "More clicks than anyone could make in the time",
    path: ["misses"],
  });

interface BestRow {
  mode: string;
  seconds: number;
  perspective: string;
  best: number;
  achievedAt: Date;
}

interface RunRow {
  id: string;
  mode: string;
  seconds: number;
  perspective: string;
  withPieces: boolean;
  score: number;
  misses: number;
  createdAt: Date;
}

const RUN_COLUMNS = `id, mode, seconds, perspective, "withPieces", score, misses, "createdAt"`;
const BEST_COLUMNS = `mode, seconds, perspective, best, "achievedAt"`;

export async function coordinateRoutes(fastify: FastifyInstance) {
  /** GET /coordinates/scores - The signed-in player's bests and latest runs */
  fastify.get("/coordinates/scores", { preHandler: authMiddleware }, async (request) => {
    const userId = request.user!.id;
    const [bests, recent] = await Promise.all([
      fastify.pg.query<BestRow>(
        `SELECT ${BEST_COLUMNS} FROM coordinate_bests WHERE "userId" = $1`,
        [userId]
      ),
      fastify.pg.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM coordinate_runs WHERE "userId" = $1 ORDER BY id DESC LIMIT $2`,
        [userId, RECENT_RUNS_KEPT]
      ),
    ]);
    return { bests: bests.rows, recent: recent.rows };
  });

  /**
   * POST /coordinates/runs - Record a finished run. Answers with the run,
   * the best for its run length and side afterwards, and the best before it
   * (null for the first run), so the page can call out a new best.
   */
  fastify.post(
    "/coordinates/runs",
    // A run lasts at least 30 seconds
    { preHandler: authMiddleware, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const userId = request.user!.id;
      const run = runSchema.parse(request.body);
      return fastify.pg.transact(async (tx) => {
        const { rows: before } = await tx.query<{ best: number }>(
          `SELECT best FROM coordinate_bests
           WHERE "userId" = $1 AND mode = $2 AND seconds = $3 AND perspective = $4
           FOR UPDATE`,
          [userId, run.mode, run.seconds, run.perspective]
        );
        const previousBest = before[0]?.best ?? null;
        const { rows: inserted } = await tx.query<RunRow>(
          `INSERT INTO coordinate_runs ("userId", mode, seconds, perspective, "withPieces", score, misses)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${RUN_COLUMNS}`,
          [userId, run.mode, run.seconds, run.perspective, run.withPieces, run.score, run.misses]
        );
        // Keep only the latest runs
        await tx.query(
          `DELETE FROM coordinate_runs WHERE "userId" = $1 AND id < (
             SELECT id FROM coordinate_runs WHERE "userId" = $1 ORDER BY id DESC OFFSET $2 LIMIT 1
           )`,
          [userId, RECENT_RUNS_KEPT - 1]
        );
        const { rows: best } = await tx.query<BestRow>(
          `INSERT INTO coordinate_bests ("userId", mode, seconds, perspective, best)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT ("userId", mode, seconds, perspective) DO UPDATE SET
             best = GREATEST(coordinate_bests.best, EXCLUDED.best),
             "achievedAt" = CASE WHEN EXCLUDED.best > coordinate_bests.best
               THEN now() ELSE coordinate_bests."achievedAt" END
           RETURNING ${BEST_COLUMNS}`,
          [userId, run.mode, run.seconds, run.perspective, run.score]
        );
        return { run: inserted[0], best: best[0], previousBest };
      });
    }
  );
}
