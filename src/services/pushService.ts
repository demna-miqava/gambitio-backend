import https from "node:https";
import type { FastifyInstance } from "fastify";
import webpush from "web-push";
import { AppError } from "../errors/AppError.js";
import { withinLimit } from "../utils/rateLimit.js";

/** What the service worker shows. Keep it small: push services cap payloads at about 4 KB. */
export interface PushPayload {
  title: string;
  body: string;
  /** Path in the app to open when the notification is clicked */
  url: string;
  /** A later notification with the same tag replaces the earlier one */
  tag: string;
}

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Delivers one encrypted message to one browser. Rejects with an error that
 * carries the push service's HTTP status as `statusCode`.
 */
export type PushSender = (subscription: StoredSubscription, payload: string, ttlSeconds: number) => Promise<void>;

export interface VapidKeys {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export function webPushSender(vapid: VapidKeys): PushSender {
  // One agent for every notification: connections to a push service (most
  // go to one or two hosts) stay open and are reused instead of a new TLS
  // handshake each time. web-push 3.6 takes it as `agent`.
  const agent = new https.Agent({ keepAlive: true, maxSockets: 50 });
  return async (subscription, payload, ttlSeconds) => {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      payload,
      { TTL: ttlSeconds, vapidDetails: vapid, urgency: "high", timeout: 10_000, agent }
    );
  };
}

/**
 * The push services browsers use. A subscription's endpoint is an address
 * the server will send requests to, and it comes from the client: without
 * this list a client could point the server at any host it likes, including
 * ones only the server can reach.
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge on Android, Brave, Opera
  ".push.services.mozilla.com", // Firefox
  ".notify.windows.com", // Edge
  ".push.apple.com", // Safari
];

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((allowed) => (allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed));
}

/** Browsers a user can have notifications on at once; the oldest go first */
const MAX_SUBSCRIPTIONS_PER_USER = 10;

/**
 * Limits on what reaches one person's devices, shared by every server
 * instance (Redis, with expiries):
 *
 * - At most RECIPIENT_LIMIT notifications a minute, whatever their kind or
 *   sender: a burst of challenges and requests from several people can't
 *   make a phone buzz without end.
 * - One notification per tag (a kind and its sender, e.g.
 *   `challenge-<challengerId>`) per dedupe window: re-sending a challenge
 *   with new terms, or a friend request after cancelling it, doesn't notify
 *   again. Callers can widen the window (friend requests use a day).
 */
export const PUSH_LIMITS = {
  RECIPIENT_LIMIT: { max: 10, windowSeconds: 60 },
  DEFAULT_DEDUPE_SECONDS: 60,
};

/**
 * Push service answers that mean the subscription itself is gone: 404 and
 * 410 (the browser unsubscribed or it expired). Deleted at once; the browser
 * registers again when the user turns notifications on or signs in (the
 * frontend's syncPushSubscription).
 *
 * 403 is only that certain from FCM, where it means the subscription was
 * made for other VAPID keys (e.g. after the keys changed). Apple's service
 * also answers 403 when it rejects our VAPID token itself (a subject it
 * doesn't accept, clock skew), which would unsubscribe every Safari user on
 * the first push, so elsewhere a 403 only counts as a failure (below).
 */
const GONE_STATUSES = new Set([404, 410]);
const isGone = (status: number | undefined, endpoint: string) =>
  status !== undefined && (GONE_STATUSES.has(status) || (status === 403 && isFcmEndpoint(endpoint)));
function isFcmEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname.toLowerCase() === "fcm.googleapis.com";
  } catch {
    return false;
  }
}
/**
 * Other refusals that point at the subscription (a 4xx, but not 401, which
 * is our own VAPID header, 413, our payload, or 429, a rate limit): deleted
 * after this many in a row. Server errors and timeouts are the push
 * service's problem and don't count.
 */
const MAX_CONSECUTIVE_FAILURES = 3;
const countsAsFailure = (status: number | undefined) =>
  status !== undefined && status >= 400 && status < 500 && ![401, 413, 429].includes(status);

/** "5+0", "3+2", "0.5+0": minutes plus the increment in seconds */
export function timeControlLabel(timeSeconds: number, increment: number): string {
  const minutes = Math.round((timeSeconds / 60) * 100) / 100;
  return `${minutes}+${increment}`;
}

/** A starting clock in words: "5 min", "30 sec", "1.5 min" */
export function clockLabel(timeSeconds: number): string {
  if (timeSeconds < 60) return `${timeSeconds} sec`;
  return `${Math.round((timeSeconds / 60) * 100) / 100} min`;
}

/**
 * Web push notifications: what reaches a user whose tab is in the
 * background or closed. Off (every method is a no-op or says so) unless
 * VAPID keys are configured.
 */
export class PushService {
  private sender: PushSender | null;
  readonly publicKey: string | null;

  constructor(
    private fastify: FastifyInstance,
    options: { publicKey: string | null; sender: PushSender | null }
  ) {
    this.sender = options.sender;
    this.publicKey = options.sender ? options.publicKey : null;
  }

