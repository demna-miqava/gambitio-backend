import type { FastifyInstance } from "fastify";
import { wsAuthHook } from "../../middleware/wsAuth.js";
import { topics } from "../../realtime/hub.js";
import { keepAuthenticated, onValidatedMessage, sendError, sendJson } from "../../realtime/socket.js";
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
    keepAuthenticated(socket, {
      clerkId: user.clerkId,
      verifyToken: (token) => fastify.authProvider.verifyToken(token),
      log: request.log,
    });

      const gameId = Number(request.params.id);
      if (!Number.isInteger(gameId) || gameId <= 0) {
        sendError(socket, "Invalid game id", "INVALID_GAME_ID");
        socket.close();
        return;
      }

      // Register before anything async so no message is missed. Anyone may
      // watch; only the two players can act (checked by LiveGameService).
      onValidatedMessage(socket, gameClientMessageSchema, request.log, async (message, { receivedAt }) => {
        const userId = user.id;
        switch (message.type) {
          case "move":
            // Timed from arrival: queueing and database work don't cost the player
            return liveGames.move(gameId, userId, message.move, {
              receivedAt,
              thinkMs: message.thinkMs,
            });
          case "resign":
            return liveGames.resign(gameId, userId);
          case "abort":
            return liveGames.abort(gameId, userId);
          case "draw_offer":
            return liveGames.offerDraw(gameId, userId);
          case "draw_response":
            return liveGames.respondToDraw(gameId, userId, message.accepted);
          case "timeout":
            return liveGames.claimTimeout(gameId, userId);
          case "give_time":
            return liveGames.giveTime(gameId, userId);
          case "rematch_request":
            return liveGames.requestRematch(gameId, userId);
          case "rematch_response":
            return liveGames.respondToRematch(gameId, userId, message.data.accepted);
          case "cancel_rematch":
            return liveGames.cancelRematch(gameId, userId);
          case "sync":
            await sendState();
            return;
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

      /**
       * Full state for this socket: on connect, and when the client asks
       * ("sync"). On connect, a spectator of a live game is counted before
       * the state goes out, so the count they see includes them.
       */
      async function sendState(onConnect = false): Promise<void> {
        const state = await liveGames.getState(gameId, user.id);
        const { data } = state;
        const isPlayer = user.id === data.whitePlayer.id || user.id === data.blackPlayer.id;
        const live = data.status === "in_progress";
        // Only live games are counted; a finished game is just a replay
        if (onConnect && !isPlayer && live) {
          spectating = await hub
            .addMembership(socket, spectatorsKey(gameId))
            .catch((err) => {
              request.log.error({ err }, "Failed to register spectator");
              return false;
            });
        }
        const spectators = live ? await liveGames.spectatorCount(gameId).catch(() => undefined) : undefined;
        sendJson(socket, { ...state, data: { ...data, spectators } });
      }

      try {
        await sendState(true);
        if (spectating) await liveGames.publishSpectatorCount(gameId);
      } catch (error) {
        sendError(socket, error instanceof AppError ? error.message : "Failed to load game");
        socket.close();
      }
    }
  );
}
