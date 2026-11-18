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
  /** Whether each rating was provisional when the game started (migration 032) */
  whiteProvisional: boolean;
  blackProvisional: boolean;
  /** Starting clock in seconds; null for bot games, which are untimed */
  time: number | null;
  increment: number;
  /**
   * Each side's starting clock in seconds when they differ (time odds,
   * migration 027); `time` is then the longer one. Null for an even game.
   */
  whiteTime: number | null;
  blackTime: number | null;
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
  /** The player asking to take back a move (migration 021) */
  takebackRequestedBy: number | null;
  /** The player whose takeback was declined; they can't ask again until a move is made */
  takebackDeclinedFor: number | null;
  whiteRatingChange: number | null;
  blackRatingChange: number | null;
  /** The computer opponent (src/game/bots.ts) when this is a bot game */
  botId: string | null;
  /** False for bot games and games with time odds: they never change ratings or stats */
  rated: boolean;
  /** Set when the game is part of a friend series (migration 016) */
  seriesId: number | null;
  /** 1-based number of the game within its series */
  seriesGame: number | null;
  /** Set when the game was paired by an arena tournament (migration 034) */
  tournamentId: number | null;
  /** What is left of each player's lag allowance (src/game/clock.ts, migration 029) */
  whiteLagBudgetMs: number;
  blackLagBudgetMs: number;
  /** Set while the game is paused for a server shutdown (migration 029) */
  pausedAt: Date | null;
  /** The player whose draw offer was declined; they can't offer again until they move */
  drawDeclinedFor: number | null;
  /** Whether each player has used their one rematch request */
  whiteRematchAsked: boolean;
  blackRematchAsked: boolean;
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
  /** The rating was provisional when the game started: shown as "1500?" */
  provisional: boolean;
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
  /** Each side's starting clock when they differ (time odds); null otherwise */
  whiteTime: number | null;
  blackTime: number | null;
  /** Null for bot games (untimed) */
  type: TimeControl | null;
  status: GameStatus;
  result: GameResult | null;
  endReason: EndReason | null;
  rated: boolean;
  /** Set when the opponent was a computer bot */
  botId: string | null;
  /** Set when the game is part of a friend series */
  seriesId: number | null;
  seriesGame: number | null;
  /** Set when the game was played in a tournament */
  tournamentId: number | null;
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
  provisional: boolean;
  avatarUrl: string | null;
}

/** A game in progress, as listed for spectators. */
export interface LiveGameSummary {
  id: number;
  /** When the game was created */
  startedAt: Date;
  time: number;
  increment: number;
  /** Each side's starting clock when they differ (time odds); null otherwise */
  whiteTime: number | null;
  blackTime: number | null;
  type: TimeControl;
  numMoves: number;
  fen: string | null;
  whitePlayer: LivePlayerResponse;
  blackPlayer: LivePlayerResponse;
}
