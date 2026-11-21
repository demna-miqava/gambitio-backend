import { z } from "zod";
import { paginationSchema } from "./pagination.js";

/**
 * GET /users/:userId/games: the page, plus optional filters that combine.
 * Every filter is optional, so callers that send only page and limit (the
 * Home page's recent games) get the history as before. Each value is bound
 * as a SQL parameter (repositories/gameHistory.ts), never written into the
 * query.
 */
export const gameHistoryQuery = paginationSchema
  .extend({
    /** From the profile owner's side */
    result: z.enum(["won", "lost", "drawn"]).optional(),
    timeControl: z.enum(["bullet", "blitz", "rapid"]).optional(),
    /** The colour the profile owner played */
    color: z.enum(["white", "black"]).optional(),
    rated: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    /**
     * online: against a person, outside a tournament; tournament: an arena
     * game; bot: against the computer; table: recorded at a real board
     */
    kind: z.enum(["online", "tournament", "bot", "table"]).optional(),
    /** The opponent's username, matched whole and case-insensitively */
    opponent: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .regex(/^[a-zA-Z0-9_]+$/, "Not a username")
      .optional(),
    /** Games started at or after this instant */
    since: z.coerce.date().optional(),
    /** Games started before this instant */
    before: z.coerce.date().optional(),
  })
  .refine((q) => !q.since || !q.before || q.since < q.before, {
    message: "since must be earlier than before",
    path: ["since"],
  });

export type GameHistoryQuery = z.infer<typeof gameHistoryQuery>;
