import type { FastifyInstance } from "fastify";
import webpush from "web-push";
import { AppError } from "../errors/AppError.js";

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
  return async (subscription, payload, ttlSeconds) => {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      payload,
      { TTL: ttlSeconds, vapidDetails: vapid, urgency: "high", timeout: 10_000 }
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

/** "5+0", "3+2", "0.5+0": minutes plus the increment in seconds */
export function timeControlLabel(timeSeconds: number, increment: number): string {
  const minutes = Math.round((timeSeconds / 60) * 100) / 100;
  return `${minutes}+${increment}`;
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
   * the sockets already deliver. Subscriptions the push service says are
   * gone are deleted.
   */
  async notify(userId: number, payload: PushPayload, ttlSeconds = 60 * 60): Promise<void> {
    const sender = this.sender;
    if (!sender) return;
    try {
      const { rows } = await this.fastify.pg.query<StoredSubscription>(
        `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE "userId" = $1`,
        [userId]
      );
      const body = JSON.stringify(payload);
      await Promise.all(
        rows.map(async (subscription) => {
          try {
            await sender(subscription, body, ttlSeconds);
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await this.fastify.pg.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [
                subscription.endpoint,
              ]);
              return;
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
}
