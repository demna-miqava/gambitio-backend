import type { FastifyInstance } from "fastify";
import { ChallengeService } from "../services/challengeService.js";
import { authMiddleware } from "../middleware/auth.js";

/**
 * Challenge REST API routes
 */
export async function challengeRoutes(fastify: FastifyInstance) {
  const challengeService = new ChallengeService(fastify);

  /**
   * GET /api/challenges
   * Get all challenges received by the authenticated user
   */
  fastify.get(
    "/challenges",
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const userId = request.user!.id;

        const challenges = await challengeService.getChallengesReceivedByUser(
          userId
        );

        reply.send({
          challenges: challenges.map((challenge) => ({
            id: challenge.id,
            createdAt: challenge.createdAt,
            challengerId: challenge.challengerId,
            username: challenge.challengerUsername,
            avatarUrl: challenge.challengerAvatarUrl,
            time: challenge.time,
            increment: challenge.increment,
            color: challenge.challengerColor,
          })),
        });
      } catch (error) {
        fastify.log.error({ error }, "Error fetching challenges");
        reply.status(500).send({ error: "Failed to fetch challenges" });
      }
    }
  );
}
