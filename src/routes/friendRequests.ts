import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { FriendService } from "../services/friendService.js";
import {
  sendFriendRequestSchema,
  requestIdParamSchema,
  type SendFriendRequest,
  type RequestIdParam,
} from "../schemas/friendSchemas.js";
import { authMiddleware } from "../middleware/auth.js";

export async function friendRequestsRoutes(fastify: FastifyInstance) {
  const friendService = new FriendService(fastify);

  /**
   * POST /api/friend-requests
   * Send a friend request
   */
  fastify.post<{ Body: SendFriendRequest }>(
    "/friend-requests",
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Validate request body
        const validation = sendFriendRequestSchema.safeParse(request.body);
        console.log("VALIDATION", validation);
        if (!validation.success) {
          return reply.status(400).send({
            error: "Validation failed",
            details: validation.error.issues,
          });
        }

        const { receiverId } = validation.data;

        const friendRequest = await friendService.sendFriendRequest(
          request.user!.id,
          request.user!.username,
          null, // avatarUrl - fetch from DB if needed
          receiverId
        );

        return reply.status(201).send(friendRequest);
      } catch (error) {
        if (error instanceof Error) {
          if (
            error.message === "User not found" ||
            error.message === "Cannot send friend request to yourself" ||
            error.message === "Already friends with this user" ||
            error.message === "Friend request already exists"
          ) {
            return reply.status(400).send({ error: error.message });
          }
        }
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );

  /**
   * GET /api/friend-requests/pending
   * Get pending friend requests
   */
  fastify.get(
    "/friend-requests/pending",
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const requests = await friendService.getPendingFriendRequests(
          request.user!.id
        );

        return reply.send(requests);
      } catch (error) {
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );

  /**
   * POST /api/friend-requests/:requestId/accept
   * Accept a friend request
   */
  fastify.post<{ Params: RequestIdParam }>(
    "/friend-requests/:requestId/accept",
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Validate path parameters
        const validation = requestIdParamSchema.safeParse(request.params);
        if (!validation.success) {
          return reply.status(400).send({
            error: "Validation failed",
            details: validation.error.issues,
          });
        }

        const requestId = parseInt(validation.data.requestId, 10);

        const friendship = await friendService.acceptFriendRequest(
          requestId,
          request.user!.id
        );

        return reply.send({
          message: "Friend request accepted",
          friendship,
        });
      } catch (error) {
        if (error instanceof Error) {
          if (
            error.message === "Friend request not found" ||
            error.message === "Not authorized to accept this friend request"
          ) {
            return reply.status(404).send({ error: error.message });
          }
        }
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );

  /**
   * POST /api/friend-requests/:requestId/decline
   * Decline a friend request
   */
  fastify.post<{ Params: RequestIdParam }>(
    "/friend-requests/:requestId/decline",
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Validate path parameters
        const validation = requestIdParamSchema.safeParse(request.params);
        if (!validation.success) {
          return reply.status(400).send({
            error: "Validation failed",
            details: validation.error.issues,
          });
        }

        const requestId = parseInt(validation.data.requestId, 10);

        await friendService.declineFriendRequest(requestId, request.user!.id);

        return reply.send({ message: "Friend request declined" });
      } catch (error) {
        if (error instanceof Error) {
          if (
            error.message === "Friend request not found" ||
            error.message === "Not authorized to decline this friend request"
          ) {
            return reply.status(404).send({ error: error.message });
          }
        }
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );

  /**
   * DELETE /api/friend-requests/:requestId
   * Cancel a friend request (outgoing)
   */
  fastify.delete<{ Params: RequestIdParam }>(
    "/friend-requests/:requestId",
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Validate path parameters
        const validation = requestIdParamSchema.safeParse(request.params);
        if (!validation.success) {
          return reply.status(400).send({
            error: "Validation failed",
            details: validation.error.issues,
          });
        }

        const requestId = parseInt(validation.data.requestId, 10);

        await friendService.cancelFriendRequest(requestId, request.user!.id);

        return reply.send({ message: "Friend request canceled" });
      } catch (error) {
        if (error instanceof Error) {
          if (
            error.message === "Friend request not found" ||
            error.message === "Not authorized to cancel this friend request"
          ) {
            return reply.status(404).send({ error: error.message });
          }
        }
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );
}
