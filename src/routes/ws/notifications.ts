import type { FastifyInstance } from "fastify";
import { wsAuthHook } from "../../middleware/wsAuth.js";
import { topics } from "../../realtime/hub.js";
import { keepAuthenticated, onValidatedMessage, sendJson } from "../../realtime/socket.js";
import { notificationClientMessageSchema } from "../../schemas/wsSchemas.js";
import { AppError } from "../../errors/AppError.js";

export async function notificationWebSocketRoute(fastify: FastifyInstance) {
  const { hub, challenges } = fastify;

  fastify.get("/notifications", { websocket: true, preValidation: wsAuthHook }, async (socket, request) => {
    const user = request.wsUser!;
    keepAuthenticated(socket, {
      clerkId: user.clerkId,
      verifyToken: (token) => fastify.authProvider.verifyToken(token),
      log: request.log,
    });

    onValidatedMessage(
      socket,
      notificationClientMessageSchema,
      request.log,
      async (message) => {
        try {
          switch (message.type) {
            case "challenge_sent":
              return await challenges.send(user, message.data);
            case "challenge_declined":
              return await challenges.decline(user.id, message.data.challengerId);
            case "challenge_accepted":
              return await challenges.accept(user.id, message.data.challengerId);
            case "challenge_cancelled":
              return await challenges.cancel(user.id, message.data.challengedId);
          }
        } catch (error) {
          // The client shows a dedicated message for an unavailable opponent
          if (error instanceof AppError && error.code === "OPPONENT_UNAVAILABLE") {
            sendJson(socket, { type: "opponent_unavailable", data: { request: message } });
            return;
          }
          throw error;
        }
      }
    );

    await hub.attach(socket, {
      userId: user.id,
      topics: [topics.notifications(user.id)],
      presence: "notifications",
      // A challenge can't be accepted once its sender is offline, so withdraw
      // it when their last notifications socket closes, after a grace period
      // that covers a page reload or a quick reconnect
      onDetach: async () => challenges.withdrawIfStillOffline(user.id),
    });
  });
}
