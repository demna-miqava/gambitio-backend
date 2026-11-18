import type { FastifyInstance } from "fastify";
import { ratingColumns, type TimeControl } from "../models/common.js";
import { AppError } from "../errors/AppError.js";
import { cachedField, cachedValue, invalidateCacheGroups, type CacheGroup } from "../utils/cache.js";
import { LISTED_TOTAL_CACHE_SECONDS, listedTotalCacheKey, myPositionCacheKey } from "./leaderboardService.js";

export type StatsVariant = TimeControl | "all";
const VARIANTS: TimeControl[] = ["bullet", "blitz", "rapid"];
const MAX_HISTORY_POINTS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

interface UserRatings {
  createdAt: Date;
  bulletRating: number;
  blitzRating: number;
  rapidRating: number;
  highestBulletRating: number;
  highestBlitzRating: number;
  highestRapidRating: number;
}

const ratingOf = (user: UserRatings, variant: TimeControl) =>
  user[ratingColumns(variant).rating as "bulletRating" | "blitzRating" | "rapidRating"];
/** Peak rating, never below the current one (see migration 013). */
const highestOf = (user: UserRatings, variant: TimeControl) =>
  Math.max(
    ratingOf(user, variant),
    user[
      ratingColumns(variant).highest as
        | "highestBulletRating"
        | "highestBlitzRating"
        | "highestRapidRating"
    ]
  );

/** Same output as toLocaleDateString("en-US", ...), without building a formatter per call. */
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const formatDate = (date: Date) => DATE_FORMAT.format(date);

/**
 * The user's ($1) games as one side of the board: finished, rated (so not
 * against a bot), non-aborted. Each side's WHERE matches a partial covering
 * index (migration 031), which holds every column used here, so each side is
 * an index-only scan, in ("createdAt", id) order, of just that player's
 * games. A game the player had both sides of is counted once, as white.
 */
const playedSide = (side: "white" | "black") => {
  const [own, other] = side === "white" ? ["white", "black"] : ["black", "white"];
  return `
  SELECT g.id, g."createdAt",
    CASE WHEN g.time < 180 THEN 'bullet' WHEN g.time < 600 THEN 'blitz' ELSE 'rapid' END AS variant,
    g."${own}Rating" AS before,
    COALESCE(g."${own}RatingChange", 0) AS change,
    g."${other}Rating" AS opponent,
    CASE WHEN g."winnerId" = $1 THEN 'win' WHEN g."winnerId" IS NULL THEN 'draw' ELSE 'loss' END AS outcome
  FROM games g
  WHERE g."${own}Id" = $1 ${side === "black" ? `AND g."whiteId" IS DISTINCT FROM $1` : ""}
    AND g.status = 'finished' AND g.result <> 'aborted' AND g.rated`;
};

/**
 * The user's ($1) finished, rated games, one row each, from their side of
 * the board. The variant thresholds must match getTimeControl
 * (src/models/common.ts). Filters on "createdAt" applied to this are pushed
 * into both sides, where they are index conditions.
 */
const PLAYED = `${playedSide("white")}
  UNION ALL ${playedSide("black")}`;

/**
 * Players listed on the leaderboards (src/repositories/leaderboardRepository.ts):
 * at least one rated game in the variant, account not deleted. Ranks count
 * only these, so the profile rank matches the leaderboard. Each predicate
 * matches a partial index (migrations 010 and 014).
 */
const listed = (variant: StatsVariant, alias = "u") =>
  variant === "all"
    ? `(${alias}."bulletGames" > 0 OR ${alias}."blitzGames" > 0 OR ${alias}."rapidGames" > 0) AND ${alias}."clerkId" IS NOT NULL`
    : `${alias}."${ratingColumns(variant).games}" > 0 AND ${alias}."clerkId" IS NOT NULL`;

/**
 * Profile statistics computed from finished, rated games. The aggregation
 * runs in Postgres; only per-variant totals and one row per day of rating
 * history come back, however many games the user has played.
 */
export class StatsService {
  constructor(private fastify: FastifyInstance) {}

  private async loadUser(userId: number): Promise<UserRatings> {
    const { rows } = await this.fastify.pg.query<UserRatings>(
      `SELECT "createdAt", "bulletRating", "blitzRating", "rapidRating",
              "highestBulletRating", "highestBlitzRating", "highestRapidRating"
       FROM users WHERE id = $1`,
      [userId]
    );
    const user = rows[0];
    if (!user) throw new AppError("User not found", "USER_NOT_FOUND", 404);
    return user;
  }

