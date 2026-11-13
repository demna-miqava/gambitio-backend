import type { FastifyInstance } from "fastify";
import type { Queryable } from "../db.js";
import type {
  Game,
  GameResponse,
  LiveGame,
  LiveGameSummary,
  PaginatedGamesResponse,
  RatingChanges,
} from "../models/Game.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { getTimeControl, ratingColumns, type PlayerColor } from "../models/common.js";
import { calculateRatingChanges, RATING_FLOOR } from "../utils/ratingHelpers.js";
import { FIRST_MOVE_TIMEOUT_MS } from "../game/clock.js";
import type { Outcome } from "../game/engine.js";
import { replayBotGame } from "../game/botGame.js";
import { getBotById } from "../game/bots.js";
import { AppError } from "../errors/AppError.js";

export function toGameResponse(game: Game): GameResponse {
  return {
    id: game.id,
    createdAt: game.createdAt,
    pgn: game.pgn,
    fen: game.fen,
    winnerId: game.winnerId,
    numMoves: game.numMoves,
    time: game.time,
    increment: game.increment,
    type: game.time === null ? null : getTimeControl(game.time),
    status: game.status,
    result: game.result,
    endReason: game.endReason,
    rated: game.rated,
    botId: game.botId,
    whitePlayer: {
      id: game.whiteId,
      username: game.whiteUsername,
      rating: game.whiteRating,
      avatarUrl: game.whiteAvatarUrl,
      ratingChange: game.whiteRatingChange,
    },
    blackPlayer: {
      id: game.blackId,
      username: game.blackUsername,
      rating: game.blackRating,
      avatarUrl: game.blackAvatarUrl,
      ratingChange: game.blackRatingChange,
    },
  };
}

export function toLiveGameSummary(game: LiveGame): LiveGameSummary {
  return {
    id: game.id,
    startedAt: game.createdAt,
    time: game.time,
    increment: game.increment,
    type: getTimeControl(game.time),
    numMoves: game.numMoves,
    fen: game.fen,
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
  };
}

export function colorOf(game: LiveGame, userId: number): PlayerColor | null {
  if (userId === game.whiteId) return "white";
  if (userId === game.blackId) return "black";
  return null;
}

export function opponentOf(game: LiveGame, userId: number): number {
  return userId === game.whiteId ? game.blackId : game.whiteId;
}

/** Thrown when a player who already has a live game tries to start another. */
export class AlreadyInGameError extends AppError {
  constructor(public readonly gameId: number) {
    super("You already have a game in progress", "ALREADY_IN_GAME", 409);
  }
}

/** The message a player receives when a game they're in is created. */
export function matchFoundData(game: LiveGame, userId: number) {
  const color = colorOf(game, userId)!;
  const isWhite = color === "white";
  return {
    gameId: game.id,
    color,
    opponentId: isWhite ? game.blackId : game.whiteId,
    opponentUsername: isWhite ? game.blackUsername : game.whiteUsername,
    opponentRating: isWhite ? game.blackRating : game.whiteRating,
    rating: isWhite ? game.whiteRating : game.blackRating,
    time: game.time,
    increment: game.increment,
  };
}

export class GameService {
  constructor(private fastify: FastifyInstance) {}

  async getGameById(gameId: number): Promise<GameResponse | null> {
    const game = await gameRepository.findById(this.fastify.pg, gameId);
    return game ? toGameResponse(game) : null;
  }

  async getGamesByUserId(
    userId: number,
    page: number = 1,
    limit: number = 10
  ): Promise<PaginatedGamesResponse> {
    const normalizedPage = Math.max(1, page);
    const normalizedLimit = Math.min(Math.max(1, limit), 100);
    const { games, total } = await gameRepository.findByUserId(
      this.fastify.pg,
      userId,
      normalizedLimit,
      (normalizedPage - 1) * normalizedLimit
    );
    return {
      data: games.map(toGameResponse),
      pagination: {
        page: normalizedPage,
        limit: normalizedLimit,
        total,
        totalPages: Math.ceil(total / normalizedLimit),
      },
    };
  }

  /**
   * Stores a finished game the user played against a bot in the browser.
   * The moves are replayed and the result derived here (see replayBotGame).
   * Bot games are unrated: nothing about the user's ratings, game counters or
   * stats changes. The user's blitz rating is recorded as a snapshot, the
   * same rating the bot list is matched against.
   */
  async saveBotGame(
    userId: number,
    input: { botId: string; color: PlayerColor; pgn: string; endReason: string }
  ): Promise<GameResponse> {
    const bot = getBotById(input.botId);
    if (!bot) throw new AppError("Unknown bot", "UNKNOWN_BOT", 400);
    const replayed = replayBotGame(input.pgn, input.color, input.endReason);

    const { rows } = await this.fastify.pg.query<{
      username: string;
      avatarUrl: string | null;
      rating: number;
    }>(`SELECT username, "avatarUrl", "blitzRating" AS rating FROM users WHERE id = $1`, [userId]);
    const user = rows[0];
    if (!user) throw new AppError("User not found", "USER_NOT_FOUND", 404);

    const isWhite = input.color === "white";
    const { result } = replayed.outcome;
    const playerWon = result === (isWhite ? "white_win" : "black_win");
    const game = await gameRepository.insertFinishedBotGame(this.fastify.pg, {
      botId: bot.id,
      whiteId: isWhite ? userId : null,
      blackId: isWhite ? null : userId,
      whiteUsername: isWhite ? user.username : bot.name,
      blackUsername: isWhite ? bot.name : user.username,
      whiteRating: isWhite ? user.rating : bot.rating,
      blackRating: isWhite ? bot.rating : user.rating,
      whiteAvatarUrl: isWhite ? user.avatarUrl : null,
      blackAvatarUrl: isWhite ? null : user.avatarUrl,
      pgn: replayed.pgn,
      fen: replayed.fen,
      numMoves: replayed.numMoves,
      result,
      endReason: replayed.outcome.reason,
      // The bot has no user id, so a bot win has no winnerId, like a draw;
      // result tells them apart
      winnerId: playerWon ? userId : null,
    });
    return toGameResponse(game);
  }
}

