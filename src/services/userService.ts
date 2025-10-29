import type { FastifyInstance } from "fastify";
import type {
  UserResponse,
  SignupRequest,
  SigninRequest,
} from "../models/User.js";
import { UserRepository } from "../repositories/userRepository.js";
import { SettingsRepository } from "../repositories/settingsRepository.js";
import bcrypt from "bcrypt";
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

  async signup(signupData: SignupRequest): Promise<UserResponse> {
    // Check if email already exists
    const existingEmail = await this.userRepository.findByEmail(
      signupData.email
    );
    if (existingEmail) {
      throw new Error("Email already exists");
    }

    // Check if username already exists
    const existingUsername = await this.userRepository.findByUsername(
      signupData.username
    );
    if (existingUsername) {
      throw new Error("Username already exists");
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(signupData.password, salt);

    // Get rating based on skill level
    const rating = getRatingsBySkill(signupData.skill);

    // Create user
    const newUser = await this.userRepository.create({
      email: signupData.email,
      username: signupData.username,
      password_hash,
      rapidRating: rating,
      blitzRating: rating,
      bulletRating: rating,
      highestRapidRating: rating,
      highestBlitzRating: rating,
      highestBulletRating: rating,
    });

    // Create default settings for the new user
    await this.settingsRepository.createDefaultSettings(newUser.id);

    // Return user data
    return newUser;
  }

  async signin(signinData: SigninRequest): Promise<UserResponse> {
    // Find user by email or username
    const user = await this.userRepository.findByEmailOrUsername(
      signinData.emailOrUsername
    );

    if (!user) {
      throw new Error("Invalid credentials");
    }

    // Compare password with bcrypt
    const isPasswordValid = await bcrypt.compare(
      signinData.password,
      user.password
    );

    if (!isPasswordValid) {
      throw new Error("Invalid credentials");
    }

    // Return user data (excluding password and status)
    return {
      id: user.id,
      username: user.username,
      createdAt: user.createdAt,
      rapidRating: user.rapidRating,
      blitzRating: user.blitzRating,
      bulletRating: user.bulletRating,
      highestRapidRating: user.highestRapidRating,
      highestBlitzRating: user.highestBlitzRating,
      highestBulletRating: user.highestBulletRating,
    };
  }

  async changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string
  ): Promise<void> {
    // Get current password hash
    const currentPasswordHash = await this.userRepository.getPasswordHash(
      userId
    );

    if (!currentPasswordHash) {
      throw new Error("User not found");
    }

    // Verify old password
    const isPasswordValid = await bcrypt.compare(
      oldPassword,
      currentPasswordHash
    );

    if (!isPasswordValid) {
      throw new Error("Invalid old password");
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, salt);

    // Update password
    await this.userRepository.updatePassword(userId, newPasswordHash);
  }

  async changeEmail(userId: number, newEmail: string): Promise<void> {
    // Check if new email already exists
    const existingUser = await this.userRepository.findByEmail(newEmail);

    if (existingUser && existingUser.id !== userId) {
      throw new Error("Email already in use");
    }

    // Update email
    await this.userRepository.updateEmail(userId, newEmail);
  }
}
