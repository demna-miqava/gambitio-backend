import type { FastifyInstance } from "fastify";
import type { Queryable } from "../db.js";
import type {
  Game,
  GameListItem,
  GameResponse,
  LiveGame,
  LiveGameSummary,
  PaginatedGamesResponse,
  RatingChanges,
} from "../models/Game.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { getTimeControl, ratingColumns, type PlayerColor } from "../models/common.js";
import { rateGame, type PlayerRating } from "../utils/ratingHelpers.js";
import { PROVISIONAL_COLUMNS } from "../repositories/userRepository.js";
import { FIRST_MOVE_TIMEOUT_MS } from "../game/clock.js";
import type { Outcome } from "../game/engine.js";
import { replayBotGame } from "../game/botGame.js";
import { getBotById } from "../game/bots.js";
import { AppError } from "../errors/AppError.js";
import { withinLimit } from "../utils/rateLimit.js";
import { newShareToken } from "../utils/shareToken.js";

/**
 * Bot games one user can save a day. A bot game takes a few minutes, so 200
 * is many hours of play, far beyond anyone actually playing; it only stops
 * a script from filling the games table (at most about 1.6 MB of PGN per
 * user a day, see MAX_BOT_GAME_PGN_LENGTH).
 */
export const BOT_GAMES_PER_DAY = 200;

export function toGameResponse(game: Game): GameResponse {
  return { ...toGameListItem(game), pgn: game.pgn, fen: game.fen };
}

export function toGameListItem(game: Omit<Game, "pgn" | "fen">): GameListItem {
  return {
    id: game.id,
    createdAt: game.createdAt,
    winnerId: game.winnerId,
    numMoves: game.numMoves,
    time: game.time,
    increment: game.increment,
    whiteTime: game.whiteTime,
    blackTime: game.blackTime,
    type: game.time === null ? null : getTimeControl(game.time),
    status: game.status,
    result: game.result,
    endReason: game.endReason,
    rated: game.rated,
    botId: game.botId,
    seriesId: game.seriesId,
    seriesGame: game.seriesGame,
    tournamentId: game.tournamentId,
    whitePlayer: {
      id: game.whiteId,
      username: game.whiteUsername,
      rating: game.whiteRating,
      provisional: game.whiteProvisional,
      avatarUrl: game.whiteAvatarUrl,
      ratingChange: game.whiteRatingChange,
    },
    blackPlayer: {
      id: game.blackId,
      username: game.blackUsername,
      rating: game.blackRating,
      provisional: game.blackProvisional,
      avatarUrl: game.blackAvatarUrl,
      ratingChange: game.blackRatingChange,
    },
  };
}

