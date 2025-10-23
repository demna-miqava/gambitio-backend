import type { FastifyInstance } from "fastify";
import type {
  UserResponse,
  SignupRequest,
  SigninRequest,
  SigninResponse,
} from "../models/User.js";
import { UserRepository } from "../repositories/userRepository.js";
import bcrypt from "bcrypt";
import { getRatingsBySkill } from "../utils/ratingHelpers.js";

export class UserService {
  private userRepository: UserRepository;

  constructor(fastify: FastifyInstance) {
    this.userRepository = new UserRepository(fastify);
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

    return newUser;
  }

  async signin(signinData: SigninRequest): Promise<SigninResponse> {
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

    // Return success with user data (excluding password and status)
    return {
      success: true,
      message: "Signin successful",
      user: {
        id: user.id,
        username: user.username,
        createdAt: user.createdAt,
        rapidRating: user.rapidRating,
        blitzRating: user.blitzRating,
        bulletRating: user.bulletRating,
        highestRapidRating: user.highestRapidRating,
        highestBlitzRating: user.highestBlitzRating,
        highestBulletRating: user.highestBulletRating,
      },
    };
  }
}
