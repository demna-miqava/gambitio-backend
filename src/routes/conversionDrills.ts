import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { ConversionDrillService } from "../services/conversionDrillService.js";
import { CONVERSION_MAX_CP, CONVERSION_MAX_MATE } from "../game/conversion.js";

const id = z.coerce.number().int().positive().max(2_147_483_647);
const drillParams = z.object({ id });
const candidatesQuery = z.object({ limit: z.coerce.number().int().min(1).max(20).default(10) });
const scanSchema = z
  .object({
    gameId: id,
    // The position the browser picked, or null when the game had none
    drill: z
      .object({
        ply: z.number().int().min(0).max(2000),
        eval: z.union([
          z.object({ cp: z.number().int().min(-CONVERSION_MAX_CP).max(CONVERSION_MAX_CP) }).strict(),
          z.object({ mate: z.number().int().min(-CONVERSION_MAX_MATE).max(CONVERSION_MAX_MATE) }).strict(),
        ]),
      })
      .strict()
      .nullable(),
  })
  .strict();
const attemptSchema = z
  .object({
    success: z.boolean(),
    // The player's own moves in this attempt
    moves: z.number().int().min(0).max(500),
  })
  .strict();

/**
 * Conversion drills (src/game/conversion.ts, migration 037): positions from
 * the player's own games where they were clearly winning and didn't win.
 */
export async function conversionDrillRoutes(fastify: FastifyInstance) {
  const drills = new ConversionDrillService(fastify.pg);

  /** GET /conversion-drills - The signed-in player's drills, due first */
  fastify.get("/conversion-drills", { preHandler: authMiddleware }, async (request) => ({
    drills: await drills.list(request.user!.id),
  }));

  /** GET /conversion-drills/candidates - Recent games the browser still has to scan, with their moves */
  fastify.get(
    "/conversion-drills/candidates",
    { preHandler: authMiddleware, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { limit } = candidatesQuery.parse(request.query);
      return { games: await drills.candidates(request.user!.id, limit) };
    }
  );

  /** POST /conversion-drills/scans - A scanned game, and the drill found in it (if any) */
  fastify.post(
    "/conversion-drills/scans",
    { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const { gameId, drill } = scanSchema.parse(request.body);
      return { drill: await drills.recordScan(request.user!.id, gameId, drill) };
    }
  );

  /** GET /conversion-drills/:id */
  fastify.get("/conversion-drills/:id", { preHandler: authMiddleware }, async (request) => {
    const { id: drillId } = drillParams.parse(request.params);
    return { drill: await drills.get(request.user!.id, drillId) };
  });

  /** POST /conversion-drills/:id/attempts - A finished attempt; schedules the next review */
  fastify.post(
    "/conversion-drills/:id/attempts",
    { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const { id: drillId } = drillParams.parse(request.params);
      const attempt = attemptSchema.parse(request.body);
      return { drill: await drills.recordAttempt(request.user!.id, drillId, attempt) };
    }
  );

  /** DELETE /conversion-drills/:id - Drop a drill */
  fastify.delete("/conversion-drills/:id", { preHandler: authMiddleware }, async (request, reply) => {
    const { id: drillId } = drillParams.parse(request.params);
    await drills.remove(request.user!.id, drillId);
    return reply.status(204).send();
  });
}
