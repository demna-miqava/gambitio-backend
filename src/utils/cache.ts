import type { FastifyBaseLogger } from "fastify";
import type { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

/**
 * Read-through caches in Redis. Redis is only an optimization here: if it is
 * down or slow to answer, the value is computed and returned as if it were a
 * miss, so pages that use these caches keep working.
 *
 * Within one process, concurrent misses on the same key share one
 * computation, so a popular key expiring doesn't send every waiting request
 * to Postgres at once.
 */

/** Computations in flight in this process, by cache key. */
const inFlight = new Map<string, Promise<unknown>>();

/** Runs `compute` unless the same key is already being computed here; then waits for that one. */
function singleFlight<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;
  const promise = compute().finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/** How cachedValue stores a value: with the time it stops being fresh. */
interface Stored<T> {
  v: T;
  freshUntil: number;
}

function parseStored<T>(raw: string): Stored<T> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Entries written before values carried their freshness read as a miss
    if (typeof parsed === "object" && parsed !== null && "freshUntil" in parsed && "v" in parsed) {
      return parsed as Stored<T>;
    }
  } catch {
    // A corrupt entry is a miss too
  }
  return null;
}

/**
 * A whole value under its own key, fresh for `ttlSeconds`. With
 * `staleSeconds`, the entry is kept that much longer and a request that
 * finds it stale gets it at once while this process recomputes it in the
 * background (one recomputation at a time), so nobody waits on an expiry.
 */
export async function cachedValue<T>(
  redis: RedisClient,
  log: FastifyBaseLogger,
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
  options: { staleSeconds?: number } = {}
): Promise<T> {
  const staleSeconds = options.staleSeconds ?? 0;
  const hit = await redis.get(key).catch((err) => {
    log.warn({ err, key }, "Cache read failed");
    return null;
  });
  const stored = hit ? parseStored<T>(hit) : null;

  const refresh = () =>
    singleFlight(key, async () => {
      const value = await compute();
      const entry: Stored<T> = { v: value, freshUntil: Date.now() + ttlSeconds * 1000 };
      await redis
        .setEx(key, ttlSeconds + staleSeconds, JSON.stringify(entry))
        .catch((err) => log.warn({ err, key }, "Cache write failed"));
      return value;
    });

  if (stored) {
    if (stored.freshUntil > Date.now()) return stored.v;
    if (staleSeconds > 0) {
      refresh().catch((err) => log.error({ err, key }, "Cache refresh failed"));
      return stored.v;
    }
  }
  return refresh();
}

/**
 * A group of cached values that are dropped together (a user's stats): one
 * hash, plus a generation counter that invalidateCacheGroups bumps. A
 * computation only writes its result back if the generation is still the
 * one it saw before it started, so a result computed from data read before
 * a change can't land in the cache after that change cleared it.
 */
export interface CacheGroup {
  key: string;
  generationKey: string;
}

/** Long enough to outlive every entry of the group and any computation. */
const GENERATION_TTL_SECONDS = 24 * 60 * 60;

/** Writes a field only if the group's generation is the one the reader saw. */
const WRITE_IF_GENERATION = `
local current = redis.call('GET', KEYS[2]) or ''
if current ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4], 'NX')
return 1`;

/**
 * One field of a group's hash. The TTL is set when the hash is created and
 * not extended by later fields, so nothing lives longer than ttlSeconds.
 */
export async function cachedField<T>(
  redis: RedisClient,
  log: FastifyBaseLogger,
  group: CacheGroup,
  field: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  const { key, generationKey } = group;
  let generation: string | null = null;
  try {
    // Sent together: one round trip
    const [hit, current] = await Promise.all([redis.hGet(key, field), redis.get(generationKey)]);
    if (hit) return JSON.parse(hit) as T;
    generation = current ?? "";
  } catch (err) {
    log.warn({ err, key }, "Cache read failed");
  }
  const seen = generation;
  // Without a generation (Redis failed) the result can't be checked, so it
  // isn't stored; concurrent misses still share one computation
  if (seen === null) return singleFlight(`${key}\u0000${field}\u0000uncached`, compute);
  return singleFlight(`${key}\u0000${field}\u0000${seen}`, async () => {
    const value = await compute();
    await redis
      .eval(WRITE_IF_GENERATION, {
        keys: [key, generationKey],
        arguments: [seen, field, JSON.stringify(value), String(ttlSeconds)],
      })
      .catch((err) => log.warn({ err, key }, "Cache write failed"));
    return value;
  });
}

/**
 * Drops every cached value of the groups and moves them to a new
 * generation, so results still being computed from older data aren't
 * stored (see CacheGroup). `alsoDelete` are plain keys (cachedValue
 * entries) dropped in the same round trip. Throws if Redis fails; callers
 * log it.
 */
export async function invalidateCacheGroups(
  redis: RedisClient,
  groups: CacheGroup[],
  alsoDelete: string[] = []
): Promise<void> {
  if (groups.length === 0 && alsoDelete.length === 0) return;
  const multi = redis.multi();
  for (const { key, generationKey } of groups) {
    multi.incr(generationKey).expire(generationKey, GENERATION_TTL_SECONDS).del(key);
  }
  if (alsoDelete.length > 0) multi.del(alsoDelete);
  await multi.exec();
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
