import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";

// Capped at Postgres' integer max: a larger id would be a 500, not a 404
const id = z.coerce.number().int().positive().max(2_147_483_647);
const idParams = z.object({ id });
const inviteSchema = z
  .object({
    recipientId: id,
    /** A rematch: the finished duel between the two it follows */
    rematchOf: id.optional(),
  })
  .strict();
const moveSchema = z
  .object({
    /** The puzzle the player is on (its place in the duel), so a stale move isn't played in the next */
    index: z.number().int().min(0).max(1000),
    move: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/),
  })
  .strict();

/** Inviting and answering: a few a minute is plenty */
const limited = { rateLimit: { max: 30, timeWindow: "1 minute" } };
/** Moves come fast in a three-minute race (and state reads on reconnect) */
const playing = { rateLimit: { max: 240, timeWindow: "1 minute" } };

/**
 * Puzzle duels (PuzzleDuelService). Invites, answers and moves are plain
 * requests; updates (an invite, the other player's score, the end) arrive
 * on the notifications socket.
 */
export async function puzzleDuelRoutes(fastify: FastifyInstance) {
  const { puzzleDuels } = fastify;

  /** POST /puzzle-duels/invites - Invite a friend */
  fastify.post("/puzzle-duels/invites", { preHandler: authMiddleware, config: limited }, async (request, reply) => {
    const { recipientId, rematchOf } = inviteSchema.parse(request.body);
    return reply.status(201).send({ data: await puzzleDuels.invite(request.user!.id, recipientId, rematchOf) });
  });

  /** GET /puzzle-duels/invites - Waiting invites, to and from the player */
  fastify.get("/puzzle-duels/invites", { preHandler: authMiddleware }, async (request) => ({
    data: await puzzleDuels.invites(request.user!.id),
  }));

  /** POST /puzzle-duels/invites/:id/accept - Start the duel */
  fastify.post("/puzzle-duels/invites/:id/accept", { preHandler: authMiddleware, config: limited }, async (request) => {
    const { id: inviteId } = idParams.parse(request.params);
    return { data: await puzzleDuels.accept(request.user!.id, inviteId) };
  });

  /** POST /puzzle-duels/invites/:id/decline */
  fastify.post("/puzzle-duels/invites/:id/decline", { preHandler: authMiddleware, config: limited }, async (request, reply) => {
    const { id: inviteId } = idParams.parse(request.params);
    await puzzleDuels.decline(request.user!.id, inviteId);
    return reply.status(204).send();
  });

  /** POST /puzzle-duels/invites/:id/cancel - The sender takes it back */
  fastify.post("/puzzle-duels/invites/:id/cancel", { preHandler: authMiddleware, config: limited }, async (request, reply) => {
    const { id: inviteId } = idParams.parse(request.params);
    await puzzleDuels.cancel(request.user!.id, inviteId);
    return reply.status(204).send();
  });

  /** GET /puzzle-duels/active - The duel the player is in now, to come back to */
  fastify.get("/puzzle-duels/active", { preHandler: authMiddleware }, async (request) => ({
    data: { duelId: await puzzleDuels.activeDuelId(request.user!.id) },
  }));

  /** GET /puzzle-duels/:id - The duel as the player sees it (its players only) */
  fastify.get("/puzzle-duels/:id", { preHandler: authMiddleware, config: playing }, async (request) => {
    const { id: duelId } = idParams.parse(request.params);
    return { data: await puzzleDuels.state(duelId, request.user!.id) };
  });

  /** POST /puzzle-duels/:id/moves - A move in the player's current puzzle */
  fastify.post("/puzzle-duels/:id/moves", { preHandler: authMiddleware, config: playing }, async (request) => {
    const { id: duelId } = idParams.parse(request.params);
    const { index, move } = moveSchema.parse(request.body);
    return { data: await puzzleDuels.move(duelId, request.user!.id, index, move) };
  });
}
