import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { GameService } from "../services/gameService.js";
import type {
  GameWebSocketMessage,
  MoveMessage,
  DrawOfferMessage,
  DrawResponseMessage,
  CheckmateMessage,
  RematchRequestMessage,
  RematchResponseMessage,
  RematchDeclinedMessage,
  GameEndedMessage,
  InitialGameStateMessage,
  ErrorMessage,
} from "../models/GameWebSocket.js";
import type { MatchmakingMessage } from "../models/Matchmaking.js";
import { gameConnectionManager } from "../utils/wsConnectionManager.js";

// Track draw offers: gameId -> userId who offered
const pendingDrawOffers = new Map<number, number>();

export class GameHandler {
  private gameService: GameService;

  constructor(private fastify: FastifyInstance) {
    this.gameService = new GameService(fastify);
  }

  /**
   * Broadcast message to opponent
   */
  private async broadcastToOpponent(
    gameId: number,
    currentUserId: number,
    message: string
  ): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) return;

    const opponentId =
      currentUserId === game.whiteId ? game.blackId : game.whiteId;
    if (opponentId) {
      gameConnectionManager.sendToUser(opponentId, message);
    }
  }

  /**
   * Send initial game state to player
   */
  async sendInitialGameState(socket: WebSocket, gameId: number): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) {
      const errorMsg: ErrorMessage = {
        type: "error",
        message: "Game not found",
      };
      socket.send(JSON.stringify(errorMsg));
      socket.close();
      return;
    }

    const initialState: InitialGameStateMessage = {
      type: "initial_game_state",
      data: {
        gameId: game.id,
        fen:
          game.fen ||
          "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        pgn: game.pgn,
        whitePlayer: {
          id: game.whiteId,
          username: game.whiteUsername,
          rating: game.whiteRating,
          avatarUrl: game.whiteAvatarUrl,
        },
        blackPlayer: {
          id: game.blackId,
          username: game.blackUsername,
          rating: game.blackRating,
          avatarUrl: game.blackAvatarUrl,
        },
        time: game.time,
        increment: game.increment,
        status: game.status,
        numMoves: game.numMoves,
        isFinished: game.status === "finished",
      },
    };

    socket.send(JSON.stringify(initialState));
  }

  /**
   * Handle incoming game messages
   */
  async handleMessage(
    message: GameWebSocketMessage,
    gameId: number,
    userId: number
  ): Promise<void> {
    switch (message.type) {
      case "move":
        await this.handleMove(message, gameId, userId);
        break;
      case "draw_offer":
        await this.handleDrawOffer(gameId, userId);
        break;
      case "draw_response":
        await this.handleDrawResponse(message, gameId, userId);
        break;
      case "resign":
        await this.handleResign(gameId, userId);
        break;
      case "abort":
        await this.handleAbort(gameId);
        break;
      case "timeout":
        await this.handleTimeout(gameId, userId);
        break;
      case "checkmate":
        await this.handleCheckmate(message, gameId);
        break;
      case "stalemate":
        await this.handleStalemate(gameId);
        break;
      case "rematch_request":
        await this.handleRematchRequest(gameId, userId);
        break;
      case "rematch_response":
        await this.handleRematchResponse(message, gameId, userId);
        break;
      case "cancel_rematch":
        await this.handleCancelRematch(gameId, userId);
        break;
    }
  }

  /**
   * Handle move
   */
  private async handleMove(
    message: MoveMessage,
    gameId: number,
    userId: number
  ): Promise<void> {
    if (!message.fen || !message.pgn || !message.moveNumber) {
      return;
    }

    // Update game in database
    await this.gameService.updateMove(
      gameId,
      message.fen,
      message.pgn,
      message.moveNumber
    );

    // Broadcast move to opponent
    const moveMsg: MoveMessage = {
      type: "move",
      move: message.move,
      fen: message.fen,
      pgn: message.pgn,
      userId,
      moveNumber: message.moveNumber,
    };

    await this.broadcastToOpponent(gameId, userId, JSON.stringify(moveMsg));
  }

  /**
   * Handle draw offer
   */
  private async handleDrawOffer(gameId: number, userId: number): Promise<void> {
    // Store the draw offer
    pendingDrawOffers.set(gameId, userId);

    // Notify opponent
    const drawOfferMsg: DrawOfferMessage = {
      type: "draw_offer",
    };
    await this.broadcastToOpponent(
      gameId,
      userId,
      JSON.stringify(drawOfferMsg)
    );
  }

  /**
   * Handle draw response
   */
  private async handleDrawResponse(
    message: DrawResponseMessage,
    gameId: number,
    userId: number
  ): Promise<void> {
    const offererId = pendingDrawOffers.get(gameId);
    if (!offererId) return;

    if (message.accepted) {
      // End game as draw with rating updates
      pendingDrawOffers.delete(gameId);
      const ratingChanges = await this.gameService.endGame(
        gameId,
        null,
        "finished",
        "draw"
      );

      // Notify both players
      const gameEndedMsg: GameEndedMessage = {
        type: "game_ended",
        winnerId: null,
        result: "draw",
        reason: "draw_agreement",
        ...(ratingChanges && { ratingChanges }),
      };
      await this.broadcastToAll(gameId, JSON.stringify(gameEndedMsg));
    } else {
      // Draw declined, notify offerer
      pendingDrawOffers.delete(gameId);
      const responseMsg: DrawResponseMessage = {
        type: "draw_response",
        accepted: false,
        userId,
      };
      gameConnectionManager.sendToUser(offererId, JSON.stringify(responseMsg));
    }
  }

  /**
   * Handle resign
   */
  private async handleResign(gameId: number, userId: number): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) return;

    // Determine winner (opponent of resigner)
    const winnerId = userId === game.whiteId ? game.blackId : game.whiteId;
    const result = winnerId === game.whiteId ? "white_win" : "black_win";

    // End game with rating updates
    const ratingChanges = await this.gameService.endGame(
      gameId,
      winnerId,
      "finished",
      result
    );

    // Notify both players
    const gameEndedMsg: GameEndedMessage = {
      type: "game_ended",
      winnerId,
      result,
      reason: "resignation",
      ...(ratingChanges && { ratingChanges }),
    };
    await this.broadcastToAll(gameId, JSON.stringify(gameEndedMsg));
  }

  /**
   * Handle timeout - player ran out of time
   */
  private async handleTimeout(gameId: number, userId: number): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) return;

    // Determine winner (opponent of player who timed out)
    const winnerId = userId === game.whiteId ? game.blackId : game.whiteId;
    const result = winnerId === game.whiteId ? "white_win" : "black_win";

    // End game with rating updates
    const ratingChanges = await this.gameService.endGame(
      gameId,
      winnerId,
      "finished",
      result
    );

    // Notify both players
    const gameEndedMsg: GameEndedMessage = {
      type: "game_ended",
      winnerId,
      result,
      reason: "timeout",
      ...(ratingChanges && { ratingChanges }),
    };
    await this.broadcastToAll(gameId, JSON.stringify(gameEndedMsg));
  }

  /**
   * Handle checkmate
   */
  private async handleCheckmate(
    message: CheckmateMessage,
    gameId: number
  ): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) return;

    const winnerId = message.winnerId;
    const result = winnerId === game.whiteId ? "white_win" : "black_win";

    // End game with rating updates
    const ratingChanges = await this.gameService.endGame(
      gameId,
      winnerId,
      "finished",
      result
    );

    // Notify both players
    const gameEndedMsg: GameEndedMessage = {
      type: "game_ended",
      winnerId,
      result,
      reason: "checkmate",
      ...(ratingChanges && { ratingChanges }),
    };
    await this.broadcastToAll(gameId, JSON.stringify(gameEndedMsg));
  }

  /**
   * Handle stalemate
   */
  private async handleStalemate(gameId: number): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) return;

    // End game as draw with rating updates
    const ratingChanges = await this.gameService.endGame(
      gameId,
      null,
      "finished",
      "draw"
    );

    // Notify both players
    const gameEndedMsg: GameEndedMessage = {
      type: "game_ended",
      winnerId: null,
      result: "draw",
      reason: "stalemate",
      ...(ratingChanges && { ratingChanges }),
    };
    await this.broadcastToAll(gameId, JSON.stringify(gameEndedMsg));
  }

  /**
   * Handle abort - only allowed when no moves have been made
   */
  private async handleAbort(gameId: number): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) return;

    // Only allow abort if no moves have been made
    if (game.numMoves && game.numMoves > 0) {
      // Cannot abort after moves have been made
      return;
    }

    // Notify both players
    const gameEndedMsg: GameEndedMessage = {
      type: "game_ended",
      winnerId: null,
      result: "draw",
      reason: "aborted",
    };
    await this.broadcastToAll(gameId, JSON.stringify(gameEndedMsg));

    // Delete game from database
    await this.gameService.deleteGame(gameId);
  }

  /**
   * Handle rematch request
   */
  private async handleRematchRequest(
    gameId: number,
    userId: number
  ): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) return;

    // Determine opponent
    const opponentId = userId === game.whiteId ? game.blackId : game.whiteId;
    if (!opponentId) return;

    // Check if opponent is in another game (has active connection elsewhere)
    // For now, just send the rematch request to opponent
    const rematchRequestMsg: RematchRequestMessage = {
      type: "rematch_request",
      data: {},
    };
    gameConnectionManager.sendToUser(
      opponentId,
      JSON.stringify(rematchRequestMsg)
    );
  }

  /**
   * Handle rematch response
   */
  private async handleRematchResponse(
    message: RematchResponseMessage,
    gameId: number,
    userId: number
  ): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) return;

    // Determine who sent the original request (the opponent)
    const requesterId = userId === game.whiteId ? game.blackId : game.whiteId;
    if (!requesterId) return;

    if (message.data.accepted) {
      // Create new game with swapped colors
      const client = await this.fastify.pg.connect();
      try {
        // Swap colors for rematch
        const newWhiteId = game.blackId;
        const newBlackId = game.whiteId;
        const newWhiteUsername = game.blackUsername;
        const newBlackUsername = game.whiteUsername;
        const newWhiteRating = game.blackRating;
        const newBlackRating = game.whiteRating;
        const newWhiteAvatarUrl = game.blackAvatarUrl;
        const newBlackAvatarUrl = game.whiteAvatarUrl;

        // Create new game
        const { rows: gameRows } = await client.query(
          `INSERT INTO games (
            "whiteId", "blackId", "whiteUsername", "blackUsername",
            "whiteRating", "blackRating", "whiteAvatarUrl", "blackAvatarUrl",
            time, increment, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'in_progress')
          RETURNING id`,
          [
            newWhiteId,
            newBlackId,
            newWhiteUsername,
            newBlackUsername,
            newWhiteRating,
            newBlackRating,
            newWhiteAvatarUrl,
            newBlackAvatarUrl,
            game.time,
            game.increment,
          ]
        );
        const newGameId = gameRows[0].id;

        // Notify requester with match_found message
        const requesterColor = newBlackId === requesterId ? "black" : "white";
        const requesterMsg: MatchmakingMessage = {
          type: "match_found",
          data: {
            gameId: newGameId,
            opponentId: userId,
            opponentUsername:
              requesterColor === "black" ? newWhiteUsername : newBlackUsername,
            opponentRating:
              requesterColor === "black" ? newWhiteRating : newBlackRating,
            rating:
              requesterColor === "black" ? newBlackRating : newWhiteRating,
            time: game.time,
            increment: game.increment,
            color: requesterColor,
          },
        };
        gameConnectionManager.sendToUser(
          requesterId,
          JSON.stringify(requesterMsg)
        );

        // Notify responder with match_found message
        const responderColor = newWhiteId === userId ? "white" : "black";
        const responderMsg: MatchmakingMessage = {
          type: "match_found",
          data: {
            gameId: newGameId,
            opponentId: requesterId,
            opponentUsername:
              responderColor === "white" ? newBlackUsername : newWhiteUsername,
            opponentRating:
              responderColor === "white" ? newBlackRating : newWhiteRating,
            rating:
              responderColor === "white" ? newWhiteRating : newBlackRating,
            time: game.time,
            increment: game.increment,
            color: responderColor,
          },
        };
        gameConnectionManager.sendToUser(userId, JSON.stringify(responderMsg));
      } finally {
        client.release();
      }
    } else {
      // Rematch declined
      const declinedMsg: RematchDeclinedMessage = {
        type: "rematch_response",
        data: {
          accepted: false,
        },
      };
      gameConnectionManager.sendToUser(
        requesterId,
        JSON.stringify(declinedMsg)
      );
    }
  }

  /**
   * Handle cancel rematch
   */
  private async handleCancelRematch(
    gameId: number,
    userId: number
  ): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) return;

    // Determine opponent
    const opponentId = userId === game.whiteId ? game.blackId : game.whiteId;
    if (!opponentId) return;

    // Notify opponent that rematch was canceled
    const canceledMsg = {
      type: "rematch_canceled",
      data: {
        reason: "opponent_disconnected" as const,
      },
    };
    gameConnectionManager.sendToUser(opponentId, JSON.stringify(canceledMsg));
  }

  /**
   * Broadcast to all players in game
   */
  private async broadcastToAll(gameId: number, message: string): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) return;

    if (game.whiteId) {
      gameConnectionManager.sendToUser(game.whiteId, message);
    }
    if (game.blackId) {
      gameConnectionManager.sendToUser(game.blackId, message);
    }
  }
}
