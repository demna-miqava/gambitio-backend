import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { z } from "zod";
import { AppError } from "../errors/AppError.js";
import { gameClientMessageSchema } from "../schemas/wsSchemas.js";

export function sendJson(socket: WebSocket, message: object): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/**
 * `request` is the client message the error answers, so a client with
 * several requests in flight can tell which one failed.
 */
export function sendError(socket: WebSocket, message: string, code?: string, request?: unknown): void {
  sendJson(socket, {
    type: "error",
    data: { message, ...(code ? { code } : {}), ...(request !== undefined ? { request } : {}) },
  });
}

const BUCKET_SIZE = 20;
const REFILL_PER_SECOND = 10;

/**
 * Every socket a user holds on this instance also draws from one shared
 * bucket, so opening more sockets (up to MAX_SOCKETS_PER_USER) doesn't
 * multiply what one account may send. Kept in memory per instance: a game's
 * sockets all go to one instance (by game id) and a user's other sockets go
 * by IP, so one person's sockets are normally all on the same instance; one
 * spread over several instances gets this allowance on each.
 *
 * Sized so a real player never meets it: a bullet game with premoves, a
 * study room and the notifications socket together can't send more than
 * their own per-socket limits allow (10/s each), well under the refill.
 * Game-socket messages (moves, resign...) may use the whole bucket, the other
 * sockets only what is above USER_GAME_RESERVE, so a busy study tab or a
 * misbehaving extra tab can never starve the moves of a live game.
 */
const USER_BUCKET_SIZE = 60;
const USER_REFILL_PER_SECOND = 30;
const USER_GAME_RESERVE = 20;

interface UserBucket {
  tokens: number;
  lastRefill: number;
  /** Sockets sharing this bucket; it is dropped when the last one closes */
  sockets: number;
}

const userBuckets = new Map<string, UserBucket>();

/** Number of users with a shared message bucket (tests and logs). */
export function userBucketCount(): number {
  return userBuckets.size;
}

function takeUserToken(bucket: UserBucket, now: number, reserved: boolean): boolean {
  bucket.tokens = Math.min(
    USER_BUCKET_SIZE,
    bucket.tokens + ((now - bucket.lastRefill) / 1000) * USER_REFILL_PER_SECOND
  );
  bucket.lastRefill = now;
  if (bucket.tokens < (reserved ? 1 : USER_GAME_RESERVE + 1)) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * What the two message listeners of a socket share (onValidatedMessage and
 * keepAuthenticated): the socket's owner, for the per-user bucket, and one
 * "message" listener that parses each message once and hands it to both.
 */
interface SocketChannel {
  /** Set by keepAuthenticated, which every socket route calls first */
  userBucket?: UserBucket;
  onAuth?: (json: { type: "auth"; token?: unknown }) => void;
  /** `json` is undefined when the message wasn't valid JSON */
  onMessage?: (json: unknown, receivedAt: number) => void;
}

const channels = new WeakMap<WebSocket, SocketChannel>();

function channelOf(socket: WebSocket): SocketChannel {
  let channel = channels.get(socket);
  if (!channel) {
    const created: SocketChannel = {};
    channel = created;
    channels.set(socket, created);
    socket.on("message", (raw: Buffer) => {
      const receivedAt = Date.now();
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        json = undefined;
      }
      created.onMessage?.(json, receivedAt);
      if (isAuthMessage(json)) created.onAuth?.(json);
    });
  }
  return channel;
}

/** Shares a per-user bucket with the user's other sockets on this instance, until the socket closes. */
function joinUserBucket(socket: WebSocket, channel: SocketChannel, userKey: string): void {
  if (channel.userBucket) return;
  let bucket = userBuckets.get(userKey);
  if (!bucket) {
    bucket = { tokens: USER_BUCKET_SIZE, lastRefill: Date.now(), sockets: 0 };
    userBuckets.set(userKey, bucket);
  }
  bucket.sockets += 1;
  channel.userBucket = bucket;
  const joined = bucket;
  socket.once("close", () => {
    joined.sockets -= 1;
    if (joined.sockets <= 0 && userBuckets.get(userKey) === joined) userBuckets.delete(userKey);
  });
}

/** The `type` of a dropped message (not the whole thing: it wasn't validated). */
function droppedRequest(json: unknown): { type: string } | undefined {
  const type = typeof json === "object" && json !== null ? (json as { type?: unknown }).type : undefined;
  return typeof type === "string" ? { type: type.slice(0, 40) } : undefined;
}

/**
 * Wires a socket's messages to a handler: parses JSON, validates against the
 * schema, rate-limits (a token bucket per socket, plus the user's shared
 * bucket: see USER_BUCKET_SIZE), and turns thrown errors into error
 * messages. AppError messages are shown to the client; others are logged and
 * reported as a generic failure.
 */
