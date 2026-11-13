import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { z } from "zod";
import { AppError } from "../errors/AppError.js";

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
 * Wires a socket's messages to a handler: parses JSON, validates against the
 * schema, rate-limits (token bucket), and turns thrown errors into error
 * messages. AppError messages are shown to the client; others are logged and
 * reported as a generic failure.
 */
export function onValidatedMessage<S extends z.ZodType>(
  socket: WebSocket,
  schema: S,
  log: FastifyBaseLogger,
  handler: (message: z.infer<S>) => Promise<void>
): void {
  let tokens = BUCKET_SIZE;
  let lastRefill = Date.now();
  // Messages from one socket are handled in order
  let queue = Promise.resolve();

  const onMessage = (raw: Buffer) => {
    const now = Date.now();
    tokens = Math.min(BUCKET_SIZE, tokens + ((now - lastRefill) / 1000) * REFILL_PER_SECOND);
    lastRefill = now;
    if (tokens < 1) {
      sendError(socket, "Too many messages", "RATE_LIMITED");
      return;
    }
    tokens -= 1;

    let json: unknown;
    try {
      json = JSON.parse(raw.toString());
    } catch {
      sendError(socket, "Invalid JSON", "INVALID_MESSAGE");
      return;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      sendError(socket, "Invalid message", "INVALID_MESSAGE");
      return;
    }

    queue = queue.then(async () => {
      try {
        await handler(parsed.data);
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

  socket.on("message", onMessage);
  socket.on("error", (err) => log.warn({ err }, "WebSocket error"));
}
