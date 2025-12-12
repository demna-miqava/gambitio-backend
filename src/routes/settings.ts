import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SettingsService } from "../services/settingsService.js";
import { authMiddleware } from "../middleware/auth.js";
import { updateSettingsSchema } from "../schemas/settingsSchemas.js";

export async function settingsRoutes(fastify: FastifyInstance) {
  const settingsService = new SettingsService(fastify);

  fastify.get(
    "/settings",
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!request.user) {
          return reply.status(401).send({ error: "Not authenticated" });
        }

        const settings = await settingsService.getSettings(request.user.id);
        return reply.status(200).send({ data: settings });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );

  fastify.patch(
    "/settings",
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!request.user) {
          return reply.status(401).send({ error: "Not authenticated" });
        }

        const validation = updateSettingsSchema.safeParse(request.body);
        if (!validation.success) {
          return reply.status(400).send({
            error: "Validation failed",
            details: validation.error.issues,
          });
        }

        const updatedSettings = await settingsService.updateSettings(
          request.user.id,
          validation.data
        );

        return reply.status(200).send({ data: updatedSettings });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );
}
