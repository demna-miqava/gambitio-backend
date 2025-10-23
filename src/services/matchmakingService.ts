import type { FastifyInstance } from "fastify";
import type { MatchmakingRequest, TimeControl } from "../models/Matchmaking.js";
import { MatchmakingRepository } from "../repositories/matchmakingRepository.js";
import { getTimeControl } from "../models/Matchmaking.js";

export class MatchmakingService {
  private matchmakingRepository: MatchmakingRepository;
  private readonly INITIAL_RATING_RANGE = 50;
  private readonly RATING_RANGE_INCREMENT = 50;
  private readonly MAX_RATING_RANGE = 500; // Max range to prevent infinite expansion

  constructor(fastify: FastifyInstance) {
    this.matchmakingRepository = new MatchmakingRepository(fastify);
  }

  /**
   * Create a matchmaking request
   */
  async createMatchmakingRequest(
    userId: number,
    rating: number,
    time: number,
    increment: number | null
  ): Promise<MatchmakingRequest> {
    // First, clean up any existing requests from this user
    await this.matchmakingRepository.deleteByUserId(userId);

    // Create new request
    return await this.matchmakingRepository.create(
      userId,
      rating,
      time,
      increment
    );
  }

  /**
   * Find a match with expanding rating range
   * Starts with ±50 rating and expands by 50 each iteration
   */
  async findMatchWithExpandingRange(
    time: number,
    increment: number | null,
    rating: number,
    currentUserId: number
  ): Promise<MatchmakingRequest | null> {
    const timeControl = getTimeControl(time);
    let ratingRange = this.INITIAL_RATING_RANGE;

    // Try to find a match with expanding rating range
    while (ratingRange <= this.MAX_RATING_RANGE) {
      const match = await this.matchmakingRepository.findMatch(
        time,
        increment,
        rating,
        ratingRange,
        currentUserId,
        timeControl
      );

      if (match) {
        return match;
      }

      // Expand the range
      ratingRange += this.RATING_RANGE_INCREMENT;
    }

    return null;
  }

  /**
   * Cancel matchmaking request for a user
   */
  async cancelMatchmaking(userId: number): Promise<void> {
    await this.matchmakingRepository.deleteByUserId(userId);
  }

  /**
   * Delete matchmaking request by ID (used when match is found)
   */
  async deleteMatchmakingRequest(id: number): Promise<void> {
    await this.matchmakingRepository.deleteById(id);
  }
}
