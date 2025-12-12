type UserStatus = "online" | "offline" | "in_game";

export type UserSkill = "new" | "beginner" | "intermediate" | "advanced";

export interface User {
  id: number;
  clerkId: string; // Clerk user ID (e.g., "user_2NNE...")
  username: string;
  email: string;
  createdAt: Date;
  rapidRating: number;
  blitzRating: number;
  bulletRating: number;
  highestRapidRating: number;
  highestBlitzRating: number;
  highestBulletRating: number;
  status: UserStatus;
  avatarUrl?: string | null;
}

export interface UserResponse {
  id: number;
  clerkId: string;
  username: string;
  createdAt: Date;
  rapidRating: number;
  blitzRating: number;
  bulletRating: number;
  highestRapidRating: number;
  highestBlitzRating: number;
  highestBulletRating: number;
}

// Data needed to create a new user from Clerk
export interface CreateClerkUserData {
  clerkId: string;
  email: string;
  username: string;
  rapidRating: number;
  blitzRating: number;
  bulletRating: number;
  highestRapidRating: number;
  highestBlitzRating: number;
  highestBulletRating: number;
}

// Request to sync/create user from Clerk (called after Clerk auth)
export interface SyncUserRequest {
  username: string;
  skill: UserSkill;
}
