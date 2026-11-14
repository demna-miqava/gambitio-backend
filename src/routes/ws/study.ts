import type { FastifyInstance } from "fastify";
import { wsAuthHook } from "../../middleware/wsAuth.js";
import { topics } from "../../realtime/hub.js";
import { keepAuthenticated, onValidatedMessage, sendError, sendJson } from "../../realtime/socket.js";
import { studyClientMessageSchema } from "../../schemas/wsSchemas.js";
import { AppError } from "../../errors/AppError.js";
import { studyPresenceKey } from "../../services/studyService.js";

/**
 * A study room's live channel. On connect the member gets the whole room
 * ("study_state"); after that, changes arrive as small messages that each
 * carry the room's new version. A client whose version doesn't follow on
 * from the last one it saw asks for the whole room again ("sync").
 */
export async function studyWebSocketRoute(fastify: FastifyInstance) {
  const { hub, study } = fastify;

  fastify.get<{ Params: { id: string } }>(
    "/study/:id",
    { websocket: true, preValidation: wsAuthHook },
    async (socket, request) => {
      const user = request.wsUser!;
      keepAuthenticated(socket, {
        clerkId: user.clerkId,
        verifyToken: (token) => fastify.authProvider.verifyToken(token),
        log: request.log,
      });

      const roomId = Number(request.params.id);
      if (!Number.isSafeInteger(roomId) || roomId <= 0) {
        sendError(socket, "Study room not found", "STUDY_NOT_FOUND");
        socket.close();
        return;
      }

      const sendState = async () => {
        const room = await study.get(roomId, user.id);
        sendJson(socket, {
          type: "study_state",
          ...room,
          present: await study.present(roomId).catch(() => [user.id]),
        });
      };

      onValidatedMessage(socket, studyClientMessageSchema, request.log, async (message) => {
        if (message.type === "sync") return sendState();
        await study.apply(roomId, user.id, message);
      });

      try {
        await study.assertMember(roomId, user.id);
      } catch (error) {
        sendError(socket, error instanceof AppError ? error.message : "Couldn't open the room", "STUDY_NOT_FOUND");
        socket.close();
        return;
      }

      await hub.attach(socket, {
        userId: user.id,
        topics: [topics.study(roomId), topics.studyUser(roomId, user.id)],
        onDetach: () => study.publishPresence(roomId),
      });
      await hub.addMembership(socket, studyPresenceKey(roomId)).catch((err) => {
        request.log.error({ err }, "Failed to register study presence");
      });

      try {
        await sendState();
        await study.publishPresence(roomId);
      } catch (error) {
        sendError(socket, error instanceof AppError ? error.message : "Couldn't open the room");
        socket.close();
      }
    }
  );
}
