import type { TimeControl } from "./common.js";
export type { TimeControl };
export { getTimeControl } from "./common.js";

export interface MatchmakingRequest {
  id: number;
  createdAt: Date;
  rating: number;
  time: number;
  increment: number;
  userId: number;
}
