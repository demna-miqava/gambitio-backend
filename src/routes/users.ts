import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UserService } from "../services/userService.js";
import { FriendRepository } from "../repositories/friendRepository.js";
import { GameService } from "../services/gameService.js";
import { ZodError, z } from "zod";
import { authMiddleware, clerkAuthMiddleware } from "../middleware/auth.js";
import { paginationQuerySchema } from "../schemas/gameSchemas.js";
import { getAuth } from "@clerk/fastify";
import { createClerkClient } from "@clerk/backend";

// Schema for syncing user profile after Clerk auth
const syncUserSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(
      /^[a-zA-Z0-9_]+$/,
      "Username can only contain letters, numbers, and underscores"
    ),
  skill: z.enum(["new", "beginner", "intermediate", "advanced"]),
});

// Schema for checking username availability
const checkUsernameSchema = z.object({
  username: z.string().min(1, "Username is required"),
});

export async function userRoutes(fastify: FastifyInstance) {
  const userService = new UserService(fastify);
  const friendRepository = new FriendRepository(fastify);
  const gameService = new GameService(fastify);

  /**
   * POST /users/sync - Create/sync user profile after Clerk authentication
   * Called when a user first signs up via Clerk to create their chess profile
   */
  fastify.post<{ Body: unknown }>(
    "/users/sync",
    { preHandler: clerkAuthMiddleware },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      try {
        const { userId: clerkId } = getAuth(request);

        if (!clerkId) {
          return reply.status(401).send({ error: "Authentication required" });
        }

        // Fetch user email from Clerk API
        const secretKey = process.env.CLERK_SECRET_KEY;
        if (!secretKey) {
          fastify.log.error("CLERK_SECRET_KEY not configured");
          return reply.status(500).send({ error: "Server configuration error" });
        }
        const clerk = createClerkClient({ secretKey });
        const clerkUser = await clerk.users.getUser(clerkId);
        const email = clerkUser.emailAddresses.find(
          (e) => e.id === clerkUser.primaryEmailAddressId
        )?.emailAddress;

        if (!email) {
          return reply
            .status(400)
            .send({ error: "Email not found for user" });
        }

        // Validate request body
        const validatedData = syncUserSchema.parse(request.body);

        // Sync user
        const user = await userService.syncUser(clerkId, email, validatedData);

        return reply.status(201).send({
          message: "Profile created successfully",
          user,
        });
      } catch (error) {
        if (error instanceof ZodError) {
          return reply.status(400).send({
            error: "Validation error",
            details: error.issues,
          });
        }

        if (
          error instanceof Error &&
          error.message === "Username already exists"
        ) {
          return reply.status(409).send({ error: "Username already taken" });
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: "Failed to create profile" });
      }
    }
  );

  /**
   * GET /users/check-username?username=xxx - Check if username is available
   * Public endpoint (but requires Clerk auth to prevent abuse)
   */
  fastify.get<{ Querystring: { username?: string } }>(
    "/users/check-username",
    { preHandler: clerkAuthMiddleware },
    async (
      request: FastifyRequest<{ Querystring: { username?: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const validation = checkUsernameSchema.safeParse(request.query);
        if (!validation.success) {
          return reply.status(400).send({
            error: "Validation error",
            details: validation.error.issues,
          });
        }

        const available = await userService.isUsernameAvailable(
          validation.data.username
        );
        return reply.send({ available });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: "Failed to check username" });
      }
    }
  );

  /**
   * GET /users/me - Get current authenticated user
   */
  fastify.get(
    "/users/me",
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!request.user) {
          return reply.status(401).send({ error: "Not authenticated" });
        }

        const user = await userService.getUserById(request.user.id);

        if (!user) {
          return reply.status(404).send({ error: "User not found" });
        }

        return reply.status(200).send({ user });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: "Failed to fetch user" });
      }
    }
  );

  /**
   * GET /users/status - Check if current Clerk user has a profile
   * Returns profile status and user data if exists
   */
  fastify.get(
    "/users/status",
    { preHandler: clerkAuthMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { userId: clerkId } = getAuth(request);

        if (!clerkId) {
          return reply.status(401).send({ error: "Authentication required" });
        }

        const user = await userService.getUserByClerkId(clerkId);

        if (!user) {
          return reply.send({
            hasProfile: false,
            user: null,
          });
        }

        return reply.send({
          hasProfile: true,
          user,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: "Failed to check user status" });
      }
    }
  );

  /**
   * GET /users/:userId - Get user profile by userId (public)
   */
  fastify.get<{ Params: { userId: string } }>(
    "/users/:userId",
    async (
      request: FastifyRequest<{ Params: { userId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const userId = parseInt(request.params.userId, 10);

        if (isNaN(userId)) {
          return reply.status(400).send({ error: "Invalid user ID" });
        }

        const user = await userService.getUserById(userId);

        if (!user) {
          return reply.status(404).send({ error: "User not found" });
        }

        // Get friend count
        const friendResult = await friendRepository.getFriends(userId, 1, 0);

        return reply.status(200).send({
          user: {
            id: user.id,
            username: user.username,
            createdAt: user.createdAt,
            rapidRating: user.rapidRating,
            blitzRating: user.blitzRating,
            bulletRating: user.bulletRating,
            friendCount: friendResult.total,
          },
        });
      } catch (error) {
        fastify.log.error(error);
        return reply
          .status(500)
          .send({ error: "Failed to fetch user profile" });
      }
    }
  );

  /**
   * GET /users/:userId/friends - Get friends list for a specific user (public)
   */
  fastify.get<{
    Params: { userId: string };
    Querystring: { page?: string; limit?: string; q?: string };
  }>(
    "/users/:userId/friends",
    async (
      request: FastifyRequest<{
        Params: { userId: string };
        Querystring: { page?: string; limit?: string; q?: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const userId = parseInt(request.params.userId, 10);
        const { q: searchQuery } = request.query;

        if (isNaN(userId)) {
          return reply.status(400).send({ error: "Invalid user ID" });
        }

        const validatedQuery = paginationQuerySchema.parse(request.query);

        const result = await friendRepository.getFriends(
          userId,
          validatedQuery.limit,
          (validatedQuery.page - 1) * validatedQuery.limit,
          searchQuery
        );

        const totalPages = Math.ceil(result.total / validatedQuery.limit);

        return reply.status(200).send({
          data: result.suggestions,
          pagination: {
            page: validatedQuery.page,
            limit: validatedQuery.limit,
            total: result.total,
            totalPages,
          },
        });
      } catch (error) {
        if (error instanceof ZodError) {
          return reply.status(400).send({
            error: "Validation error",
            details: error.issues,
          });
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: "Failed to fetch friends" });
      }
    }
  );

  /**
   * GET /users/:userId/games - Get games for a specific user (public)
   */
  fastify.get<{
    Params: { userId: string };
    Querystring: { page?: string; limit?: string };
  }>(
    "/users/:userId/games",
    async (
      request: FastifyRequest<{
        Params: { userId: string };
        Querystring: { page?: string; limit?: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const userId = parseInt(request.params.userId, 10);

        if (isNaN(userId)) {
          return reply.status(400).send({ error: "Invalid user ID" });
        }

        const validatedQuery = paginationQuerySchema.parse(request.query);

        const result = await gameService.getGamesByUserId(
          userId,
          validatedQuery.page,
          validatedQuery.limit
        );

        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof ZodError) {
          return reply.status(400).send({
            error: "Validation error",
            details: error.issues,
          });
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: "Failed to fetch games" });
      }
    }
  );
}