  /**
   * Per-variant cards: GET /users/:id/stats/summary. The puzzle card is
   * cached on its own, so a puzzle attempt doesn't drop the game stats.
   */
  async getSummary(userId: number) {
    const [games, puzzle] = await Promise.all([
      this.cached(userId, "summary", () => this.computeSummary(userId)),
      cachedField(this.fastify.redis, this.fastify.log, puzzleStatsCache(userId), "summary", STATS_CACHE_SECONDS, () =>
        this.puzzleSummary(userId)
      ),
    ]);
    return { ...games, puzzle };
  }

  private async computeSummary(userId: number) {
    const user = await this.loadUser(userId);
    const { rows } = await this.fastify.pg.query<{
      variant: TimeControl;
      games: number;
      wins: number;
      draws: number;
      delta: number;
      peakAt: Date | null;
    }>(
      `WITH played AS (${PLAYED})
       SELECT variant, COUNT(*)::int AS games,
         COUNT(*) FILTER (WHERE outcome = 'win')::int AS wins,
         COUNT(*) FILTER (WHERE outcome = 'draw')::int AS draws,
         COALESCE(SUM(change) FILTER (WHERE "createdAt" >= $2), 0)::int AS delta,
         -- The most recent game that ended at the peak rating
         MAX("createdAt") FILTER (WHERE before + change =
           CASE variant WHEN 'bullet' THEN $3::int WHEN 'blitz' THEN $4::int ELSE $5::int END) AS "peakAt"
       FROM played GROUP BY variant`,
      [
        userId,
        new Date(Date.now() - 30 * DAY_MS),
        highestOf(user, "bullet"),
        highestOf(user, "blitz"),
        highestOf(user, "rapid"),
      ]
    );
    const byVariant = new Map(rows.map((r) => [r.variant, r]));

    const stats = Object.fromEntries(
      VARIANTS.map((variant) => {
        const row = byVariant.get(variant);
        const games = row?.games ?? 0;
        const wins = row?.wins ?? 0;
        const draws = row?.draws ?? 0;
        return [
          variant,
          {
            rating: ratingOf(user, variant),
            delta: row?.delta ?? 0,
            highestRating: highestOf(user, variant),
            highestDate: formatDate(row?.peakAt ?? user.createdAt),
            wins,
            losses: games - wins - draws,
            draws,
            games,
          },
        ];
      })
    );
    const numberOfGames = rows.reduce((sum, r) => sum + r.games, 0);
    return { numberOfGames, stats };
  }

