import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { MAX_START_MOVES } from "../game/studyState.js";

const roomParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const memberParams = roomParams.extend({ userId: z.coerce.number().int().positive().max(2_147_483_647) });
const name = z.string().trim().min(1).max(80);

const createRoomSchema = z
  .object({
    name,
    // Start from a position (FEN) and/or a line of moves (SAN), e.g. a game
    fen: z.string().max(100).optional(),
    moves: z.array(z.string().min(2).max(10)).max(MAX_START_MOVES).optional(),
    // Or watch a live game (Watch together): the room follows its moves
    gameId: z.number().int().positive().max(2_147_483_647).optional(),
  })
  .strict()
  .refine((body) => body.gameId === undefined || (body.fen === undefined && body.moves === undefined), {
    message: "A room watching a game starts from the game's moves",
  });

export async function studyRoutes(fastify: FastifyInstance) {
  const { study } = fastify;

  /** GET /study - Rooms the signed-in player is in, recently changed first */
  fastify.get("/study", { preHandler: authMiddleware }, async (request) => {
    return { rooms: await study.list(request.user!.id) };
  });

  /** POST /study - Create a room (the creator owns it), or one watching a live game ({ gameId }) */
  fastify.post(
    "/study",
    { preHandler: authMiddleware, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = createRoomSchema.parse(request.body);
      return reply.status(201).send({ room: await study.create(request.user!.id, body) });
    }
  );

  /** GET /study/:id - Room, analysis and members (members only) */
  fastify.get("/study/:id", { preHandler: authMiddleware }, async (request) => {
    const { id } = roomParams.parse(request.params);
    return study.get(id, request.user!.id);
  });

  /** PATCH /study/:id - Rename (owner) */
  fastify.patch("/study/:id", { preHandler: authMiddleware }, async (request) => {
    const { id } = roomParams.parse(request.params);
    const body = z.object({ name }).strict().parse(request.body);
    return { room: await study.rename(id, request.user!.id, body.name) };
  });

  /** DELETE /study/:id - Delete (owner) */
  fastify.delete("/study/:id", { preHandler: authMiddleware }, async (request, reply) => {
    const { id } = roomParams.parse(request.params);
    await study.remove(id, request.user!.id);
    return reply.status(204).send();
  });

  /** POST /study/:id/members - Invite a friend ({ userId }) */
  fastify.post(
    "/study/:id/members",
    { preHandler: authMiddleware, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = roomParams.parse(request.params);
      const { userId } = z.object({ userId: z.number().int().positive().max(2_147_483_647) }).strict().parse(request.body);
      const members = await study.invite(id, request.user!, userId);
      return reply.status(201).send({ members });
    }
  );

  /** DELETE /study/:id/members/:userId - Leave, or (owner) remove someone */
  fastify.delete("/study/:id/members/:userId", { preHandler: authMiddleware }, async (request, reply) => {
    const { id, userId } = memberParams.parse(request.params);
    await study.removeMember(id, request.user!.id, userId);
    return reply.status(204).send();
  });
}
