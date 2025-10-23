import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UserService } from "../services/userService.js";
import { signupSchema, signinSchema } from "../schemas/userSchemas.js";
import { ZodError } from "zod";

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
        const newUser = await userService.signup(validatedData);

        return reply.status(201).send({
          message: "User created successfully",
          user: newUser,
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
        const result = await userService.signin(validatedData);

        return reply.status(200).send(result);
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
}
