import type { FastifyInstance } from "fastify";
import type { UserResponse, SyncUserRequest } from "../models/User.js";
import { UserRepository } from "../repositories/userRepository.js";
import { SettingsRepository } from "../repositories/settingsRepository.js";
import { getRatingsBySkill } from "../utils/ratingHelpers.js";

export class UserService {
  private userRepository: UserRepository;
  private settingsRepository: SettingsRepository;

  constructor(fastify: FastifyInstance) {
    this.userRepository = new UserRepository(fastify);
    this.settingsRepository = new SettingsRepository(fastify);
  }

  async getUserById(id: number): Promise<UserResponse | null> {
    return await this.userRepository.findById(id);
  }

  async getUserByClerkId(clerkId: string): Promise<UserResponse | null> {
    return await this.userRepository.findByClerkId(clerkId);
  }

  /**
   * Sync/create user from Clerk
   * Called after user authenticates with Clerk for the first time
   * Creates local user record with chess-specific data
   */
  async syncUser(
    clerkId: string,
    email: string,
    syncData: SyncUserRequest
  ): Promise<UserResponse> {
    // Check if user already exists
    const existingUser = await this.userRepository.findByClerkId(clerkId);
    if (existingUser) {
      return existingUser;
    }

    // Check if username is taken
    const existingUsername = await this.userRepository.findByUsername(
      syncData.username
    );
    if (existingUsername) {
      throw new Error("Username already exists");
    }

    // Get rating based on skill level
    const rating = getRatingsBySkill(syncData.skill);

    // Create user
    const newUser = await this.userRepository.create({
      clerkId,
      email,
      username: syncData.username,
      rapidRating: rating,
      blitzRating: rating,
      bulletRating: rating,
      highestRapidRating: rating,
      highestBlitzRating: rating,
      highestBulletRating: rating,
    });

    // Create default settings for the new user
    await this.settingsRepository.createDefaultSettings(newUser.id);

    return newUser;
  }

  /**
   * Check if a username is available
   */
  async isUsernameAvailable(username: string): Promise<boolean> {
    const existingUser = await this.userRepository.findByUsername(username);
    return !existingUser;
  }

  /**
   * Update username for a user
   */
  async updateUsername(clerkId: string, newUsername: string): Promise<void> {
    // Check if username is taken
    const existingUser = await this.userRepository.findByUsername(newUsername);
    if (existingUser && existingUser.clerkId !== clerkId) {
      throw new Error("Username already exists");
    }

    await this.userRepository.updateUsername(clerkId, newUsername);
  }
}
