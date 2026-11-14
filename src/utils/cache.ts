import type { FastifyBaseLogger } from "fastify";
import type { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

/**
 * Read-through caches in Redis. Redis is only an optimization here: if it is
 * down or slow to answer, the value is computed and returned as if it were a
 * miss, so pages that use these caches keep working.
 */

/** A whole value under its own key. */
export async function cachedValue<T>(
  redis: RedisClient,
  log: FastifyBaseLogger,
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  const hit = await redis.get(key).catch((err) => {
    log.warn({ err, key }, "Cache read failed");
    return null;
  });
  if (hit) return JSON.parse(hit) as T;
  const value = await compute();
  await redis
    .setEx(key, ttlSeconds, JSON.stringify(value))
    .catch((err) => log.warn({ err, key }, "Cache write failed"));
  return value;
}

/**
 * One field of a hash, so related values (a user's stats) can be dropped
 * together with a single DEL. The TTL is set when the hash is created and
 * not extended by later fields, so nothing lives longer than ttlSeconds.
 */
export async function cachedField<T>(
  redis: RedisClient,
  log: FastifyBaseLogger,
  key: string,
  field: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  const hit = await redis.hGet(key, field).catch((err) => {
    log.warn({ err, key }, "Cache read failed");
    return null;
  });
  if (hit) return JSON.parse(hit) as T;
  const value = await compute();
  await redis
    .multi()
    .hSet(key, field, JSON.stringify(value))
    .expire(key, ttlSeconds, "NX")
    .exec()
    .catch((err) => log.warn({ err, key }, "Cache write failed"));
  return value;
}

/**
 * Memoizes a value in this process for `ttlMs`, sharing one computation
 * between concurrent callers. For data that is the same for everyone and
 * fine to be a few seconds old (the top live games).
 */
export function memoize<K, T>(ttlMs: number, compute: (key: K) => Promise<T>) {
  const entries = new Map<K, { at: number; value: Promise<T> }>();
  return (key: K): Promise<T> => {
    const now = Date.now();
    const entry = entries.get(key);
    if (entry && now - entry.at < ttlMs) return entry.value;
    const value = compute(key);
    entries.set(key, { at: now, value });
    // A failure isn't cached
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}
