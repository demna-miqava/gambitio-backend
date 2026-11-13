import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { UserService } from "../services/userService.js";
import { FriendRepository } from "../repositories/friendRepository.js";
import { GameService } from "../services/gameService.js";
import { StatsService } from "../services/statsService.js";
import { authMiddleware, clerkAuthMiddleware } from "../middleware/auth.js";
import { paginationSchema } from "../schemas/pagination.js";
import { syncUserSchema, checkUsernameSchema } from "../schemas/userSchemas.js";
import { AppError } from "../errors/AppError.js";

const userIdParams = z.object({ userId: z.coerce.number().int().positive() });
const friendsQuery = paginationSchema.extend({ q: z.string().max(100).optional() });
const statsQuery = z.object({
  days: z.enum(["30", "90", "365", "all-time"]).default("all-time"),
  variant: z.enum(["all", "bullet", "blitz", "rapid"]).default("all"),
});

const userNotFound = () => new AppError("User not found", "USER_NOT_FOUND", 404);

export async function userRoutes(fastify: FastifyInstance) {
  const userService = new UserService(fastify);
  const friendRepository = new FriendRepository(fastify);
  const gameService = new GameService(fastify);
  const statsService = new StatsService(fastify);

  /**
   * POST /users/sync - Create the chess profile after Clerk sign-up
   */
  fastify.post("/users/sync", { preHandler: clerkAuthMiddleware }, async (request, reply) => {
    const data = syncUserSchema.parse(request.body);
    const clerkId = request.clerkId!;
    const email = await fastify.authProvider.getEmail(clerkId);
    if (!email) throw new AppError("Email not found for user", "EMAIL_NOT_FOUND", 400);

    const user = await userService.syncUser(clerkId, email, data);
    return reply.status(201).send({ message: "Profile created successfully", user });
  });

  /**
   * GET /users/check-username?username=xxx
   */
  fastify.get("/users/check-username", { preHandler: clerkAuthMiddleware }, async (request) => {
    const { username } = checkUsernameSchema.parse(request.query);
    return { available: await userService.isUsernameAvailable(username) };
  });

  /**
   * GET /users/me - Current authenticated user
   */
  fastify.get("/users/me", { preHandler: authMiddleware }, async (request) => {
    const user = await userService.getUserById(request.user!.id);
    if (!user) throw userNotFound();
    return { user };
  });

  /**
   * DELETE /users/me - Delete the account (profile data and the Clerk user).
   * Clerk-only auth so a retry works after the profile part already succeeded.
   */
  fastify.delete("/users/me", { preHandler: clerkAuthMiddleware }, async (request, reply) => {
    await userService.deleteAccount(request.clerkId!);
    return reply.status(204).send();
  });

  /**
   * GET /users/status - Whether the signed-in Clerk user has a chess profile
   */
  fastify.get("/users/status", { preHandler: clerkAuthMiddleware }, async (request) => {
    const user = await userService.getUserByClerkId(request.clerkId!);
    return { hasProfile: user !== null, user };
  });

  /**
   * GET /users/:userId - Profile (signed-in users)
   */
  fastify.get("/users/:userId", { preHandler: authMiddleware }, async (request) => {
    const { userId } = userIdParams.parse(request.params);
    const user = await userService.getUserById(userId);
    if (!user) throw userNotFound();
    const friendResult = await friendRepository.getFriends(userId, 1, 0);
    return {
      user: {
        id: user.id,
        username: user.username,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
        rapidRating: user.rapidRating,
        blitzRating: user.blitzRating,
        bulletRating: user.bulletRating,
        puzzleRating: user.puzzleRating,
        friendCount: friendResult.total,
      },
    };
  });

  /**
   * GET /users/:userId/friends - Friends list (signed-in users)
   */
  fastify.get("/users/:userId/friends", { preHandler: authMiddleware }, async (request) => {
    const { userId } = userIdParams.parse(request.params);
    const { page, limit, q } = friendsQuery.parse(request.query);
    const result = await friendRepository.getFriends(userId, limit, (page - 1) * limit, q);
    return {
      data: result.friends,
      pagination: { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) },
    };
  });

  /**
   * GET /users/:userId/games - Game history (signed-in users)
   */
  fastify.get("/users/:userId/games", { preHandler: authMiddleware }, async (request) => {
    const { userId } = userIdParams.parse(request.params);
    const { page, limit } = paginationSchema.parse(request.query);
    return gameService.getGamesByUserId(userId, page, limit);
  });

  /**
   * GET /users/:userId/stats/summary - Per-variant rating cards
   */
  fastify.get("/users/:userId/stats/summary", { preHandler: authMiddleware }, async (request) => {
    const { userId } = userIdParams.parse(request.params);
    return statsService.getSummary(userId);
  });

  /**
   * GET /users/:userId/stats?days=30|90|365|all-time&variant=all|bullet|blitz|rapid
   */
  fastify.get("/users/:userId/stats", { preHandler: authMiddleware }, async (request) => {
    const { userId } = userIdParams.parse(request.params);
    const { days, variant } = statsQuery.parse(request.query);
    return statsService.getComprehensive(userId, days === "all-time" ? null : Number(days), variant);
  });
}
