import type { FastifyInstance } from "fastify";
import { LeaderboardRepository } from "../repositories/leaderboardRepository.js";
import {
  assignRanks,
  type LeaderboardResponse,
  type LeaderboardScope,
  type LeaderboardVariant,
} from "../models/Leaderboard.js";
import { cachedValue } from "../utils/cache.js";

const GLOBAL_CACHE_SECONDS = 30;
/**
 * "v2": cachedValue stores {v, freshUntil}, while code from before it did
 * reads `leaderboard:global:*` as the page itself. A new name keeps both
 * working while instances of each run side by side.
 */
export const leaderboardCacheKey = (variant: LeaderboardVariant, page: number, limit: number) =>
  `leaderboard:v2:global:${variant}:${limit}:${page}`;
/**
 * The caller's own global position: a count over everyone above them, so not
 * on every request. Dropped when their rating changes (a game ends, a rated
 * puzzle attempt), see invalidateStats and invalidatePuzzleStats.
 */
const MY_POSITION_CACHE_SECONDS = 30;
export const myPositionCacheKey = (variant: LeaderboardVariant, userId: number) =>
  `leaderboard:me:${variant}:${userId}`;

/**
 * Listed players per variant (bullet, blitz, rapid, puzzle, and "all" for
 * profile stats), the same number for everyone. Shared by the leaderboard's
 * page count and the profile percentile (StatsService), whose filters for a
 * variant are the same.
 */
export const LISTED_TOTAL_CACHE_SECONDS = 60;
export const listedTotalCacheKey = (variant: string) => `listed:total:${variant}`;

type Page = Pick<LeaderboardResponse, "data" | "pagination">;

/**
 * Leaderboards per variant, global or among friends (friends scope includes
 * the user themself).
 *
 * Ranking: rating DESC; equal ratings share a rank (competition ranking:
 * 1, 2, 2, 4) and are listed by user id ASC (older account first). Only
 * players with a rated game in the variant are listed (see
 * LeaderboardRepository). Global pages are cached for GLOBAL_CACHE_SECONDS,
 * the number of listed players for LISTED_TOTAL_CACHE_SECONDS, and the
 * caller's own global entry ("me") for MY_POSITION_CACHE_SECONDS. The
 * friends scope is small and always computed fresh.
 */
export class LeaderboardService {
  private repository: LeaderboardRepository;

  constructor(private fastify: FastifyInstance) {
    this.repository = new LeaderboardRepository(fastify);
  }

  async getLeaderboard(params: {
    userId: number;
    variant: LeaderboardVariant;
    scope: LeaderboardScope;
    page: number;
    limit: number;
  }): Promise<LeaderboardResponse> {
    const { userId, variant, scope, page, limit } = params;
    const computePage = () => this.computePage(userId, variant, scope, page, limit);
    const findPosition = () => this.repository.findPosition(variant, { scope, userId });
    const [pageData, position] = await Promise.all([
      scope === "global" ? this.cachedGlobal(variant, page, limit, computePage) : computePage(),
      scope === "global"
        ? cachedValue(
            this.fastify.redis,
            this.fastify.log,
            myPositionCacheKey(variant, userId),
            MY_POSITION_CACHE_SECONDS,
            findPosition
          )
        : findPosition(),
    ]);

    return {
      variant,
      scope,
      ...pageData,
      me: position && {
        ...position.entry,
        rank: position.above + 1,
        page: Math.floor((position.above + position.tiedAhead) / limit) + 1,
      },
    };
  }

  private async computePage(
    userId: number,
    variant: LeaderboardVariant,
    scope: LeaderboardScope,
    page: number,
    limit: number
  ): Promise<Page> {
    const offset = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      this.repository.findPage(variant, { scope, userId }, limit, offset),
      scope === "global" ? this.globalTotal(variant) : this.repository.count(variant, { scope, userId }),
    ]);
    // The first row may tie with rows on the previous page
    const firstRank = rows.length
      ? (await this.repository.count(variant, { scope, userId }, rows[0]!.rating)) + 1
      : 0;
    return {
      data: assignRanks(rows, offset, firstRank),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Listed players in the variant, cached once for every page and profile. */
  private globalTotal(variant: LeaderboardVariant): Promise<number> {
    return cachedValue(
      this.fastify.redis,
      this.fastify.log,
      listedTotalCacheKey(variant),
      LISTED_TOTAL_CACHE_SECONDS,
      () => this.repository.count(variant, { scope: "global", userId: 0 }),
      { staleSeconds: LISTED_TOTAL_CACHE_SECONDS }
    );
  }

  private cachedGlobal(
    variant: LeaderboardVariant,
    page: number,
    limit: number,
    compute: () => Promise<Page>
  ): Promise<Page> {
    const key = leaderboardCacheKey(variant, page, limit);
    return cachedValue(this.fastify.redis, this.fastify.log, key, GLOBAL_CACHE_SECONDS, compute);
  }
}
