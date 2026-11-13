import type { FastifyInstance } from "fastify";
import { wsAuthHook } from "../../middleware/wsAuth.js";
import { topics } from "../../realtime/hub.js";
import { keepAuthenticated, onValidatedMessage, sendError, sendJson } from "../../realtime/socket.js";
import {
  matchmakingClientMessageSchema,
  matchmakingQuerySchema,
} from "../../schemas/wsSchemas.js";
import { AppError } from "../../errors/AppError.js";

export async function matchmakingWebSocketRoute(fastify: FastifyInstance) {
  const { hub, matchmaking } = fastify;

  fastify.get("/matchmaking", { websocket: true, preValidation: wsAuthHook }, async (socket, request) => {
    const user = request.wsUser!;
    keepAuthenticated(socket, {
      clerkId: user.clerkId,
      verifyToken: (token) => fastify.authProvider.verifyToken(token),
      log: request.log,
    });

    const query = matchmakingQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(socket, "Invalid time control", "INVALID_TIME_CONTROL");
      socket.close();
      return;
    }
    const { time, increment } = query.data;

    let requestId: number | null = null;
    let closed = false;
    const leaveQueue = async () => {
      if (requestId !== null) await matchmaking.cancel(requestId);
      requestId = null;
    };

    onValidatedMessage(socket, matchmakingClientMessageSchema, request.log, async () => {
      await leaveQueue();
      socket.close();
    });
    socket.on("close", () => {
      closed = true;
      leaveQueue().catch((err) => request.log.error({ err }, "Failed to leave matchmaking"));
    });

    await hub.attach(socket, {
      userId: user.id,
      topics: [topics.matchmaking(user.id)],
      presence: "matchmaking",
    });

    try {
      const entry = await matchmaking.enqueue(user.id, time, increment);
      requestId = entry.id;
      // The player left while we were adding them: the close handler ran
      // before requestId was set, so take them back out here.
      if (closed) {
        await leaveQueue();
        return;
      }
      sendJson(socket, {
        type: "searching",
        data: { message: "Searching for opponent...", time, increment, rating: entry.rating },
      });
      await matchmaking.tryMatch(entry.id);
    } catch (error) {
      if (!(error instanceof AppError)) request.log.error({ err: error }, "Matchmaking failed");
      sendError(
        socket,
        error instanceof AppError ? error.message : "Matchmaking failed",
        error instanceof AppError ? error.code : undefined
      );
      socket.close();
    }
  });
}
