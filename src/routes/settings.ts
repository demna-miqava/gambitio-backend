import type { FastifyInstance } from "fastify";
import { SettingsService } from "../services/settingsService.js";
import { authMiddleware } from "../middleware/auth.js";
import { updateSettingsSchema } from "../schemas/settingsSchemas.js";

export async function settingsRoutes(fastify: FastifyInstance) {
  const settingsService = new SettingsService(fastify);

  fastify.get("/settings", { preHandler: authMiddleware }, async (request) => {
    return { data: await settingsService.getSettings(request.user!.id) };
  });

  fastify.patch("/settings", { preHandler: authMiddleware }, async (request) => {
    const updates = updateSettingsSchema.parse(request.body);
    const data = await settingsService.updateSettings(request.user!.id, updates);
    // Their opponent in a game under way learns that chat went off (or on)
    if (updates.gameChatAllowedFrom !== undefined) {
      await fastify.gameChat
        .announceStatus(request.user!.id)
        .catch((err) => request.log.error({ err }, "Announcing the chat setting failed"));
    }
    return { data };
  });
}
