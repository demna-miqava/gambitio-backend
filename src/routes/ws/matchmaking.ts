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
      // Set before the socket's "close" event, which comes once the client
      // answers: an entry still being added is taken back out (below), and
      // never paired
      closed = true;
      await leaveQueue();
      socket.close();
    });
    socket.on("close", () => {
      closed = true;
      leaveQueue().catch((err) => request.log.error({ err }, "Failed to leave matchmaking"));
    });

    try {
      // Inside the try: a socket that can't be attached (Redis failing) is
      // told and closed instead of being left open, never searching
      await hub.attach(socket, {
        userId: user.id,
        topics: [topics.matchmaking(user.id)],
        presence: "matchmaking",
      });
      const entry = await matchmaking.enqueue(user.id, time, increment);
      requestId = entry.id;
      // The player left or cancelled while we were adding them: that ran
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
