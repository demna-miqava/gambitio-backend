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
        // Each player's starting clock when they differ (time odds), from
        // the receiving player's side; null for an even game
        ownTime: challenge.challengedTime,
        opponentTime: challenge.challengerTime,
        rating: challenge.challengerRating,
        // The color the receiving player will play
        color: challenge.challengerColor === "white" ? "black" : "white",
        bestOf: challenge.bestOf,
        seriesId: challenge.seriesId,
        seriesGame: challenge.seriesGame,
        // False for a casual game (or series); always false with time odds
        rated: challenge.rated,
        // Changes whenever the terms do; sent back when accepting
        version: challenge.version,
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
        ownTime: challenge.challengerTime,
        opponentTime: challenge.challengedTime,
        color: challenge.challengerColor,
        bestOf: challenge.bestOf,
        seriesId: challenge.seriesId,
        seriesGame: challenge.seriesGame,
        rated: challenge.rated,
        version: challenge.version,
      },
    };
  });
}
