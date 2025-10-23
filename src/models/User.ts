type UserStatus = "online" | "offline" | "in_game";

export type UserSkill = "new" | "beginner" | "intermediate" | "advanced";

export interface User {
  id: number;
  username: string;
  email: string;
  password: string;
  createdAt: Date;
  rapidRating: number;
  blitzRating: number;
  bulletRating: number;
  highestRapidRating: number;
  highestBlitzRating: number;
  highestBulletRating: number;
  status: UserStatus;
}

export interface UserResponse {
  id: number;
  username: string;
  createdAt: Date;
  rapidRating: number;
  blitzRating: number;
  bulletRating: number;
  highestRapidRating: number;
  highestBlitzRating: number;
  highestBulletRating: number;
}

export interface SignupRequest {
  email: string;
  username: string;
  password: string;
  skill: UserSkill;
}

export interface CreateUserData {
  email: string;
  username: string;
  password_hash: string;
  rapidRating: number;
  blitzRating: number;
  bulletRating: number;
  highestRapidRating: number;
  highestBlitzRating: number;
  highestBulletRating: number;
}

export interface SigninRequest {
  emailOrUsername: string;
  password: string;
}

export interface SigninResponse {
  success: boolean;
  message: string;
  user?: UserResponse;
}
