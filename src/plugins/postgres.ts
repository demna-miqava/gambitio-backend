import { type FastifyInstance } from "fastify";
import postgres from "@fastify/postgres";

export async function registerPostgres(fastify: FastifyInstance) {
  await fastify.register(postgres, {
    connectionString: process.env.POSTGRES_CONNECTION_STRING,
  });
}
