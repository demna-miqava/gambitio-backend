import { type FastifyInstance } from "fastify";
import { createClient } from "redis";

declare module "fastify" {
  interface FastifyInstance {
    redis: ReturnType<typeof createClient>;
  }
}

export async function registerRedis(fastify: FastifyInstance) {
  const redisClient = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
  });

  redisClient.on("error", (err) => {
    fastify.log.error("Redis Client Error:", err);
  });

  redisClient.on("connect", () => {
    fastify.log.info("Redis Client Connected");
  });

  redisClient.on("ready", () => {
    fastify.log.info("Redis Client Ready");
  });

  await redisClient.connect();

  fastify.decorate("redis", redisClient);

  fastify.addHook("onClose", async () => {
    await redisClient.quit();
    fastify.log.info("Redis Client Disconnected");
  });
}