  /** Puzzle rating card. Separate from `stats`, which only holds game variants. */
  private async puzzleSummary(userId: number) {
    const { rows } = await this.fastify.pg.query<{
      rating: number;
      highestRating: number;
      attempts: number;
      solved: number;
      delta: number;
    }>(
      `SELECT u."puzzleRating" AS rating, GREATEST(u."highestPuzzleRating", u."puzzleRating") AS "highestRating",
              u."puzzleAttempts" AS attempts,
              COUNT(a.*) FILTER (WHERE a.success)::int AS solved,
              COALESCE(SUM(a."ratingChange") FILTER (WHERE a."createdAt" >= now() - interval '30 days'), 0)::int AS delta
       FROM users u LEFT JOIN puzzle_attempts a ON a."userId" = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [userId]
    );
    return rows[0]!;
  }

  /** Detailed stats for one period and variant: GET /users/:id/stats */
  async getComprehensive(userId: number, days: number | null, variant: StatsVariant) {
    return this.cached(userId, `full:${days ?? "all"}:${variant}`, () =>
      this.computeComprehensive(userId, days, variant)
    );
  }

  private async computeComprehensive(userId: number, days: number | null, variant: StatsVariant) {
    const user = await this.loadUser(userId);
    const since = new Date(days === null ? 0 : Date.now() - days * DAY_MS);
    const variantParam = variant === "all" ? null : variant;

    const { rows } = await this.fastify.pg.query<{
      totalGames: number;
      wins: number;
      draws: number;
      ratingGain: number;
      averageRating: number;
      bestWin: number;
      winStreak: number;
    }>(
      `WITH played AS (${PLAYED}),
       period AS (
         SELECT * FROM played WHERE ($2::text IS NULL OR variant = $2::text) AND "createdAt" >= $3
       ),
       -- Consecutive wins share a group: a game's position among all games
       -- minus its position among wins is constant along a run of wins
       runs AS (
         SELECT outcome,
           ROW_NUMBER() OVER (ORDER BY "createdAt", id)
             - ROW_NUMBER() OVER (PARTITION BY outcome = 'win' ORDER BY "createdAt", id) AS grp
         FROM period
       )
       SELECT COUNT(*)::int AS "totalGames",
         COUNT(*) FILTER (WHERE outcome = 'win')::int AS wins,
         COUNT(*) FILTER (WHERE outcome = 'draw')::int AS draws,
         COALESCE(SUM(change), 0)::int AS "ratingGain",
         COALESCE(ROUND(AVG(opponent)), 0)::int AS "averageRating",
         COALESCE(MAX(opponent) FILTER (WHERE outcome = 'win'), 0)::int AS "bestWin",
         (SELECT COALESCE(MAX(n), 0)::int FROM
            (SELECT COUNT(*) AS n FROM runs WHERE outcome = 'win' GROUP BY grp) streaks) AS "winStreak"
       FROM period`,
      [userId, variantParam, since]
    );
    const totals = rows[0]!;

    const currentRating =
      variant === "all"
        ? Math.round(VARIANTS.reduce((s, v) => s + ratingOf(user, v), 0) / VARIANTS.length)
        : ratingOf(user, variant);
    const highestRating =
      variant === "all" ? Math.max(...VARIANTS.map((v) => highestOf(user, v))) : highestOf(user, variant);

    return {
      currentRating,
      ratingGain: totals.ratingGain,
      highestRating,
      totalGames: totals.totalGames,
      wins: totals.wins,
      draws: totals.draws,
      losses: totals.totalGames - totals.wins - totals.draws,
      ratingHistory: await this.history(userId, user, variantParam, since),
      averageRating: totals.averageRating,
      bestWin: totals.bestWin,
      winStreak: totals.winStreak,
      ...(await this.ranks(userId, variant, currentRating)),
    };
  }

  /**
   * Rating after each game, one point per day (last game of the day, UTC),
   * downsampled to MAX_HISTORY_POINTS. For "all", the value is the average of
   * the three variant ratings at that time. A variant's rating after a game
   * is its current rating minus the changes of the games played after it,
   * all of which are in the period too, so only the period's games are read.
   */
  private async history(userId: number, user: UserRatings, variant: TimeControl | null, since: Date) {
    const { rows } = await this.fastify.pg.query<{
      createdAt: Date;
      laterBullet: number;
      laterBlitz: number;
      laterRapid: number;
    }>(
      `WITH played AS (${PLAYED}),
       later AS (
         SELECT id, "createdAt", variant,
           COALESCE(SUM(change) FILTER (WHERE variant = 'bullet') OVER w, 0)::int AS "laterBullet",
           COALESCE(SUM(change) FILTER (WHERE variant = 'blitz') OVER w, 0)::int AS "laterBlitz",
           COALESCE(SUM(change) FILTER (WHERE variant = 'rapid') OVER w, 0)::int AS "laterRapid"
         FROM played
         WHERE "createdAt" >= $3
         -- Every game after this one
         WINDOW w AS (ORDER BY "createdAt" DESC, id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
       )
       SELECT DISTINCT ON (day) "createdAt", "laterBullet", "laterBlitz", "laterRapid"
       FROM (SELECT *, ("createdAt" AT TIME ZONE 'UTC')::date AS day FROM later) r
       WHERE ($2::text IS NULL OR variant = $2::text)
       ORDER BY day, "createdAt" DESC, id DESC`,
      [userId, variant, since]
    );

    // Downsampled first, so only the points shown are formatted
    let sampled = rows;
    if (rows.length > MAX_HISTORY_POINTS) {
      const step = (rows.length - 1) / (MAX_HISTORY_POINTS - 1);
      sampled = Array.from({ length: MAX_HISTORY_POINTS }, (_, i) => rows[Math.round(i * step)]!);
    }
    return sampled.map((r) => {
      const ratings = {
        bullet: ratingOf(user, "bullet") - r.laterBullet,
        blitz: ratingOf(user, "blitz") - r.laterBlitz,
        rapid: ratingOf(user, "rapid") - r.laterRapid,
      };
      const rating =
        variant === null
          ? Math.round(VARIANTS.reduce((s, v) => s + ratings[v], 0) / VARIANTS.length)
          : ratings[variant];
      return { date: formatDate(r.createdAt), rating };
    });
  }

  /**
   * Ranks among listed players (see `listed`), the same players the
   * leaderboard shows. Players above and tied are counted (scans of a
   * partial rating index over listed players only); the players below follow
   * from the number of listed players, which is cached for everyone (see
   * listedTotal). Results are cached with the rest of the stats.
   */
  private async ranks(userId: number, variant: StatsVariant, rating: number) {
    const ratingExpr = (alias: string) =>
      variant === "all" ? allRatingExpr(alias) : `${alias}."${ratingColumns(variant).rating}"`;
    const [{ rows }, total] = await Promise.all([
      this.fastify.pg.query<{
        above: number;
        tied: number;
        selfListed: boolean;
        friendsAbove: number;
        friends: number;
      }>(
        `WITH friend_ids AS (
           SELECT "userTwoId" AS id FROM friends WHERE "userOneId" = $1
           UNION SELECT "userOneId" FROM friends WHERE "userTwoId" = $1)
         SELECT
           (SELECT COUNT(*) FROM users u WHERE ${listed(variant)} AND ${ratingExpr("u")} > $2)::int AS above,
           (SELECT COUNT(*) FROM users u WHERE ${listed(variant)} AND ${ratingExpr("u")} = $2)::int AS tied,
           EXISTS (SELECT 1 FROM users u WHERE u.id = $1 AND ${listed(variant)}) AS "selfListed",
           COUNT(*) FILTER (WHERE ${ratingExpr("f")} > $2)::int AS "friendsAbove",
           COUNT(*)::int AS friends
         FROM users f
         WHERE f.id IN (SELECT id FROM friend_ids) AND ${listed(variant, "f")}`,
        [userId, rating]
      ),
      this.listedTotal(variant),
    ]);
    const r = rows[0]!;
    // The total may be up to a minute old: keep the counts consistent
    const listedPlayers = Math.max(total, r.above + r.tied);
    const below = listedPlayers - r.above - r.tied;
    const others = listedPlayers - (r.selfListed ? 1 : 0);

    return {
      globalRank: r.above + 1,
      percentile: others > 0 ? Math.min(100, Math.round((below / others) * 100)) : 100,
      friendsRank: r.friendsAbove + 1,
      friendsCount: r.friends,
    };
  }

  /**
   * Listed players in a variant. The same number for everyone, so it is
   * cached once (shared with the leaderboard's total) instead of being
   * counted for every profile.
   */
  private listedTotal(variant: StatsVariant): Promise<number> {
    return cachedValue(
      this.fastify.redis,
      this.fastify.log,
      listedTotalCacheKey(variant),
      LISTED_TOTAL_CACHE_SECONDS,
      async () => {
        const { rows } = await this.fastify.pg.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM users u WHERE ${listed(variant)}`
        );
        return rows[0]!.n;
      },
      { staleSeconds: LISTED_TOTAL_CACHE_SECONDS }
    );
  }

  /** Serves from a short Redis cache; cleared for both players when their game ends. */
  private cached<T>(userId: number, field: string, compute: () => Promise<T>): Promise<T> {
    return cachedField(this.fastify.redis, this.fastify.log, statsCache(userId), field, STATS_CACHE_SECONDS, compute);
  }
}

