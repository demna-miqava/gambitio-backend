import type { FastifyInstance } from "fastify";
import { getTimeControl, ratingColumns, type TimeControl } from "../models/common.js";
import { AppError } from "../errors/AppError.js";

export type StatsVariant = TimeControl | "all";
const VARIANTS: TimeControl[] = ["bullet", "blitz", "rapid"];
const MAX_HISTORY_POINTS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

interface PlayedGame {
  createdAt: Date;
  variant: TimeControl;
  ratingBefore: number;
  change: number;
  opponentRating: number;
  outcome: "win" | "draw" | "loss";
}

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

function counts(games: PlayedGame[]) {
  const wins = games.filter((g) => g.outcome === "win").length;
  const draws = games.filter((g) => g.outcome === "draw").length;
  return { totalGames: games.length, wins, draws, losses: games.length - wins - draws };
}

/** Profile statistics computed from finished, rated (non-aborted, not against a bot) games. */
export class StatsService {
  constructor(private fastify: FastifyInstance) {}

  private async load(userId: number) {
    const { rows: users } = await this.fastify.pg.query<UserRatings>(
      `SELECT "createdAt", "bulletRating", "blitzRating", "rapidRating",
              "highestBulletRating", "highestBlitzRating", "highestRapidRating"
       FROM users WHERE id = $1`,
      [userId]
    );
    const user = users[0];
    if (!user) throw new AppError("User not found", "USER_NOT_FOUND", 404);

    const { rows } = await this.fastify.pg.query<{
      createdAt: Date;
      time: number;
      ratingBefore: number;
      change: number | null;
      opponentRating: number;
      outcome: PlayedGame["outcome"];
    }>(
      `SELECT "createdAt", time,
         CASE WHEN "whiteId" = $1 THEN "whiteRating" ELSE "blackRating" END AS "ratingBefore",
         CASE WHEN "whiteId" = $1 THEN "whiteRatingChange" ELSE "blackRatingChange" END AS change,
         CASE WHEN "whiteId" = $1 THEN "blackRating" ELSE "whiteRating" END AS "opponentRating",
         CASE WHEN "winnerId" = $1 THEN 'win' WHEN "winnerId" IS NULL THEN 'draw' ELSE 'loss' END AS outcome
       FROM games
       WHERE ("whiteId" = $1 OR "blackId" = $1) AND status = 'finished' AND result <> 'aborted'
         AND rated
       ORDER BY "createdAt"`,
      [userId]
    );
    const games: PlayedGame[] = rows.map((r) => ({
      createdAt: r.createdAt,
      variant: getTimeControl(r.time),
      ratingBefore: r.ratingBefore,
      change: r.change ?? 0,
      opponentRating: r.opponentRating,
      outcome: r.outcome,
    }));
    return { user, games };
  }

  /** Per-variant cards: GET /users/:id/stats/summary */
  async getSummary(userId: number) {
    return this.cached(userId, "summary", () => this.computeSummary(userId));
  }

  private async computeSummary(userId: number) {
    const { user, games } = await this.load(userId);
    const since30 = Date.now() - 30 * DAY_MS;

    const stats = Object.fromEntries(
      VARIANTS.map((variant) => {
        const played = games.filter((g) => g.variant === variant);
        const highestRating = highestOf(user, variant);
        // Most recent game that ended at the peak rating
        const peakGame = [...played].reverse().find((g) => g.ratingBefore + g.change === highestRating);
        const c = counts(played);
        return [
          variant,
          {
            rating: ratingOf(user, variant),
            delta: played
              .filter((g) => g.createdAt.getTime() >= since30)
              .reduce((sum, g) => sum + g.change, 0),
            highestRating,
            highestDate: formatDate(peakGame?.createdAt ?? user.createdAt),
            wins: c.wins,
            losses: c.losses,
            draws: c.draws,
            games: c.totalGames,
          },
        ];
      })
    );
    return { numberOfGames: games.length, stats, puzzle: await this.puzzleSummary(userId) };
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
    const { user, games } = await this.load(userId);
    const since = days === null ? 0 : Date.now() - days * DAY_MS;
    const inVariant = variant === "all" ? games : games.filter((g) => g.variant === variant);
    const inPeriod = inVariant.filter((g) => g.createdAt.getTime() >= since);

    const current = (u: UserRatings) =>
      variant === "all"
        ? Math.round(VARIANTS.reduce((s, v) => s + ratingOf(u, v), 0) / VARIANTS.length)
        : ratingOf(u, variant);
    const currentRating = current(user);
    const highestRating =
      variant === "all" ? Math.max(...VARIANTS.map((v) => highestOf(user, v))) : highestOf(user, variant);

    const wins = inPeriod.filter((g) => g.outcome === "win");
    let streak = 0;
    let winStreak = 0;
    for (const g of inPeriod) {
      streak = g.outcome === "win" ? streak + 1 : 0;
      winStreak = Math.max(winStreak, streak);
    }

    return {
      currentRating,
      ratingGain: inPeriod.reduce((sum, g) => sum + g.change, 0),
      highestRating,
      ...counts(inPeriod),
      ratingHistory: this.history(user, games, variant, since),
      averageRating: inPeriod.length
        ? Math.round(inPeriod.reduce((s, g) => s + g.opponentRating, 0) / inPeriod.length)
        : 0,
      bestWin: wins.length ? Math.max(...wins.map((g) => g.opponentRating)) : 0,
      winStreak,
      ...(await this.ranks(userId, variant, currentRating)),
    };
  }

