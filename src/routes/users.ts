import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UserService } from "../services/userService.js";
import { signupSchema, signinSchema } from "../schemas/userSchemas.js";
import { ZodError } from "zod";
import { generateAccessToken, generateRefreshToken, setAuthCookies } from "../utils/jwtHelpers.js";
import { authMiddleware } from "../middleware/auth.js";

export async function userRoutes(fastify: FastifyInstance) {
  const userService = new UserService(fastify);

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
  fastify.post("/users/logout", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Clear both cookies
      reply.clearCookie("accessToken", { path: "/" });
      reply.clearCookie("refreshToken", { path: "/" });

      return reply.status(200).send({ message: "Logout successful" });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to logout" });
    }
  });

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
}
