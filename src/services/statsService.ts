import type { FastifyInstance } from "fastify";
import { ratingColumns, type TimeControl } from "../models/common.js";
import { AppError } from "../errors/AppError.js";
import { cachedField } from "../utils/cache.js";

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

const formatDate = (date: Date) =>
  date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * The user's ($1) finished, rated games (non-aborted, not against a bot),
 * one row each, from their side of the board. The variant thresholds must
 * match getTimeControl (src/models/common.ts).
 */
const PLAYED = `
  SELECT g.id, g."createdAt",
    CASE WHEN g.time < 180 THEN 'bullet' WHEN g.time < 600 THEN 'blitz' ELSE 'rapid' END AS variant,
    CASE WHEN g."whiteId" = $1 THEN g."whiteRating" ELSE g."blackRating" END AS before,
    COALESCE(CASE WHEN g."whiteId" = $1 THEN g."whiteRatingChange" ELSE g."blackRatingChange" END, 0) AS change,
    CASE WHEN g."whiteId" = $1 THEN g."blackRating" ELSE g."whiteRating" END AS opponent,
    CASE WHEN g."winnerId" = $1 THEN 'win' WHEN g."winnerId" IS NULL THEN 'draw' ELSE 'loss' END AS outcome
  FROM games g
  WHERE (g."whiteId" = $1 OR g."blackId" = $1) AND g.status = 'finished' AND g.result <> 'aborted'
    AND g.rated`;

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

  /** Per-variant cards: GET /users/:id/stats/summary */
  async getSummary(userId: number) {
    return this.cached(userId, "summary", () => this.computeSummary(userId));
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
    return { numberOfGames, stats, puzzle: await this.puzzleSummary(userId) };
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
   * the three variant ratings at that time. Each variant's rating after a
   * game is its rating before the first game (current rating minus every
   * change since) plus the changes up to that game.
   */
  private async history(userId: number, user: UserRatings, variant: TimeControl | null, since: Date) {
    const { rows } = await this.fastify.pg.query<{
      createdAt: Date;
      bullet: number;
      blitz: number;
      rapid: number;
      totalBullet: number;
      totalBlitz: number;
      totalRapid: number;
    }>(
      `WITH played AS (${PLAYED}),
       running AS (
         SELECT id, "createdAt", variant,
           COALESCE(SUM(change) FILTER (WHERE variant = 'bullet') OVER w, 0)::int AS bullet,
           COALESCE(SUM(change) FILTER (WHERE variant = 'blitz') OVER w, 0)::int AS blitz,
           COALESCE(SUM(change) FILTER (WHERE variant = 'rapid') OVER w, 0)::int AS rapid,
           COALESCE(SUM(change) FILTER (WHERE variant = 'bullet') OVER (), 0)::int AS "totalBullet",
           COALESCE(SUM(change) FILTER (WHERE variant = 'blitz') OVER (), 0)::int AS "totalBlitz",
           COALESCE(SUM(change) FILTER (WHERE variant = 'rapid') OVER (), 0)::int AS "totalRapid"
         FROM played
         WINDOW w AS (ORDER BY "createdAt", id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
       )
       SELECT DISTINCT ON (day) "createdAt", bullet, blitz, rapid, "totalBullet", "totalBlitz", "totalRapid"
       FROM (SELECT *, ("createdAt" AT TIME ZONE 'UTC')::date AS day FROM running) r
       WHERE ($2::text IS NULL OR variant = $2::text) AND "createdAt" >= $3
       ORDER BY day, "createdAt" DESC, id DESC`,
      [userId, variant, since]
    );

    const points = rows.map((r) => {
      const ratings = {
        bullet: ratingOf(user, "bullet") - r.totalBullet + r.bullet,
        blitz: ratingOf(user, "blitz") - r.totalBlitz + r.blitz,
        rapid: ratingOf(user, "rapid") - r.totalRapid + r.rapid,
      };
      const rating =
        variant === null
          ? Math.round(VARIANTS.reduce((s, v) => s + ratings[v], 0) / VARIANTS.length)
          : ratings[variant];
      return { date: formatDate(r.createdAt), rating };
    });

    if (points.length <= MAX_HISTORY_POINTS) return points;
    const step = (points.length - 1) / (MAX_HISTORY_POINTS - 1);
    return Array.from({ length: MAX_HISTORY_POINTS }, (_, i) => points[Math.round(i * step)]!);
  }

  /**
   * Ranks among listed players (see `listed`), the same players the
   * leaderboard shows. Each count is a scan of a partial rating index over
   * listed players only; results are cached with the rest of the stats.
   */
  private async ranks(userId: number, variant: StatsVariant, rating: number) {
    const ratingExpr = (alias: string) =>
      variant === "all" ? allRatingExpr(alias) : `${alias}."${ratingColumns(variant).rating}"`;
    const { rows } = await this.fastify.pg.query<{
      above: number;
      below: number;
      others: number;
      friendsAbove: number;
      friends: number;
    }>(
      `WITH friend_ids AS (
         SELECT "userTwoId" AS id FROM friends WHERE "userOneId" = $1
         UNION SELECT "userOneId" FROM friends WHERE "userTwoId" = $1)
       SELECT
         (SELECT COUNT(*) FROM users u WHERE ${listed(variant)} AND ${ratingExpr("u")} > $2)::int AS above,
         (SELECT COUNT(*) FROM users u WHERE ${listed(variant)} AND ${ratingExpr("u")} < $2)::int AS below,
         (SELECT COUNT(*) FROM users u WHERE ${listed(variant)} AND u.id <> $1)::int AS others,
         COUNT(*) FILTER (WHERE ${ratingExpr("f")} > $2)::int AS "friendsAbove",
         COUNT(*)::int AS friends
       FROM users f
       WHERE f.id IN (SELECT id FROM friend_ids) AND ${listed(variant, "f")}`,
      [userId, rating]
    );
    const r = rows[0]!;

    return {
      globalRank: r.above + 1,
      percentile: r.others > 0 ? Math.round((r.below / r.others) * 100) : 100,
      friendsRank: r.friendsAbove + 1,
      friendsCount: r.friends,
    };
  }

  /** Serves from a short Redis cache; cleared for both players when their game ends. */
  private cached<T>(userId: number, field: string, compute: () => Promise<T>): Promise<T> {
    return cachedField(this.fastify.redis, this.fastify.log, statsCacheKey(userId), field, STATS_CACHE_SECONDS, compute);
  }
}

export const STATS_CACHE_SECONDS = 60;
export const statsCacheKey = (userId: number) => `stats:${userId}`;

/** Must match the expression index in migration 014. */
const allRatingExpr = (alias: string) =>
  `ROUND((${alias}."bulletRating" + ${alias}."blitzRating" + ${alias}."rapidRating") / 3.0)`;
