import { type FastifyInstance } from "fastify";
import { createClient } from "redis";

declare module "fastify" {
  interface FastifyInstance {
    redis: ReturnType<typeof createClient>;
  }
}

export async function registerRedis(fastify: FastifyInstance, url: string) {
  const redisClient = createClient({ url });

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
