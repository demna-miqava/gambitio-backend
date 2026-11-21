import type { FastifyInstance } from "fastify";
import { wsAuthHook } from "../../middleware/wsAuth.js";
import { topics } from "../../realtime/hub.js";
import { keepAuthenticated, limitedSync, onValidatedMessage, sendError, sendJson } from "../../realtime/socket.js";
import { tournamentClientMessageSchema } from "../../schemas/wsSchemas.js";
import { AppError } from "../../errors/AppError.js";
import { tournamentPresenceKey } from "../../services/tournamentService.js";
import { tournamentRepository } from "../../repositories/tournamentRepository.js";

/**
 * A tournament's lobby. On connect the viewer gets everything the lobby
 * shows ("state"); after that the standings ("standings") and the
 * tournament itself ("tournament": it started, ended, was called off)
 * arrive as they change, and the games a pairing pass has just started
 * ("pairings": a player finds their own among them, should the message on
 * their notifications socket have missed them). "sync" asks for the whole
 * state again.
 *
 * Holding this socket is also what makes a player count as here: the
 * pairing pass only pairs players in the tournament's presence set
 * (TournamentService.pair). The app keeps it open on the lobby and on the
 * tournament's game pages, so closing either stops the games coming.
 */
export async function tournamentWebSocketRoute(fastify: FastifyInstance) {
  const { hub, tournaments } = fastify;

  fastify.get<{ Params: { id: string } }>(
    "/tournament/:id",
    { websocket: true, preValidation: wsAuthHook },
    async (socket, request) => {
      const user = request.wsUser!;
      keepAuthenticated(socket, {
        clerkId: user.clerkId,
        verifyToken: (token) => fastify.authProvider.verifyToken(token),
        log: request.log,
      });

      const tournamentId = Number(request.params.id);
      const tournament =
        Number.isInteger(tournamentId) && tournamentId > 0 && tournamentId <= 2_147_483_647
          ? await tournamentRepository.find(fastify.pg, tournamentId).catch(() => null)
          : null;
      if (!tournament) {
        sendError(socket, "Tournament not found", "TOURNAMENT_NOT_FOUND");
        socket.close();
        return;
      }
      // Gone while the tournament was being read: nobody to attach, and
      // above all nobody to count as here (see hub.attach)
      if (socket.readyState !== socket.OPEN) return;
      // This instance now has someone in the lobby: its tick covers the
      // tournament even if another instance created it
      tournaments.watch(tournament);

      const sendState = async () =>
        sendJson(socket, { type: "state", data: await tournaments.getState(tournamentId, user.id) });

      onValidatedMessage(socket, tournamentClientMessageSchema, request.log, limitedSync(socket, request.log, sendState));

      await hub.attach(socket, { userId: user.id, topics: [topics.tournament(tournamentId)] });
      await hub.addMembership(socket, tournamentPresenceKey(tournamentId)).catch((err) => {
        request.log.error({ err }, "Failed to register tournament presence");
      });

      try {
        await sendState();
      } catch (error) {
        sendError(socket, error instanceof AppError ? error.message : "Couldn't open the tournament");
        socket.close();
      }
    }
  );
}
