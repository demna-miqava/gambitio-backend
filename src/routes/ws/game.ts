import type { FastifyInstance } from "fastify";
import { wsAuthHook } from "../../middleware/wsAuth.js";
import { topics } from "../../realtime/hub.js";
import { keepAuthenticated, limitedSync, onValidatedMessage, sendError, sendJson } from "../../realtime/socket.js";
import { gameClientMessageSchema } from "../../schemas/wsSchemas.js";
import { AppError } from "../../errors/AppError.js";
import { spectatorsKey } from "../../services/liveGameService.js";
import { CLIENT_RTT_HEADER, parseClientRtt, RttProbe } from "./rttProbe.js";

export async function gameWebSocketRoute(fastify: FastifyInstance) {
  const { hub, liveGames, gameChat, spectatorChat } = fastify;

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
      if (!Number.isInteger(gameId) || gameId <= 0 || gameId > 2_147_483_647) {
        sendError(socket, "Invalid game id", "INVALID_GAME_ID");
        socket.close();
        return;
      }

      // Cloudflare's TCP round trip to this browser, from the Worker
      const tcpRttMs = parseClientRtt(request.headers[CLIENT_RTT_HEADER]);
      // Set while this socket is a player's in a game in progress (see sendState)
      let probe: RttProbe | null = null;
      let detachPlayer: (() => void) | null = null;
      socket.once("close", () => {
        probe?.stop();
        detachPlayer?.();
      });

      // Whether this socket's user is one of the game's two players, known
      // once the state has been read on connect (a game's players never
      // change). False if that read fails: the socket is closed then.
      let knownPlayer!: (isPlayer: boolean) => void;
      const isPlayerSocket = new Promise<boolean>((resolve) => {
        knownPlayer = resolve;
      });
      // Whatever happens on the way, a closed socket's messages don't wait
      socket.once("close", () => knownPlayer(false));
      const syncState = limitedSync(socket, request.log, () => sendState());

      // Register before anything async so no message is missed. Anyone may
      // watch; only the two players can act. LiveGameService checks that
      // too, but only after it has locked the game's row: a spectator
      // sending actions in a loop would hold that lock over and over, which
      // delays the players' moves and ties up database connections. So
      // everything but "sync" is refused here for a socket that isn't a
      // player's, before the database is touched.
      onValidatedMessage(socket, gameClientMessageSchema, request.log, async (message, { receivedAt }) => {
        const userId = user.id;
        // The one thing only someone who isn't playing can send (the
        // insert checks again, against the game's row)
        if (message.type === "spectator_chat") {
          if (await isPlayerSocket) {
            throw new AppError("Players can't use the spectator chat", "NOT_A_SPECTATOR", 403);
          }
          return spectatorChat.send(gameId, userId, message.text);
        }
        if (message.type !== "sync" && !(await isPlayerSocket)) {
          throw new AppError("You are not a player in this game", "NOT_A_PLAYER", 403);
        }
        switch (message.type) {
          case "move":
            // Timed from arrival: queueing and database work don't cost the
            // player. The round trip is the server's own measure (see
            // MAX_LAG_COMPENSATION_MS)
            return liveGames.move(gameId, userId, message.move, {
              receivedAt,
              thinkMs: message.thinkMs,
              ply: message.ply,
              measuredRttMs: probe ? probe.measuredMs : tcpRttMs,
              rttSources: { pingMs: probe?.pingMs, tcpMs: tcpRttMs },
            });
          case "resign":
            return liveGames.resign(gameId, userId);
          case "abort":
            return liveGames.abort(gameId, userId);
          case "draw_offer":
            return liveGames.offerDraw(gameId, userId);
          case "draw_response":
            return liveGames.respondToDraw(gameId, userId, message.accepted);
          case "takeback_request":
            return liveGames.requestTakeback(gameId, userId);
          case "takeback_response":
            return liveGames.respondToTakeback(gameId, userId, message.accepted);
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
            return syncState();
          case "chat":
            return gameChat.send(gameId, userId, message.text);
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
       * the state goes out, so the count they see includes them; the count
       * is returned so it isn't read again for the broadcast.
       */
      async function sendState(onConnect = false): Promise<number | undefined> {
        const state = await liveGames.getState(gameId, user.id);
        const { data } = state;
        const isPlayer = user.id === data.whitePlayer.id || user.id === data.blackPlayer.id;
        knownPlayer(isPlayer);
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
        // A player's socket in a game in progress: measure its round trip,
        // and count the game as played here (it is paused if this server
        // shuts down). Not if the socket closed while the state was loading
        if (isPlayer && live && !probe && socket.readyState === socket.OPEN) {
          probe = new RttProbe(socket, tcpRttMs);
          probe.start();
          detachPlayer = liveGames.attachPlayer(gameId, probe);
        }
        const spectators = live ? await liveGames.spectatorCount(gameId).catch(() => undefined) : undefined;
        // Chat is between the players: spectators get none of it. A failure
        // here leaves the game without chat rather than without a board
        const chat = isPlayer
          ? await gameChat.state(gameId, user.id).catch((err) => {
              request.log.error({ err }, "Failed to load game chat");
              return null;
            })
          : null;
        // Spectator chat is for everyone but the players, while the game is
        // on and after: only a non-player's socket is subscribed to it, and
        // only then is its history read (state() is null for a player
        // anyway). Subscribed first, so a message sent while the history is
        // read isn't missed (the client drops a repeat by id)
        let spectatorChatState = null;
        if (!isPlayer && hub.subscribe(socket, topics.spectatorChat(gameId))) {
          spectatorChatState = await spectatorChat.state(gameId, user.id).catch((err) => {
            request.log.error({ err }, "Failed to load spectator chat");
            return null;
          });
        }
        sendJson(socket, {
          ...state,
          data: {
            ...data,
            spectators,
            ...(chat && { chat }),
            ...(spectatorChatState && { spectatorChat: spectatorChatState }),
          },
        });
        return spectators;
      }

      try {
        const spectators = await sendState(true);
        if (spectating) await liveGames.publishSpectatorCount(gameId, spectators);
      } catch (error) {
        knownPlayer(false);
        sendError(socket, error instanceof AppError ? error.message : "Failed to load game");
        socket.close();
      }
    }
  );
}