export const STATS_CACHE_SECONDS = 60;
/** A user's game stats. */
export const statsCache = (userId: number): CacheGroup => ({
  key: `stats:${userId}`,
  generationKey: `stats:gen:${userId}`,
});
/** A user's puzzle card, apart from the game stats. */
export const puzzleStatsCache = (userId: number): CacheGroup => ({
  key: `stats:puzzle:${userId}`,
  generationKey: `stats:puzzle:gen:${userId}`,
});

/**
 * After a game ends (or is saved): drops the players' cached game stats and
 * their own leaderboard positions (every time control: the game's isn't
 * known here, and it's one DEL either way). Throws if Redis fails.
 */
export const invalidateStats = (redis: FastifyInstance["redis"], userIds: number[]) =>
  invalidateCacheGroups(
    redis,
    userIds.map(statsCache),
    userIds.flatMap((id) => VARIANTS.map((variant) => myPositionCacheKey(variant, id)))
  );
/** After a rated puzzle attempt: the puzzle card and the puzzle leaderboard position. Throws if Redis fails. */
export const invalidatePuzzleStats = (redis: FastifyInstance["redis"], userId: number) =>
  invalidateCacheGroups(redis, [puzzleStatsCache(userId)], [myPositionCacheKey("puzzle", userId)]);

/** Must match the expression index in migration 014. */
const allRatingExpr = (alias: string) =>
  `ROUND((${alias}."bulletRating" + ${alias}."blitzRating" + ${alias}."rapidRating") / 3.0)`;
