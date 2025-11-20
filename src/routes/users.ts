import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UserService } from "../services/userService.js";
import { FriendRepository } from "../repositories/friendRepository.js";
import { GameService } from "../services/gameService.js";
import {
  signupSchema,
  signinSchema,
  changePasswordSchema,
  changeEmailSchema,
} from "../schemas/userSchemas.js";
import { ZodError } from "zod";
import {
  generateAccessToken,
  generateRefreshToken,
  setAuthCookies,
} from "../utils/jwtHelpers.js";
import { authMiddleware } from "../middleware/auth.js";
import { paginationQuerySchema } from "../schemas/gameSchemas.js";

export async function userRoutes(fastify: FastifyInstance) {
  const userService = new UserService(fastify);
  const friendRepository = new FriendRepository(fastify);
  const gameService = new GameService(fastify);

  // POST /users/signup - Create new user
  fastify.post<{ Body: unknown }>(
    "/users/signup",
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      try {
        // Validate request body with Zod
        const validatedData = signupSchema.parse(request.body);
        // Create user
        const user = await userService.signup(validatedData);

        // Generate JWT tokens
        const jwtPayload = {
          userId: user.id,
          username: user.username,
          authMethod: "email" as const,
        };
        const accessToken = generateAccessToken(jwtPayload);
        const refreshToken = generateRefreshToken(jwtPayload);

        // Set tokens as httpOnly cookies
        setAuthCookies(reply, { accessToken, refreshToken });

        return reply.status(201).send({
          message: "User created successfully",
          user,
        });
      } catch (error) {
        // Handle Zod validation errors
        if (error instanceof ZodError) {
          return reply.status(400).send({
            error: "Validation error",
            details: error.issues,
          });
        }

        // Handle duplicate email/username errors
        if (error instanceof Error) {
          if (
            error.message === "Email already exists" ||
            error.message === "Username already exists"
          ) {
            return reply
              .status(409)
              .send({ message: "This user already exists" });
          }
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: "Failed to create user" });
      }
    }
  );

  // POST /users/signin - Authenticate user
  fastify.post<{ Body: unknown }>(
    "/users/signin",
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      try {
        // Validate request body with Zod
        const validatedData = signinSchema.parse(request.body);

        // Authenticate user
        const user = await userService.signin(validatedData);

        // Generate JWT tokens
        const jwtPayload = {
          userId: user.id,
          username: user.username,
          authMethod: "email" as const,
        };
        const accessToken = generateAccessToken(jwtPayload);
        const refreshToken = generateRefreshToken(jwtPayload);

        // Set tokens as httpOnly cookies
        setAuthCookies(reply, { accessToken, refreshToken });

        return reply.status(200).send({
          message: "Signin successful",
          user,
        });
      } catch (error) {
        // Handle Zod validation errors
        if (error instanceof ZodError) {
          return reply.status(400).send({
            error: "Validation error",
            details: error.issues,
          });
        }

        // Handle invalid credentials error
        if (error instanceof Error && error.message === "Invalid credentials") {
          return reply.status(400).send({ message: "Invalid credentials" });
        }

        fastify.log.error(error);
        return reply.status(500).send({ message: "Failed to sign in" });
      }
    }
  );

  // POST /users/logout - Logout user
  fastify.post(
    "/users/logout",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Clear both cookies
        reply.clearCookie("accessToken", { path: "/" });
        reply.clearCookie("refreshToken", { path: "/" });

        return reply.status(200).send({ message: "Logout successful" });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: "Failed to logout" });
      }
    }
  );

  // GET /users/me - Get current authenticated user (protected route example)
  fastify.get(
    "/users/me",
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // request.user is populated by authMiddleware
        if (!request.user) {
          return reply.status(401).send({ error: "Not authenticated" });
        }

        // Fetch full user details
        const user = await userService.getUserById(request.user.userId);

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

  // PATCH /users/password - Change user password
  fastify.put<{ Body: unknown }>(
    "/users/change-password",
    { preHandler: authMiddleware },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      try {
        if (!request.user) {
          return reply.status(401).send({ error: "Not authenticated" });
        }

        // Validate request body with Zod
        const validatedData = changePasswordSchema.parse(request.body);
        // Change password
        await userService.changePassword(
          request.user.userId,
          validatedData.oldPassword,
          validatedData.newPassword
        );

        return reply
          .status(200)
          .send({ message: "Password changed successfully" });
      } catch (error) {
        // Handle Zod validation errors
        if (error instanceof ZodError) {
          return reply.status(400).send({
            error: "Validation error",
            details: error.issues,
          });
        }

        // Handle invalid old password error
        if (
          error instanceof Error &&
          error.message === "Invalid old password"
        ) {
          return reply.status(400).send({ message: "Invalid old password" });
        }

        // Handle user not found error
        if (error instanceof Error && error.message === "User not found") {
          return reply.status(404).send({ message: "User not found" });
        }

        fastify.log.error(error);
        return reply.status(500).send({ message: "Failed to change password" });
      }
    }
  );

  // PUT /users/change-email - Change user email
  fastify.put<{ Body: unknown }>(
    "/users/change-email",
    { preHandler: authMiddleware },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      try {
        if (!request.user) {
          return reply.status(401).send({ error: "Not authenticated" });
        }

        // Validate request body with Zod
        const validatedData = changeEmailSchema.parse(request.body);

        // Change email
        await userService.changeEmail(
          request.user.userId,
          validatedData.newEmail
        );

        return reply
          .status(200)
          .send({ message: "Email changed successfully" });
      } catch (error) {
        // Handle Zod validation errors
        if (error instanceof ZodError) {
          return reply.status(400).send({
            error: "Validation error",
            details: error.issues,
          });
        }

        // Handle email already in use error
        if (
          error instanceof Error &&
          error.message === "Email already in use"
        ) {
          return reply.status(409).send({ message: "Email already in use" });
        }

        fastify.log.error(error);
        return reply.status(500).send({ message: "Failed to change email" });
      }
    }
  );

  // GET /users/:userId - Get user profile by userId
  fastify.get<{
    Params: { userId: string };
  }>(
    "/users/:userId",
    async (
      request: FastifyRequest<{
        Params: { userId: string };
      }>,
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
        return reply.status(500).send({ error: "Failed to fetch user profile" });
      }
    }
  );

  // GET /users/:userId/friends - Get friends list for a specific user
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

        // Validate query parameters
        const validatedQuery = paginationQuerySchema.parse(request.query);

        // Fetch friends
        const result = await friendRepository.getFriends(
          userId,
          validatedQuery.limit,
          (validatedQuery.page - 1) * validatedQuery.limit,
          searchQuery
        );

        // Calculate total pages
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
        // Handle Zod validation errors
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

  // GET /users/:userId/games - Get games for a specific user
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

        // Validate query parameters
        const validatedQuery = paginationQuerySchema.parse(request.query);

        // Fetch games
        const result = await gameService.getGamesByUserId(
          userId,
          validatedQuery.page,
          validatedQuery.limit
        );

        return reply.status(200).send(result);
      } catch (error) {
        // Handle Zod validation errors
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
