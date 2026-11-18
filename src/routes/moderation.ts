import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { REPORT_DETAILS_MAX_LENGTH, REPORT_REASONS } from "../services/moderationService.js";

// Capped at Postgres' integer max: a larger id would be a 500, not a 404
const id = z.coerce.number().int().positive().max(2_147_483_647);
const userIdParams = z.object({ userId: id });
const reportSchema = z.object({
  reportedId: id,
  reason: z.enum(REPORT_REASONS),
  details: z.string().max(REPORT_DETAILS_MAX_LENGTH).optional(),
  /** The game it happened in; both players must have played in it */
  gameId: id.optional(),
});

/** Blocking and reporting can't be used to probe or flood: a few a minute is plenty */
const limited = { rateLimit: { max: 30, timeWindow: "1 minute" } };

export async function moderationRoutes(fastify: FastifyInstance) {
  /** GET /api/blocks - The players the signed-in user has blocked */
  fastify.get("/blocks", { preHandler: authMiddleware }, async (request) => {
    return { data: await fastify.moderation.listBlocked(request.user!.id) };
  });

  /** PUT /api/blocks/:userId - Block a player (no-op if already blocked) */
  fastify.put("/blocks/:userId", { preHandler: authMiddleware, config: limited }, async (request, reply) => {
    const { userId } = userIdParams.parse(request.params);
    await fastify.moderation.block(request.user!.id, userId);
    return reply.status(204).send();
  });

  /** DELETE /api/blocks/:userId - Unblock a player (no-op if not blocked) */
  fastify.delete("/blocks/:userId", { preHandler: authMiddleware, config: limited }, async (request, reply) => {
    const { userId } = userIdParams.parse(request.params);
    await fastify.moderation.unblock(request.user!.id, userId);
    return reply.status(204).send();
  });

  /** POST /api/reports - Report a player to the moderators */
  fastify.post("/reports", { preHandler: authMiddleware, config: limited }, async (request, reply) => {
    const input = reportSchema.parse(request.body);
    const report = await fastify.moderation.report(request.user!.id, input);
    return reply.status(201).send({ data: report });
  });
}
