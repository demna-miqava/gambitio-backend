import type { FastifyInstance } from "fastify";
import { authMiddleware } from "../middleware/auth.js";
import { OPENINGS, toOpeningResponse } from "../game/openings.js";

/** The list only changes with a deploy */
const openingList = { openings: OPENINGS.map(toOpeningResponse) };

export async function openingRoutes(fastify: FastifyInstance) {
  /** GET /openings - The openings a friend challenge (or mirror match) can start from */
  fastify.get("/openings", { preHandler: authMiddleware }, async (_request, reply) => {
    reply.header("cache-control", "private, max-age=3600");
    return openingList;
  });
}
