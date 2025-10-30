/**
 * Notification WebSocket Message Types
 * Handles challenges and other real-time notifications
 */

export interface ChallengeSentData {
  challengedId: number;
  color: "white" | "black" | "random";
  time: number;
  increment: number;
}

export interface ChallengeReceivedData {
  challengerId: number;
  username: string;
  avatarUrl: string;
  time: number;
  increment: number;
}

export interface ChallengeDeclinedData {
  challengerId: number;
}

export interface ChallengeAcceptedData {
  challengerId: number;
}

export interface MatchCreatedData {
  gameId: number;
  opponentId: number;
  opponentUsername: string;
  opponentRating: number;
  rating: number;
  time: number;
  increment: number | null;
  color: "white" | "black";
}

export type NotificationMessage =
  | { type: "challenge_sent"; data: ChallengeSentData }
  | { type: "challenge_received"; data: ChallengeReceivedData }
  | { type: "challenge_declined"; data?: ChallengeDeclinedData }
  | { type: "challenge_accepted"; data: ChallengeAcceptedData }
  | { type: "match_created"; data: MatchCreatedData }
  | { type: "opponent_unavailable" }
  | { type: "error"; data: { message: string } };
