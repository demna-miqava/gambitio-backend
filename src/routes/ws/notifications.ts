import type { FastifyInstance } from "fastify";
import { authenticateWebSocket } from "../../middleware/wsAuth.js";
import { ChallengeHandler } from "../../handlers/challengeHandler.js";
import { notificationConnectionManager } from "../../utils/wsConnectionManager.js";
import type { NotificationMessage } from "../../models/NotificationWebSocket.js";

export async function notificationWebSocketRoute(fastify: FastifyInstance) {
  const challengeHandler = new ChallengeHandler(fastify);

  fastify.get<{
    Querystring: { userId?: string };
  }>("/notifications", { websocket: true }, async (socket, request) => {
    // Step 1: Authenticate user via WebSocket middleware
    const decoded = await authenticateWebSocket(request, socket);
    if (!decoded) return;

    const userId = decoded.userId;
    const username = decoded.username;

    // Step 2: Fetch user's avatar URL from database
    let avatarUrl: string = "";
    const client = await fastify.pg.connect();
    try {
      const { rows } = await client.query(
        `SELECT "avatarUrl" FROM users WHERE id = $1`,
        [userId]
      );
      if (rows[0]) {
        avatarUrl = rows[0].avatarUrl || "";
      }
    } finally {
      client.release();
    }

    // Step 3: Register the WebSocket connection for this user
    notificationConnectionManager.addConnection(userId, socket);
    fastify.log.info(
      { userId, username },
      "User connected to notifications WebSocket"
    );

    // Step 4: Handle incoming messages from the client
    socket.on("message", async (rawMessage: Buffer) => {
      try {
        const message: NotificationMessage = JSON.parse(rawMessage.toString());
        fastify.log.info(
          { userId, messageType: message.type },
          "Received notification message"
        );

        switch (message.type) {
          case "challenge_sent":
            // User is sending a challenge to another user
            if (!message.data) {
              const errorMsg: NotificationMessage = {
                type: "error",
                data: { message: "Invalid challenge data" },
              };
              socket.send(JSON.stringify(errorMsg));
              return;
            }

            await challengeHandler.handleChallengeSent(
              userId,
              username,
              avatarUrl,
              message.data
            );
            break;

          case "challenge_declined":
            // User is declining a challenge they received
            if (!message.data) {
              const errorMsg: NotificationMessage = {
                type: "error",
                data: { message: "Invalid challenge decline data" },
              };
              socket.send(JSON.stringify(errorMsg));
              return;
            }

            await challengeHandler.handleChallengeDeclined(
              userId,
              message.data
            );
            break;

          case "challenge_accepted":
            // User is accepting a challenge they received
            if (!message.data) {
              const errorMsg: NotificationMessage = {
                type: "error",
                data: { message: "Invalid challenge accept data" },
              };
              socket.send(JSON.stringify(errorMsg));
              return;
            }

            await challengeHandler.handleChallengeAccepted(
              userId,
              message.data
            );
            break;

          default:
            // Unknown message type
            fastify.log.warn(
              { userId, messageType: message.type },
              "Unknown message type"
            );
            const errorMsg: NotificationMessage = {
              type: "error",
              data: { message: "Unknown message type" },
            };
            socket.send(JSON.stringify(errorMsg));
        }
      } catch (error) {
        fastify.log.error(
          { error, userId },
          "Error handling notification message"
        );
        const errorMsg: NotificationMessage = {
          type: "error",
          data: {
            message: error instanceof Error ? error.message : "Unknown error",
          },
        };
        socket.send(JSON.stringify(errorMsg));
      }
    });

    // Step 5: Handle client disconnect
    socket.on("close", () => {
      notificationConnectionManager.removeConnection(userId);
      fastify.log.info(
        { userId, username },
        "User disconnected from notifications WebSocket"
      );
    });

    // Step 6: Handle WebSocket errors
    socket.on("error", (error: Error) => {
      fastify.log.error({ error, userId }, "Notification WebSocket error");

      notificationConnectionManager.removeConnection(userId);
    });
  });
}