/**
 * Creates a game inside the caller's transaction. This is the single place
 * games are created: matchmaking, accepted challenges and rematches all come
 * through here. Ratings and avatars are read from the users table, never from
 * client input.
 */
export async function createGame(
  tx: Queryable,
  params: { whiteId: number; blackId: number; time: number; increment: number }
): Promise<LiveGame> {
  const { whiteId, blackId, time, increment } = params;
  // Lock both players (in id order, matching finishGame) so two transactions
  // creating a game for the same player at once (a challenge accepted while
  // matchmaking pairs them) run one after the other: the second then sees the
  // first's game below and fails instead of putting the player in two games.
  await tx.query(`SELECT 1 FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [
    [whiteId, blackId],
  ]);
  for (const userId of [whiteId, blackId]) {
    const activeGameId = await gameRepository.findActiveGameIdForUser(tx, userId);
    if (activeGameId !== null) throw new AlreadyInGameError(activeGameId);
  }

  const col = ratingColumns(getTimeControl(time)).rating;
  const { rows } = await tx.query<{
    id: number;
    username: string;
    avatarUrl: string | null;
    rating: number;
  }>(`SELECT id, username, "avatarUrl", "${col}" AS rating FROM users WHERE id = ANY($1)`, [
    [whiteId, blackId],
  ]);
  const white = rows.find((r) => r.id === whiteId);
  const black = rows.find((r) => r.id === blackId);
  if (!white || !black) throw new AppError("Player not found", "USER_NOT_FOUND", 404);

  const now = Date.now();
  return gameRepository.insert(tx, {
    whiteId,
    blackId,
    whiteUsername: white.username,
    blackUsername: black.username,
    whiteRating: white.rating,
    blackRating: black.rating,
    whiteAvatarUrl: white.avatarUrl,
    blackAvatarUrl: black.avatarUrl,
    time,
    increment,
    lastMoveAt: new Date(now),
    deadlineAt: new Date(now + FIRST_MOVE_TIMEOUT_MS),
  });
}

/**
 * Ends a game that the caller has locked with gameRepository.lockById.
 * Returns null if the game was already finished, so ending twice (both
 * clients claiming a timeout, resign after checkmate, ...) is a no-op.
 *
 * Rating deltas are computed from the ratings at game start, then added to the
 * players' current ratings, so concurrent games don't overwrite each other.
 * The stored and reported change is what was actually applied (it differs
 * from the computed delta when the rating floor kicks in).
 */
export async function finishGame(
  tx: Queryable,
  game: LiveGame,
  outcome: Outcome,
  clock: { whiteMs: number; blackMs: number } | null
): Promise<{ winnerId: number | null; ratingChanges: RatingChanges | null } | null> {
  if (game.status !== "in_progress") return null;

  const winnerId =
    outcome.result === "white_win" ? game.whiteId : outcome.result === "black_win" ? game.blackId : null;

  let ratingChanges: RatingChanges | null = null;
  if (outcome.result !== "aborted") {
    const deltas = calculateRatingChanges(game.whiteRating, game.blackRating, outcome.result);
    const { rating, highest, games } = ratingColumns(getTimeControl(game.time));
    const newRatings = new Map<number, number>();
    const applied = new Map<number, number>();
    // Lock users in id order so two games finishing at once can't deadlock
    for (const [userId, delta] of [
      [game.whiteId, deltas.whiteRatingChange],
      [game.blackId, deltas.blackRatingChange],
    ].sort((a, b) => a[0]! - b[0]!) as [number, number][]) {
      // The peak also takes the rating before this game, so a row whose peak
      // fell behind (written by older code, see migration 013) heals itself
      const { rows } = await tx.query<{ rating: number; previous: number }>(
        `UPDATE users u SET
           "${rating}" = GREATEST($3, u."${rating}" + $2),
           "${highest}" = GREATEST(u."${highest}", u."${rating}", GREATEST($3, u."${rating}" + $2)),
           "${games}" = u."${games}" + 1
         FROM (SELECT id, "${rating}" AS previous FROM users WHERE id = $1 FOR UPDATE) old
         WHERE u.id = old.id
         RETURNING u."${rating}" AS rating, old.previous`,
        [userId, delta, RATING_FLOOR]
      );
      newRatings.set(userId, rows[0]!.rating);
      applied.set(userId, rows[0]!.rating - rows[0]!.previous);
    }
    ratingChanges = {
      whiteRatingChange: applied.get(game.whiteId)!,
      blackRatingChange: applied.get(game.blackId)!,
      whiteNewRating: newRatings.get(game.whiteId)!,
      blackNewRating: newRatings.get(game.blackId)!,
    };
  }

  const finished = await gameRepository.finish(tx, game.id, {
    result: outcome.result,
    endReason: outcome.reason,
    winnerId,
    whiteTimeLeftMs: clock?.whiteMs ?? game.whiteTimeLeftMs,
    blackTimeLeftMs: clock?.blackMs ?? game.blackTimeLeftMs,
    whiteRatingChange: ratingChanges?.whiteRatingChange ?? 0,
    blackRatingChange: ratingChanges?.blackRatingChange ?? 0,
  });
  if (!finished) return null;

  return { winnerId, ratingChanges };
}
