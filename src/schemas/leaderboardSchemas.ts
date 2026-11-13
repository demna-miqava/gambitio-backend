import { z } from "zod";
import { paginationSchema } from "./pagination.js";
import { LEADERBOARD_SCOPES, LEADERBOARD_VARIANT_NAMES } from "../models/Leaderboard.js";

/** GET /leaderboard?variant=blitz&scope=global&page=1&limit=10 */
export const leaderboardQuerySchema = paginationSchema.extend({
  variant: z.enum(LEADERBOARD_VARIANT_NAMES).default("blitz"),
  scope: z.enum(LEADERBOARD_SCOPES).default("global"),
});
