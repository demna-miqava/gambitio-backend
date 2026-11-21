import { type FastifyInstance } from "fastify";
import { createClient } from "redis";

declare module "fastify" {
  interface FastifyInstance {
    redis: ReturnType<typeof createClient>;
  }
}

type RedisClient = ReturnType<typeof createClient>;

/** Longest a shutdown waits for a connected client's pending commands. */
const CLOSE_TIMEOUT_MS = 2_000;

/**
 * Closes a client without ever hanging a shutdown. quit() would: it queues
 * QUIT and waits for the reply, which a client that is disconnected (or
 * reconnecting) never writes, and it stops the reconnecting. A connected
 * client finishes its pending commands (close()), for at most
 * CLOSE_TIMEOUT_MS; one that isn't connected is dropped at once (destroy()),
 * failing whatever it had queued. A client that is already closed is left.
 */
export async function closeRedis(client: RedisClient, timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
  if (!client.isOpen) return;
  if (!client.isReady) {
    client.destroy();
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    client.close(),
    // Past this the process exits anyway (see shutdown.ts); the socket goes with it
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
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
    await closeRedis(redisClient);
  });
}