export function onValidatedMessage<S extends z.ZodType>(
  socket: WebSocket,
  schema: S,
  log: FastifyBaseLogger,
  /** `receivedAt`: when the message arrived, before waiting its turn */
  handler: (message: z.infer<S>, meta: { receivedAt: number }) => Promise<void>,
  options: {
    /**
     * May use the part of the user's bucket kept back from other sockets.
     * Defaults to true for live-game sockets (moves must never be starved).
     */
    reserved?: boolean;
  } = {}
): void {
  const reserved = options.reserved ?? (schema as z.ZodType) === gameClientMessageSchema;
  const channel = channelOf(socket);
  let tokens = BUCKET_SIZE;
  let lastRefill = Date.now();
  // Messages from one socket are handled in order
  let queue = Promise.resolve();

  channel.onMessage = (json, now) => {
    tokens = Math.min(BUCKET_SIZE, tokens + ((now - lastRefill) / 1000) * REFILL_PER_SECOND);
    lastRefill = now;

    // Parsed first (cheap: payloads are capped) so the client learns which
    // message was dropped, e.g. a resign it should send again
    const allowed = tokens >= 1 && (!channel.userBucket || takeUserToken(channel.userBucket, now, reserved));
    if (!allowed) {
      // Invalid JSON over the limit gets no answer: answering would itself be unlimited
      if (json !== undefined) sendError(socket, "Too many messages", "RATE_LIMITED", droppedRequest(json));
      return;
    }
    tokens -= 1;
    if (json === undefined) {
      sendError(socket, "Invalid JSON", "INVALID_MESSAGE");
      return;
    }
    // Session refreshes are handled by keepAuthenticated
    if (isAuthMessage(json)) return;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      sendError(socket, "Invalid message", "INVALID_MESSAGE");
      return;
    }

    queue = queue.then(async () => {
      try {
        await handler(parsed.data, { receivedAt: now });
      } catch (error) {
        if (error instanceof AppError) {
          sendError(socket, error.message, error.code, parsed.data);
        } else {
          log.error({ err: error }, "WebSocket handler failed");
          sendError(socket, "Something went wrong", "INTERNAL_ERROR", parsed.data);
        }
      }
    });
  };

  socket.on("error", (err) => log.warn({ err }, "WebSocket error"));
}

/**
 * How long a socket stays open on one session token. The client sends a
 * fresh one ({ type: "auth", token }) every few minutes; a socket that
 * hasn't by the deadline is closed, so a signed-out or revoked session
 * doesn't keep a socket alive. Mutable so tests can shorten it.
 */
export const reauthTimings = {
  validForMs: 10 * 60_000,
  checkEveryMs: 60_000,
  /** Auth messages closer together than this are ignored (see keepAuthenticated) */
  minIntervalMs: 1_000,
};

function isAuthMessage(json: unknown): json is { type: "auth"; token?: unknown } {
  return typeof json === "object" && json !== null && (json as { type?: unknown }).type === "auth";
}

/**
 * Closes the socket once its session lapses; see reauthTimings. Every socket
 * route calls this first, before onValidatedMessage: it also records whose
 * socket it is, so its messages count against the user's shared bucket.
 */
export function keepAuthenticated(
  socket: WebSocket,
  options: {
    clerkId: string;
    verifyToken: (token: string) => Promise<string | null>;
    log: FastifyBaseLogger;
  }
): void {
  let validUntil = Date.now() + reauthTimings.validForMs;
  const expire = (reason: string) => socket.close(4001, reason);
  // One verification at a time, and at most one per minIntervalMs:
  // auth messages skip the message rate limit's handler, so without this a
  // client could make the server verify tokens without end
  let verifying = false;
  let lastVerifiedAt = 0;

  const channel = channelOf(socket);
  joinUserBucket(socket, channel, options.clerkId);
  channel.onAuth = (json) => {
    const token = typeof json.token === "string" ? json.token : null;
    if (!token || token.length > 8192) return expire("Invalid session");
    if (verifying || Date.now() - lastVerifiedAt < reauthTimings.minIntervalMs) return;
    verifying = true;
    lastVerifiedAt = Date.now();
    options
      .verifyToken(token)
      .then((clerkId) => {
        // Another user's token can't take over this socket
        if (clerkId !== options.clerkId) return expire("Invalid session");
        validUntil = Date.now() + reauthTimings.validForMs;
      })
      .catch((err) => options.log.warn({ err }, "Socket re-authentication failed"))
      .finally(() => {
        verifying = false;
      });
  };

  const timer = setInterval(() => {
    if (Date.now() > validUntil) expire("Session expired");
  }, reauthTimings.checkEveryMs);
  timer.unref();
  socket.on("close", () => clearInterval(timer));
}
