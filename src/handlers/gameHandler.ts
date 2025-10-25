import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { GameService } from "../services/gameService.js";
import type {
  GameWebSocketMessage,
  MoveMessage,
  DrawOfferMessage,
  DrawResponseMessage,
  CheckmateMessage,
  GameEndedMessage,
  InitialGameStateMessage,
  ErrorMessage,
} from "../models/GameWebSocket.js";
import { wsConnectionManager } from "../utils/wsConnectionManager.js";

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
      wsConnectionManager.sendToUser(opponentId, message);
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
      // End game as draw
      await this.gameService.endGame(gameId, null, "finished");
      pendingDrawOffers.delete(gameId);

      // Notify both players
      const gameEndedMsg: GameEndedMessage = {
        type: "game_ended",
        winnerId: null,
        result: "draw",
        reason: "draw_agreement",
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
      wsConnectionManager.sendToUser(offererId, JSON.stringify(responseMsg));
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

    // End game
    await this.gameService.endGame(gameId, winnerId, "finished");

    // Notify both players
    const gameEndedMsg: GameEndedMessage = {
      type: "game_ended",
      winnerId,
      result: winnerId === game.whiteId ? "white_win" : "black_win",
      reason: "resignation",
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

    // End game
    await this.gameService.endGame(gameId, winnerId, "finished");

    // Notify both players
    const gameEndedMsg: GameEndedMessage = {
      type: "game_ended",
      winnerId,
      result: winnerId === game.whiteId ? "white_win" : "black_win",
      reason: "timeout",
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

    // End game
    await this.gameService.endGame(gameId, winnerId, "finished");

    // Notify both players
    const gameEndedMsg: GameEndedMessage = {
      type: "game_ended",
      winnerId,
      result: winnerId === game.whiteId ? "white_win" : "black_win",
      reason: "checkmate",
    };
    await this.broadcastToAll(gameId, JSON.stringify(gameEndedMsg));
  }

  /**
   * Handle stalemate
   */
  private async handleStalemate(gameId: number): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) return;

    // End game as draw
    await this.gameService.endGame(gameId, null, "finished");

    // Notify both players
    const gameEndedMsg: GameEndedMessage = {
      type: "game_ended",
      winnerId: null,
      result: "draw",
      reason: "stalemate",
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
   * Broadcast to all players in game
   */
  private async broadcastToAll(gameId: number, message: string): Promise<void> {
    const game = await this.gameService.getGameById(gameId);
    if (!game) return;

    if (game.whiteId) {
      wsConnectionManager.sendToUser(game.whiteId, message);
    }
    if (game.blackId) {
      wsConnectionManager.sendToUser(game.blackId, message);
    }
  }
}
