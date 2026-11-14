import type { FastifyInstance } from "fastify";
import { authMiddleware } from "../middleware/auth.js";

export async function challengeRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/challenges
   * Challenges received by the authenticated user
   */
  fastify.get("/challenges", { preHandler: authMiddleware }, async (request) => {
    const challenges = await fastify.challenges.getChallengesReceivedByUser(request.user!.id);
    return {
      challenges: challenges.map((challenge) => ({
        id: challenge.id,
        createdAt: challenge.createdAt,
        challengerId: challenge.challengerId,
        username: challenge.challengerUsername,
        avatarUrl: challenge.challengerAvatarUrl,
        time: challenge.time,
        increment: challenge.increment,
        rating: challenge.challengerRating,
        // The color the receiving player will play
        color: challenge.challengerColor === "white" ? "black" : "white",
        bestOf: challenge.bestOf,
        seriesId: challenge.seriesId,
        seriesGame: challenge.seriesGame,
      })),
    };
  });

  /**
   * GET /api/challenges/sent
   * The challenge the authenticated user is waiting on, or null. Lets the
   * client restore (or drop) its "Waiting for…" state after a reload or
   * reconnect.
   */
  fastify.get("/challenges/sent", { preHandler: authMiddleware }, async (request) => {
    const challenge = await fastify.challenges.getChallengeSentByUser(request.user!.id);
    return {
      challenge: challenge && {
        id: challenge.id,
        createdAt: challenge.createdAt,
        challengedId: challenge.challengedId,
        username: challenge.challengedUsername,
        time: challenge.time,
        increment: challenge.increment,
        color: challenge.challengerColor,
        bestOf: challenge.bestOf,
        seriesId: challenge.seriesId,
        seriesGame: challenge.seriesGame,
      },
    };
  });
}
