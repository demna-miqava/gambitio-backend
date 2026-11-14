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
    return { data: await settingsService.updateSettings(request.user!.id, updates) };
  });
}
