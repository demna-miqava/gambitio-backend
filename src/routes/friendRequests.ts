import type { FastifyInstance } from "fastify";
import { FriendService } from "../services/friendService.js";
import { sendFriendRequestSchema, requestIdParamSchema } from "../schemas/friendSchemas.js";
import { authMiddleware } from "../middleware/auth.js";

export async function friendRequestsRoutes(fastify: FastifyInstance) {
  const friendService = new FriendService(fastify);

  /**
   * POST /api/friend-requests
   * 400 for self-request / already friends / request exists, 404 if receiver not found
   */
  fastify.post("/friend-requests", { preHandler: authMiddleware }, async (request, reply) => {
    const { receiverId } = sendFriendRequestSchema.parse(request.body);
    const friendRequest = await friendService.sendFriendRequest(
      request.user!.id,
      request.user!.username,
      receiverId
    );
    return reply.status(201).send({ data: friendRequest });
  });

  /**
   * GET /api/friend-requests/pending
   * Incoming and outgoing pending requests
   */
  fastify.get("/friend-requests/pending", { preHandler: authMiddleware }, async (request) => {
    return friendService.getPendingFriendRequests(request.user!.id);
  });

  fastify.post(
    "/friend-requests/:requestId/accept",
    { preHandler: authMiddleware },
    async (request) => {
      const { requestId } = requestIdParamSchema.parse(request.params);
      const friendship = await friendService.acceptFriendRequest(requestId, request.user!.id);
      return { success: true, message: "Friend request accepted", data: friendship };
    }
  );

  fastify.post(
    "/friend-requests/:requestId/decline",
    { preHandler: authMiddleware },
    async (request) => {
      const { requestId } = requestIdParamSchema.parse(request.params);
      await friendService.declineFriendRequest(requestId, request.user!.id);
      return { success: true, message: "Friend request declined" };
    }
  );

  fastify.delete("/friend-requests/:requestId", { preHandler: authMiddleware }, async (request) => {
    const { requestId } = requestIdParamSchema.parse(request.params);
    await friendService.cancelFriendRequest(requestId, request.user!.id);
    return { success: true, message: "Friend request canceled" };
  });
}
