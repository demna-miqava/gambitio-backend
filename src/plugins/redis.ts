import { type FastifyInstance } from "fastify";
import { createClient } from "redis";

declare module "fastify" {
  interface FastifyInstance {
    redis: ReturnType<typeof createClient>;
  }
}

export async function registerRedis(fastify: FastifyInstance, url: string) {
  // Commands fail at once while disconnected instead of queueing until
  // Redis is back: callers treat Redis as optional where they can (caches)
  // and would otherwise hang
  const redisClient = createClient({ url, disableOfflineQueue: true });

  redisClient.on("error", (err) => {
    fastify.log.error({ err }, "Redis client error");
  });

  await redisClient.connect();
  fastify.log.info("Redis connected");

  fastify.decorate("redis", redisClient);

  fastify.addHook("onClose", async () => {
    await redisClient.quit();
  });
}
