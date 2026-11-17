import type { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

/**
 * Counts one event against a limit shared by every server instance: at most
 * `max` per `windowSeconds`, in fixed windows that start with the first
 * event. Returns false once the limit is passed. Throws if Redis is down.
 */
export async function withinLimit(
  redis: RedisClient,
  key: string,
  max: number,
  windowSeconds: number
): Promise<boolean> {
  const replies = await redis
    .multi()
    // Starts the window (and its expiry) only if there isn't one
    .set(key, "0", { condition: "NX", expiration: { type: "EX", value: windowSeconds } })
    .incr(key)
    .exec();
  return Number(replies[1]) <= max;
}
