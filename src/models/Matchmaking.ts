export type TimeControl = "bullet" | "blitz" | "rapid";

export interface MatchmakingRequest {
  id: number;
  createdAt: Date;
  rating: number;
  time: number;
  increment: number | null;
  userId: number;
}

export interface MatchmakingSearchParams {
  time: number;
  increment: number | null;
  rating: number;
  ratingRange: number;
  excludeUserId: number;
}

export interface MatchFound {
  matchId: number;
  opponentId: number;
  opponentRating: number;
  time: number;
  increment: number | null;
}

export interface MatchmakingMessage {
  type: "find_match" | "cancel_match" | "match_found" | "searching" | "error";
  data?: {
    time?: number;
    increment?: number | null | undefined;
    rating?: number;
    matchId?: number;
    opponentId?: number;
    opponentUsername?: string;
    opponentRating?: number;
    gameId?: number;
    color?: "white" | "black";
    message?: string;
  };
}

// Helper to determine time control type
export function getTimeControl(time: number): TimeControl {
  const totalSeconds = time;
  if (totalSeconds < 180) return "bullet"; // < 3 minutes
  if (totalSeconds < 600) return "blitz"; // < 10 minutes
  return "rapid";
}
