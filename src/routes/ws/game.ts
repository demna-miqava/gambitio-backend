import type { FastifyInstance } from "fastify";
import { wsAuthHook } from "../../middleware/wsAuth.js";
import { topics } from "../../realtime/hub.js";
import { onValidatedMessage, sendError, sendJson } from "../../realtime/socket.js";
import { gameClientMessageSchema } from "../../schemas/wsSchemas.js";
import { AppError } from "../../errors/AppError.js";
import { spectatorsKey } from "../../services/liveGameService.js";

export async function gameWebSocketRoute(fastify: FastifyInstance) {
  const { hub, liveGames } = fastify;

  fastify.get<{ Params: { id: string } }>(
    "/game/:id",
    { websocket: true, preValidation: wsAuthHook },
    async (socket, request) => {
      const user = request.wsUser!;

      const gameId = Number(request.params.id);
      if (!Number.isInteger(gameId) || gameId <= 0) {
        sendError(socket, "Invalid game id", "INVALID_GAME_ID");
        socket.close();
        return;
      }

      // Register before anything async so no message is missed. Anyone may
      // watch; only the two players can act (checked by LiveGameService).
      onValidatedMessage(socket, gameClientMessageSchema, request.log, async (message) => {
        const userId = user.id;
        switch (message.type) {
          case "move":
            return liveGames.move(gameId, userId, message.move);
          case "resign":
            return liveGames.resign(gameId, userId);
          case "abort":
            return liveGames.abort(gameId, userId);
          case "draw_offer":
            return liveGames.offerDraw(gameId, userId);
          case "draw_response":
            return liveGames.respondToDraw(gameId, userId, message.accepted);
          case "timeout":
            return liveGames.resolveDeadline(gameId);
          case "rematch_request":
            return liveGames.requestRematch(gameId, userId);
          case "rematch_response":
            return liveGames.respondToRematch(gameId, userId, message.data.accepted);
          case "cancel_rematch":
            return liveGames.cancelRematch(gameId, userId);
        }
      });

      // Set once this socket counts as a spectator, so leaving updates the count
      let spectating = false;
      await hub.attach(socket, {
        userId: user.id,
        topics: [topics.game(gameId), topics.gameUser(gameId, user.id)],
        onDetach: async () => {
          if (spectating) await liveGames.publishSpectatorCount(gameId);
        },
      });

      try {
        const state = await liveGames.getState(gameId, user.id);
        const { data } = state;
        const isPlayer = user.id === data.whitePlayer.id || user.id === data.blackPlayer.id;
        // Only live games are counted; a finished game is just a replay
        if (!isPlayer && data.status === "in_progress") {
          spectating = await hub
            .addMembership(socket, spectatorsKey(gameId))
            .catch((err) => {
              request.log.error({ err }, "Failed to register spectator");
              return false;
            });
        }
        const spectators =
          data.status === "in_progress"
            ? await liveGames.spectatorCount(gameId).catch(() => undefined)
            : undefined;
        sendJson(socket, { ...state, data: { ...data, spectators } });
        if (spectating) await liveGames.publishSpectatorCount(gameId);
      } catch (error) {
        sendError(socket, error instanceof AppError ? error.message : "Failed to load game");
        socket.close();
      }
    }
  );
}
