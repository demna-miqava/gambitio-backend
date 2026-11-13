import type { TimeControl } from "./common.js";
import type { EndReason, GameResult } from "../game/engine.js";

export type GameStatus = "in_progress" | "finished";

/** A row of the games table. */
export interface Game {
  id: number;
  createdAt: Date;
  pgn: string | null;
  fen: string | null;
  winnerId: number | null;
  numMoves: number;
  whiteRating: number;
  blackRating: number;
  /** Starting clock in seconds; null for bot games, which are untimed */
  time: number | null;
  increment: number;
  /** Null on the bot's side of a bot game (and only there) */
  whiteId: number | null;
  blackId: number | null;
  whiteUsername: string;
  blackUsername: string;
  whiteAvatarUrl: string | null;
  blackAvatarUrl: string | null;
  status: GameStatus;
  result: GameResult | null;
  endReason: EndReason | null;
  endedAt: Date | null;
  whiteTimeLeftMs: number | null;
  blackTimeLeftMs: number | null;
  lastMoveAt: Date | null;
  deadlineAt: Date | null;
  drawOfferedBy: number | null;
  rematchRequestedBy: number | null;
  rematchGameId: number | null;
  whiteRatingChange: number | null;
  blackRatingChange: number | null;
  /** The computer opponent (src/game/bots.ts) when this is a bot game */
  botId: string | null;
  /** False for bot games: they never change ratings or stats */
  rated: boolean;
}

/**
 * A game between two players on the clock: everything that isn't a bot game.
 * Live-game code (moves, clocks, results, rematches) only handles these; the
 * database guarantees in-progress games are never bot games (migration 012).
 */
export type LiveGame = Game & { time: number; whiteId: number; blackId: number; botId: null };

export function isLiveGame(game: Game): game is LiveGame {
  return game.botId === null && game.time !== null && game.whiteId !== null && game.blackId !== null;
}

export interface PlayerResponse {
  /** Null for the bot in a bot game */
  id: number | null;
  username: string;
  rating: number;
  avatarUrl: string | null;
  ratingChange: number | null;
}

export interface GameResponse {
  id: number;
  createdAt: Date;
  pgn: string | null;
  fen: string | null;
  winnerId: number | null;
  numMoves: number;
  /** Null for bot games (untimed) */
  time: number | null;
  increment: number;
  /** Null for bot games (untimed) */
  type: TimeControl | null;
  status: GameStatus;
  result: GameResult | null;
  endReason: EndReason | null;
  rated: boolean;
  /** Set when the opponent was a computer bot */
  botId: string | null;
  whitePlayer: PlayerResponse;
  blackPlayer: PlayerResponse;
}

/** A game in the history list: no move list or position (open the game for those). */
export type GameListItem = Omit<GameResponse, "pgn" | "fen">;

export interface PaginatedGamesResponse {
  data: GameListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface RatingChanges {
  whiteRatingChange: number;
  blackRatingChange: number;
  whiteNewRating: number;
  blackNewRating: number;
}

export interface LivePlayerResponse {
  id: number;
  username: string;
  rating: number;
  avatarUrl: string | null;
}

/** A game in progress, as listed for spectators. */
export interface LiveGameSummary {
  id: number;
  /** When the game was created */
  startedAt: Date;
  time: number;
  increment: number;
  type: TimeControl;
  numMoves: number;
  fen: string | null;
  whitePlayer: LivePlayerResponse;
  blackPlayer: LivePlayerResponse;
}
