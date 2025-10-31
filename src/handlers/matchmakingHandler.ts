import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { MatchmakingService } from "../services/matchmakingService.js";
import { ChallengeService } from "../services/challengeService.js";
import type { MatchmakingMessage } from "../models/Matchmaking.js";
import { getTimeControl } from "../models/Matchmaking.js";
import { matchmakingConnectionManager } from "../utils/wsConnectionManager.js";

export class MatchmakingHandler {
  private matchmakingService: MatchmakingService;
  private challengeService: ChallengeService;

  constructor(private fastify: FastifyInstance) {
    this.matchmakingService = new MatchmakingService(fastify);
    this.challengeService = new ChallengeService(fastify);
  }

  /**
   * Find a match for the user
   */
  async findMatch(
    socket: WebSocket,
    userId: number,
    username: string,
    avatarUrl: string,
    userRating: { bullet: number; blitz: number; rapid: number },
    time: number,
    increment: number | null
  ): Promise<void> {
    // Determine time control and get appropriate rating
    const timeControl = getTimeControl(time);
    const rating =
      timeControl === "bullet"
        ? userRating.bullet
        : timeControl === "blitz"
        ? userRating.blitz
        : userRating.rapid;

    // Try to find an existing match
    const existingMatch =
      await this.matchmakingService.findMatchWithExpandingRange(
        time,
        increment ?? null,
        rating,
        userId
      );

    if (existingMatch) {
      await this.createGameAndNotifyPlayers(
        socket,
        existingMatch.id,
        existingMatch.userId,
        userId,
        username,
        avatarUrl,
        rating,
        time,
        increment ?? null,
        timeControl
      );
    } else {
      // No match found, create matchmaking request
      await this.matchmakingService.createMatchmakingRequest(
        userId,
        rating,
        time,
        increment ?? null
      );

      const searchingMsg: MatchmakingMessage = {
        type: "searching",
        data: {
          message: "Searching for opponent...",
          time,
          increment: increment ?? null,
          rating,
        },
      };
      socket.send(JSON.stringify(searchingMsg));
    }
  }

  /**
   * Create game and notify both players
   */
  private async createGameAndNotifyPlayers(
    currentUserSocket: WebSocket,
    matchmakingId: number,
    opponentUserId: number,
    currentUserId: number,
    currentUsername: string,
    currentUserAvatar: string,
    currentUserRating: number,
    time: number,
    increment: number | null,
    timeControl: string
  ): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      // Get opponent's info
      const { rows: opponentRows } = await client.query(
        `SELECT username, "avatarUrl", "${timeControl}Rating" as rating
         FROM users WHERE id = $1`,
        [opponentUserId]
      );
      const opponent = opponentRows[0];

      // Randomly assign white/black
      const isCurrentUserWhite = Math.random() < 0.5;
      const whiteId = isCurrentUserWhite ? currentUserId : opponentUserId;
      const blackId = isCurrentUserWhite ? opponentUserId : currentUserId;
      const whiteUsername = isCurrentUserWhite
        ? currentUsername
        : opponent.username;
      const blackUsername = isCurrentUserWhite
        ? opponent.username
        : currentUsername;
      const whiteRating = isCurrentUserWhite
        ? currentUserRating
        : opponent.rating;
      const blackRating = isCurrentUserWhite
        ? opponent.rating
        : currentUserRating;
      const whiteAvatarUrl = isCurrentUserWhite
        ? currentUserAvatar
        : opponent.avatarUrl;
      const blackAvatarUrl = isCurrentUserWhite
        ? opponent.avatarUrl
        : currentUserAvatar;

      // Create game in database
      const { rows: gameRows } = await client.query(
        `INSERT INTO games (
          "whiteId", "blackId", "whiteUsername", "blackUsername",
          "whiteRating", "blackRating", "whiteAvatarUrl", "blackAvatarUrl",
          time, increment, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'in_progress')
        RETURNING id`,
        [
          whiteId,
          blackId,
          whiteUsername,
          blackUsername,
          whiteRating,
          blackRating,
          whiteAvatarUrl,
          blackAvatarUrl,
          time,
          increment,
        ]
      );
      const gameId = gameRows[0].id;

      // Remove matchmaking request
      await this.matchmakingService.deleteMatchmakingRequest(matchmakingId);

      // Delete all challenges for both users (they're starting a game)
      await this.challengeService.deleteAllUserChallenges(currentUserId);
      await this.challengeService.deleteAllUserChallenges(opponentUserId);

      // Send match found to current user
      const currentUserMsg: MatchmakingMessage = {
        type: "match_found",
        data: {
          gameId,
          opponentId: opponentUserId,
          opponentUsername: opponent.username,
          opponentRating: opponent.rating,
          rating: currentUserRating,
          time,
          increment,
          color: isCurrentUserWhite ? "white" : "black",
        },
      };
      currentUserSocket.send(JSON.stringify(currentUserMsg));

      // Send match found to opponent
      const opponentMsg: MatchmakingMessage = {
        type: "match_found",
        data: {
          gameId,
          opponentId: currentUserId,
          opponentUsername: currentUsername,
          opponentRating: currentUserRating,
          rating: opponent.rating,
          time,
          increment,
          color: isCurrentUserWhite ? "black" : "white",
        },
      };
      matchmakingConnectionManager.sendToUser(
        opponentUserId,
        JSON.stringify(opponentMsg)
      );
    } finally {
      client.release();
    }
  }

  /**
   * Clean up when user disconnects
   */
  async handleDisconnect(userId: number): Promise<void> {
    await this.matchmakingService.cancelMatchmaking(userId);
    matchmakingConnectionManager.removeConnection(userId);
  }
}