export function toLiveGameSummary(game: Omit<LiveGame, "pgn">): LiveGameSummary {
  return {
    id: game.id,
    startedAt: game.createdAt,
    time: game.time,
    increment: game.increment,
    whiteTime: game.whiteTime,
    blackTime: game.blackTime,
    type: getTimeControl(game.time),
    numMoves: game.numMoves,
    fen: game.fen,
    whitePlayer: {
      id: game.whiteId,
      username: game.whiteUsername,
      rating: game.whiteRating,
      provisional: game.whiteProvisional,
      avatarUrl: game.whiteAvatarUrl,
    },
    blackPlayer: {
      id: game.blackId,
      username: game.blackUsername,
      rating: game.blackRating,
      provisional: game.blackProvisional,
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
    // Each player's own starting clock when they differ (time odds)
    ownTime: isWhite ? game.whiteTime : game.blackTime,
    opponentTime: isWhite ? game.blackTime : game.whiteTime,
    rated: game.rated,
    // Set for a game an arena tournament paired
    tournamentId: game.tournamentId,
  };
}

export class GameService {
  constructor(private fastify: FastifyInstance) {}

  async getGameById(gameId: number): Promise<GameResponse | null> {
    const game = await gameRepository.findById(this.fastify.pg, gameId);
    return game ? toGameResponse(game) : null;
  }

  /** The game behind a share link, for anyone: GET /shared-games/:token. */
  async getSharedGame(token: string): Promise<GameResponse | null> {
    const game = await gameRepository.findByShareToken(this.fastify.pg, token);
    return game ? toGameResponse(game) : null;
  }

  /**
   * The share link of a game the user played, made on first use: the same
   * link every time, for either player, until one of them turns it off. Only
   * a finished game can be shared: a link to one in progress would show the
   * position to people the players can't see, and an aborted game was never
   * played.
   */
  async shareGame(gameId: number, userId: number): Promise<string> {
    const token = await gameRepository.share(this.fastify.pg, gameId, userId, newShareToken());
    if (token) return token;
    const game = await this.requireOwnGame(gameId, userId);
    throw game.status === "finished"
      ? new AppError("An aborted game can't be shared", "GAME_ABORTED", 409)
      : new AppError("The game can be shared once it's over", "GAME_NOT_FINISHED", 409);
  }

  /** Turns the game's share link off; links already sent stop working. */
  async unshareGame(gameId: number, userId: number): Promise<void> {
    if (await gameRepository.unshare(this.fastify.pg, gameId, userId)) return;
    await this.requireOwnGame(gameId, userId);
  }

  /** The game, or the error that says why the user can't manage its link. */
  private async requireOwnGame(gameId: number, userId: number) {
    const game = await gameRepository.findById(this.fastify.pg, gameId);
    if (!game) throw new AppError("Game not found", "GAME_NOT_FOUND", 404);
    if (game.whiteId !== userId && game.blackId !== userId) {
      throw new AppError("Only the players can share a game", "NOT_YOUR_GAME", 403);
    }
    return game;
  }

  async getGamesByUserId(
    userId: number,
    page: number = 1,
    limit: number = 10
  ): Promise<PaginatedGamesResponse> {
    const normalizedPage = Math.max(1, page);
    const normalizedLimit = Math.min(Math.max(1, limit), 100);
    const offset = (normalizedPage - 1) * normalizedLimit;
    const games = await gameRepository.findPageByUserId(this.fastify.pg, userId, normalizedLimit, offset);
    // A short first page is the whole history; otherwise the count is the
    // user's "listedGames" counter (migration 030) plus their game in
    // progress, two index lookups however long the history is
    const total =
      normalizedPage === 1 && games.length < normalizedLimit
        ? games.length
        : await gameRepository.countByUserId(this.fastify.pg, userId);
    return {
      data: games.map(toGameListItem),
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
    // Counted before the replay, so the cap also bounds the work spent on
    // uploads that turn out to be invalid
    const allowed = await withinLimit(
      this.fastify.redis,
      `botgames:saved:${userId}`,
      BOT_GAMES_PER_DAY,
      24 * 60 * 60
    );
    if (!allowed) {
      throw new AppError(
        "You've saved a lot of bot games today. Try again tomorrow.",
        "BOT_GAME_LIMIT",
        429
      );
    }
    const replayed = replayBotGame(input.pgn, input.color, input.endReason);

    const game = await this.fastify.pg.transact(async (tx) => {
      // Reads the user and counts the game in their history (migration 030)
      // in one statement; the insert below commits with it
      const { rows } = await tx.query<{ username: string; avatarUrl: string | null; rating: number }>(
        `UPDATE users SET "listedGames" = "listedGames" + 1 WHERE id = $1
         RETURNING username, "avatarUrl", "blitzRating" AS rating`,
        [userId]
      );
      const user = rows[0];
      if (!user) throw new AppError("User not found", "USER_NOT_FOUND", 404);

      const isWhite = input.color === "white";
      const { result } = replayed.outcome;
      const playerWon = result === (isWhite ? "white_win" : "black_win");
      return gameRepository.insertFinishedBotGame(tx, {
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
    });
    return toGameResponse(game);
  }
}

/** What creating a game needs to know about a player, read under their row lock. */
export interface LockedPlayer {
  id: number;
  username: string;
  avatarUrl: string | null;
  bulletRating: number;
  blitzRating: number;
  rapidRating: number;
  bulletProvisional: boolean;
  blitzProvisional: boolean;
  rapidProvisional: boolean;
}

/**
 * Locks players' rows for the rest of the transaction and reads them, in one
 * round trip. Rows are locked in id order, the order every path that locks
 * two players takes (finishGame too), so two transactions locking the same
 * pair wait for each other instead of deadlocking. Deleted accounts (clerkId
 * cleared) are left out: the clerkId condition is checked again on a row an
 * account deletion changed while we waited for its lock.
 */
export async function lockPlayers(tx: Queryable, ids: number[]): Promise<Map<number, LockedPlayer>> {
  const { rows } = await tx.query<LockedPlayer>(
    `SELECT id, username, "avatarUrl", "bulletRating", "blitzRating", "rapidRating",
       ${PROVISIONAL_COLUMNS}
     FROM users WHERE id = ANY($1) AND "clerkId" IS NOT NULL
     ORDER BY id FOR UPDATE`,
    [ids]
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The game each of these players has in progress, if any, in one query
 * (each side uses its partial index on games in progress). Must run after
 * the players' rows are locked (lockPlayers) to be reliable: a game created
 * by a transaction that held the locks first is then visible.
 */
export async function findActiveGames(tx: Queryable, ids: number[]): Promise<Map<number, number>> {
  const { rows } = await tx.query<{ id: number; whiteId: number; blackId: number }>(
    `SELECT id, "whiteId", "blackId" FROM games
     WHERE status = 'in_progress' AND ("whiteId" = ANY($1) OR "blackId" = ANY($1))`,
    [ids]
  );
  const active = new Map<number, number>();
  for (const game of rows) {
    for (const playerId of [game.whiteId, game.blackId]) {
      if (ids.includes(playerId)) active.set(playerId, game.id);
    }
  }
  return active;
}

/**
 * Locks both players (lockPlayers) and checks neither is in a game: what
 * createGame does unless the caller has done it already. Throws
 * USER_NOT_FOUND for a deleted account and AlreadyInGameError for a player
 * with a game in progress.
 */
export async function lockPlayersForNewGame(
  tx: Queryable,
  whiteId: number,
  blackId: number
): Promise<Map<number, LockedPlayer>> {
  const players = await lockPlayers(tx, [whiteId, blackId]);
  // A deleted account can still have a queue row or an open challenge for a
  // moment; it must not end up in a new game
  if (!players.has(whiteId) || !players.has(blackId)) {
    throw new AppError("Player not found", "USER_NOT_FOUND", 404);
  }
  const active = await findActiveGames(tx, [whiteId, blackId]);
  for (const userId of [whiteId, blackId]) {
    const activeGameId = active.get(userId);
    if (activeGameId !== undefined) throw new AlreadyInGameError(activeGameId);
  }
  return players;
}

/**
 * Creates a game inside the caller's transaction. This is the single place
 * games are created: matchmaking, accepted challenges and rematches all come
 * through here. Ratings and avatars are read from the users table, never from
 * client input.
 *
 * Both players are locked first (lockPlayersForNewGame) so two transactions
 * creating a game for the same player at once (a challenge accepted while
 * matchmaking pairs them) run one after the other: the second then sees the
 * first's game and fails instead of putting the player in two games. A
 * caller that has already done exactly that in this transaction passes the
 * rows it read as `locked`, and nothing is locked or checked again.
 */
export async function createGame(
  tx: Queryable,
  params: {
    whiteId: number;
    blackId: number;
    /** The longer clock when the game has time odds */
    time: number;
    increment: number;
    /** Time odds: each side's starting clock (seconds). Makes the game unrated. */
    odds?: { whiteTime: number; blackTime: number } | null;
    /** The series this game belongs to, and its number in it */
    series?: { id: number; game: number };
    /** The arena tournament pairing this game, and whether its games are rated */
    tournament?: { id: number; rated: boolean };
  },
  options: {
    /**
     * Both players' rows, already locked with lockPlayers in this
     * transaction, with neither found in a game (findActiveGames) after the
     * lock was taken
     */
    locked?: Map<number, LockedPlayer>;
  } = {}
): Promise<LiveGame> {
  const { whiteId, blackId, time, increment, series } = params;
  const odds = params.odds && params.odds.whiteTime !== params.odds.blackTime ? params.odds : null;
  const players = options.locked ?? (await lockPlayersForNewGame(tx, whiteId, blackId));
  const white = players.get(whiteId);
  const black = players.get(blackId);
  if (!white || !black) throw new AppError("Player not found", "USER_NOT_FOUND", 404);

  const { rating: col, provisional } = ratingColumns(getTimeControl(time));
  const now = Date.now();
  return gameRepository.insert(tx, {
    whiteId,
    blackId,
    whiteUsername: white.username,
    blackUsername: black.username,
    whiteRating: white[col],
    blackRating: black[col],
    whiteProvisional: white[provisional],
    blackProvisional: black[provisional],
    whiteAvatarUrl: white.avatarUrl,
    blackAvatarUrl: black.avatarUrl,
    time: odds ? Math.max(odds.whiteTime, odds.blackTime) : time,
    increment,
    odds,
    lastMoveAt: new Date(now),
    deadlineAt: new Date(now + FIRST_MOVE_TIMEOUT_MS),
    seriesId: series?.id ?? null,
    seriesGame: series?.game ?? null,
    tournamentId: params.tournament?.id ?? null,
    ...(params.tournament && { rated: params.tournament.rated }),
  });
}

/**
 * Ends a game that the caller has locked with gameRepository.lockById.
 * Returns null if the game was already finished, so ending twice (both
 * clients claiming a timeout, resign after checkmate, ...) is a no-op.
 *
 * Unrated games (time odds) change no ratings. For rated ones both players'
 * rows are locked and their ratings as they stand are fed to Glicko-2
 * (rateGame): a player is in one game at a time, so that is the rating the
 * game started with. The stored and reported change is what was actually
 * applied (new rating minus the one read under the lock).
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
  // An aborted game isn't listed in either player's history and changes
  // nothing about them. Any other finished game is counted in "listedGames"
  // (migration 030); an unrated one (time odds) leaves ratings and the
  // per-time-control game counters alone.
  if (outcome.result !== "aborted" && game.rated) {
    const { rating, highest, games, rd, volatility, ratedAt } = ratingColumns(getTimeControl(game.time));
    // Locked in id order, the order every path that locks two players takes
    // (lockPlayers), so two games finishing at once can't deadlock
    const { rows: before } = await tx.query<PlayerRating & { id: number }>(
      `SELECT id, "${rating}" AS rating, "${rd}" AS rd, "${volatility}" AS volatility, "${ratedAt}" AS "ratedAt"
       FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
      [[game.whiteId, game.blackId]]
    );
    const whiteBefore = before.find((r) => r.id === game.whiteId)!;
    const blackBefore = before.find((r) => r.id === game.blackId)!;
    const now = new Date();
    const rated = rateGame(whiteBefore, blackBefore, outcome.result, now);
    // The peak also takes the rating before this game, so a row whose peak
    // fell behind (written by older code, see migration 013) heals itself.
    await tx.query(
      `UPDATE users u SET
         "${rating}" = v.rating,
         "${highest}" = GREATEST(u."${highest}", u."${rating}", v.rating),
         "${rd}" = v.rd,
         "${volatility}" = v.volatility,
         "${ratedAt}" = $9,
         "${games}" = u."${games}" + 1,
         "listedGames" = u."listedGames" + 1
       FROM (VALUES ($1::int, $2::int, $3::real, $4::real), ($5::int, $6::int, $7::real, $8::real))
         v(id, rating, rd, volatility)
       WHERE u.id = v.id`,
      [
        game.whiteId, rated.white.rating, rated.white.rd, rated.white.volatility,
        game.blackId, rated.black.rating, rated.black.rd, rated.black.volatility,
        now,
      ]
    );
    ratingChanges = {
      whiteRatingChange: rated.white.rating - whiteBefore.rating,
      blackRatingChange: rated.black.rating - blackBefore.rating,
      whiteNewRating: rated.white.rating,
      blackNewRating: rated.black.rating,
    };
  } else if (outcome.result !== "aborted") {
    await tx.query(
      `UPDATE users u SET "listedGames" = u."listedGames" + 1
       FROM (SELECT id FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE) old
       WHERE u.id = old.id`,
      [[game.whiteId, game.blackId]]
    );
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
