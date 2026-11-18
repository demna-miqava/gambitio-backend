import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import {
  createTournamentSchema,
  listTournamentsQuery,
  standingsQuery,
} from "../schemas/tournamentSchemas.js";

const idParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });
/** Creating is rare; joining and leaving are a click each */
const createLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };
const actionLimit = { rateLimit: { max: 30, timeWindow: "1 minute" } };

/** Arena tournaments (see TOURNAMENTS.md and TournamentService). All signed in. */
export async function tournamentRoutes(fastify: FastifyInstance) {
  const { tournaments } = fastify;

  // GET /tournaments?status=open|finished - What is on and coming up, or what has been played
  fastify.get("/tournaments", { preHandler: authMiddleware }, async (request) => {
    const { status, page, limit } = listTournamentsQuery.parse(request.query);
    return tournaments.list(status, request.user!.id, page, limit);
  });

  // POST /tournaments - Create one; the creator is its first player
  fastify.post("/tournaments", { preHandler: authMiddleware, config: createLimit }, async (request, reply) => {
    const body = createTournamentSchema.parse(request.body);
    const state = await tournaments.create(request.user!.id, body);
    return reply.status(201).send(state);
  });

  // GET /tournaments/:id - The lobby: the tournament, the top of the
  // standings, the games being played, the caller's own line
  fastify.get("/tournaments/:id", { preHandler: authMiddleware }, async (request) => {
    const { id } = idParams.parse(request.params);
    return tournaments.getState(id, request.user!.id);
  });

  // GET /tournaments/:id/me - The caller's own line and game in progress,
  // for a player further down than the lines the lobby socket sends
  fastify.get("/tournaments/:id/me", { preHandler: authMiddleware }, async (request) => {
    const { id } = idParams.parse(request.params);
    return tournaments.getMine(id, request.user!.id);
  });

  // GET /tournaments/:id/standings - The standings, paged
  fastify.get("/tournaments/:id/standings", { preHandler: authMiddleware }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { page, limit } = standingsQuery.parse(request.query);
    return tournaments.standingsPage(id, page, limit);
  });

  // POST /tournaments/:id/join - Join, or come back after a pause or after leaving
  fastify.post("/tournaments/:id/join", { preHandler: authMiddleware, config: actionLimit }, async (request) => {
    const { id } = idParams.parse(request.params);
    return { me: await tournaments.join(id, request.user!.id) };
  });

  // POST /tournaments/:id/pause - Stop being paired, keeping the place in the standings
  fastify.post("/tournaments/:id/pause", { preHandler: authMiddleware, config: actionLimit }, async (request) => {
    const { id } = idParams.parse(request.params);
    return { me: await tournaments.pause(id, request.user!.id) };
  });

  // POST /tournaments/:id/withdraw - Leave
  fastify.post(
    "/tournaments/:id/withdraw",
    { preHandler: authMiddleware, config: actionLimit },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await tournaments.withdraw(id, request.user!.id);
      return reply.status(204).send();
    }
  );

  // DELETE /tournaments/:id - Call it off (its creator, before it starts)
  fastify.delete("/tournaments/:id", { preHandler: authMiddleware, config: actionLimit }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await tournaments.cancel(id, request.user!.id);
    return reply.status(204).send();
  });
}