  get enabled(): boolean {
    return this.sender !== null;
  }

  /** Saves this browser's subscription for the user (taking it over from whoever had it). */
  async subscribe(userId: number, subscription: StoredSubscription): Promise<void> {
    if (!this.enabled) throw new AppError("Push notifications aren't available", "PUSH_UNAVAILABLE", 503);
    if (!isPushServiceEndpoint(subscription.endpoint)) {
      throw new AppError("This browser's push service isn't supported", "PUSH_ENDPOINT_NOT_ALLOWED", 400);
    }
    await this.fastify.pg.query(
      `INSERT INTO push_subscriptions ("userId", endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET
         "userId" = EXCLUDED."userId", p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [userId, subscription.endpoint, subscription.p256dh, subscription.auth]
    );
    await this.fastify.pg.query(
      `DELETE FROM push_subscriptions WHERE "userId" = $1 AND id NOT IN (
         SELECT id FROM push_subscriptions WHERE "userId" = $1 ORDER BY id DESC LIMIT $2)`,
      [userId, MAX_SUBSCRIPTIONS_PER_USER]
    );
  }

  /** Removes one of the user's own subscriptions (they turned notifications off, or signed out). */
  async unsubscribe(userId: number, endpoint: string): Promise<void> {
    await this.fastify.pg.query(`DELETE FROM push_subscriptions WHERE "userId" = $1 AND endpoint = $2`, [
      userId,
      endpoint,
    ]);
  }

  /**
   * Sends a notification to every browser the user turned them on in. Never
   * throws and is safe not to await: a notification is extra, on top of what
   * the sockets already deliver. Skipped when the user had one with the same
   * tag within `dedupeSeconds`, or too many of any kind this minute (see
   * PUSH_LIMITS). Subscriptions the push service says are gone are deleted.
   */
  async notify(
    userId: number,
    payload: PushPayload,
    ttlSeconds = 60 * 60,
    options: { dedupeSeconds?: number } = {}
  ): Promise<void> {
    const sender = this.sender;
    if (!sender) return;
    try {
      const { rows } = await this.fastify.pg.query<StoredSubscription & { id: number; failures: number }>(
        `SELECT id, endpoint, p256dh, auth, failures FROM push_subscriptions WHERE "userId" = $1`,
        [userId]
      );
      // Most users have no subscription: nothing to count for them
      if (rows.length === 0) return;
      if (!(await this.admit(userId, payload.tag, options.dedupeSeconds ?? PUSH_LIMITS.DEFAULT_DEDUPE_SECONDS))) {
        return;
      }
      const body = JSON.stringify(payload);
      await Promise.all(
        rows.map(async (subscription) => {
          try {
            await sender(subscription, body, ttlSeconds);
            if (subscription.failures > 0) {
              await this.fastify.pg.query(`UPDATE push_subscriptions SET failures = 0 WHERE id = $1`, [
                subscription.id,
              ]);
            }
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (isGone(status, subscription.endpoint)) {
              await this.fastify.pg.query(`DELETE FROM push_subscriptions WHERE id = $1`, [subscription.id]);
              return;
            }
            if (countsAsFailure(status)) {
              const { rows: bumped } = await this.fastify.pg.query<{ failures: number }>(
                `UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1 RETURNING failures`,
                [subscription.id]
              );
              if ((bumped[0]?.failures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
                await this.fastify.pg.query(`DELETE FROM push_subscriptions WHERE id = $1`, [subscription.id]);
                return;
              }
            }
            // The endpoint is a secret address: log only where it lives
            this.fastify.log.warn(
              { status, host: new URL(subscription.endpoint).hostname, userId },
              "Push notification failed"
            );
          }
        })
      );
    } catch (err) {
      this.fastify.log.error({ err, userId }, "Sending push notifications failed");
    }
  }

  /**
   * Whether a notification with this tag may go to the user now (see
   * PUSH_LIMITS), counting it if so. The dedupe check comes first, so a
   * duplicate doesn't use up the per-minute allowance; if the per-minute
   * limit then turns it away, its tag is released again, so the same
   * notification can still go out once the burst is over (a friend request
   * would otherwise stay silent for its whole day-long window).
   */
  private async admit(userId: number, tag: string, dedupeSeconds: number): Promise<boolean> {
    const dedupeKey = `push:sent:${userId}:${tag}`;
    const first = await this.fastify.redis.set(dedupeKey, "1", {
      condition: "NX",
      expiration: { type: "EX", value: dedupeSeconds },
    });
    if (first === null) return false;
    const { max, windowSeconds } = PUSH_LIMITS.RECIPIENT_LIMIT;
    let allowed = false;
    try {
      allowed = await withinLimit(this.fastify.redis, `push:rate:${userId}`, max, windowSeconds);
    } finally {
      if (!allowed) await this.fastify.redis.del(dedupeKey).catch(() => {});
    }
    return allowed;
  }
}
