import type { TimeControl } from "./common.js";
export type { TimeControl };
export { getTimeControl } from "./common.js";

export interface MatchmakingRequest {
  id: number;
  createdAt: Date;
  rating: number;
  time: number;
  increment: number | null;
  userId: number;
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