  /**
   * Rating after each game, one point per day (last game of the day),
   * downsampled to MAX_HISTORY_POINTS. For "all", the value is the average of
   * the three variant ratings at that time.
   */
  private history(user: UserRatings, games: PlayedGame[], variant: StatsVariant, since: number) {
    // Rating per variant before the first game: current rating minus all changes since
    const ratings = Object.fromEntries(
      VARIANTS.map((v) => [
        v,
        ratingOf(user, v) - games.filter((g) => g.variant === v).reduce((s, g) => s + g.change, 0),
      ])
    ) as Record<TimeControl, number>;

    const value = () =>
      variant === "all"
        ? Math.round(VARIANTS.reduce((s, v) => s + ratings[v], 0) / VARIANTS.length)
        : ratings[variant];

    const byDay = new Map<string, { date: string; rating: number }>();
    for (const g of games) {
      ratings[g.variant] += g.change;
      if (variant !== "all" && g.variant !== variant) continue;
      if (g.createdAt.getTime() < since) continue;
      const day = g.createdAt.toISOString().slice(0, 10);
      byDay.set(day, { date: formatDate(g.createdAt), rating: value() });
    }

    const points = [...byDay.values()];
    if (points.length <= MAX_HISTORY_POINTS) return points;
    const step = (points.length - 1) / (MAX_HISTORY_POINTS - 1);
    return Array.from({ length: MAX_HISTORY_POINTS }, (_, i) => points[Math.round(i * step)]!);
  }

  /**
   * Ranks by counting users above/below the rating. Each count is an
   * index-only scan on the rating index (migration 004), so it stays cheap as
   * the users table grows; results are cached with the rest of the stats.
   */
  private async ranks(userId: number, variant: StatsVariant, rating: number) {
    const ratingExpr = variant === "all" ? ALL_RATING_EXPR : `"${ratingColumns(variant).rating}"`;
    const count = async (where: string, values: unknown[]) => {
      const { rows } = await this.fastify.pg.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM users WHERE ${where}`,
        values
      );
      return Number(rows[0]!.n);
    };

    const [above, below, total] = await Promise.all([
      count(`${ratingExpr} > $1`, [rating]),
      count(`${ratingExpr} < $1`, [rating]),
      count("true", []),
    ]);
    const { rows: friends } = await this.fastify.pg.query<{ above: string; total: string }>(
      `WITH friend_ids AS (
         SELECT "userTwoId" AS id FROM friends WHERE "userOneId" = $1
         UNION SELECT "userOneId" FROM friends WHERE "userTwoId" = $1)
       SELECT COUNT(*) FILTER (WHERE ${ratingExpr} > $2) AS above, COUNT(*) AS total
       FROM users WHERE id IN (SELECT id FROM friend_ids)`,
      [userId, rating]
    );

    return {
      globalRank: above + 1,
      percentile: total > 1 ? Math.round((below / (total - 1)) * 100) : 100,
      friendsRank: Number(friends[0]!.above) + 1,
      friendsCount: Number(friends[0]!.total),
    };
  }

  /** Serves from a short Redis cache; cleared for both players when their game ends. */
  private async cached<T>(userId: number, field: string, compute: () => Promise<T>): Promise<T> {
    const key = statsCacheKey(userId);
    const hit = await this.fastify.redis.hGet(key, field);
    if (hit) return JSON.parse(hit) as T;
    const value = await compute();
    await this.fastify.redis
      .multi()
      .hSet(key, field, JSON.stringify(value))
      .expire(key, STATS_CACHE_SECONDS, "NX")
      .exec();
    return value;
  }
}

const STATS_CACHE_SECONDS = 60;
export const statsCacheKey = (userId: number) => `stats:${userId}`;

/** Must match the expression index in migration 004. */
const ALL_RATING_EXPR = `ROUND(("bulletRating" + "blitzRating" + "rapidRating") / 3.0)`;
