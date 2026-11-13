import type { FastifyInstance } from "fastify";
import { LeaderboardRepository } from "../repositories/leaderboardRepository.js";
import {
  assignRanks,
  type LeaderboardResponse,
  type LeaderboardScope,
  type LeaderboardVariant,
} from "../models/Leaderboard.js";

const GLOBAL_CACHE_SECONDS = 30;
export const leaderboardCacheKey = (variant: LeaderboardVariant, page: number, limit: number) =>
  `leaderboard:global:${variant}:${limit}:${page}`;

type Page = Pick<LeaderboardResponse, "data" | "pagination">;

/**
 * Leaderboards per variant, global or among friends (friends scope includes
 * the user themself).
 *
 * Ranking: rating DESC; equal ratings share a rank (competition ranking:
 * 1, 2, 2, 4) and are listed by user id ASC (older account first). Only
 * players with a rated game in the variant are listed (see
 * LeaderboardRepository). Global pages are cached for GLOBAL_CACHE_SECONDS;
 * the caller's own entry ("me") is always computed fresh.
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
    const [pageData, position] = await Promise.all([
      scope === "global" ? this.cachedGlobal(variant, page, limit, computePage) : computePage(),
      this.repository.findPosition(variant, { scope, userId }),
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
      this.repository.count(variant, { scope, userId }),
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

  private async cachedGlobal(
    variant: LeaderboardVariant,
    page: number,
    limit: number,
    compute: () => Promise<Page>
  ): Promise<Page> {
    const key = leaderboardCacheKey(variant, page, limit);
    const hit = await this.fastify.redis.get(key);
    if (hit) return JSON.parse(hit) as Page;
    const value = await compute();
    await this.fastify.redis.setEx(key, GLOBAL_CACHE_SECONDS, JSON.stringify(value));
    return value;
  }
}
