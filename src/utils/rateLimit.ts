import type { createClient } from "redis";
import { AppError } from "../errors/AppError.js";

type RedisClient = ReturnType<typeof createClient>;

/**
 * Counts one event against a limit shared by every server instance: at most
 * `max` per `windowSeconds`, in fixed windows that start with the first
 * event. Returns false once the limit is passed.
 *
 * Throws if Redis can't be reached: an AppError (503, SERVICE_UNAVAILABLE),
 * so a caller that doesn't let the event through anyway (`.catch(() => true)`)
 * answers "try again in a moment" rather than a bare 500.
 */
export async function withinLimit(
  redis: RedisClient,
  key: string,
  max: number,
  windowSeconds: number
): Promise<boolean> {
  let replies;
  try {
    replies = await redis
      .multi()
      // Starts the window (and its expiry) only if there isn't one
      .set(key, "0", { condition: "NX", expiration: { type: "EX", value: windowSeconds } })
      .incr(key)
      .exec();
  } catch (err) {
    throw Object.assign(
      new AppError("This is unavailable for a moment. Try again shortly.", "SERVICE_UNAVAILABLE", 503),
      { cause: err }
    );
  }
  return Number(replies[1]) <= max;
}
