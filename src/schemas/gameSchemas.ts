import { MAX_TABLE_GAME_PGN_LENGTH, TABLE_END_REASONS, TABLE_GAME_CLIENT_ID } from "../game/tableGame.js";
import { TIME_LIMITS } from "../models/common.js";
import { z } from "zod";
import { MAX_BOT_GAME_PGN_LENGTH } from "../game/botGame.js";

/**
 * POST /games/bot. endReason is what the browser saw end the game; the
 * server checks it against the replayed position and only takes it on trust
 * for a resignation (see replayBotGame).
 */
export const saveBotGameSchema = z
  .object({
    botId: z.string().min(1).max(40),
    color: z.enum(["white", "black"]),
    pgn: z.string().min(1).max(MAX_BOT_GAME_PGN_LENGTH),
    endReason: z.enum([
      "checkmate",
      "resignation",
      "stalemate",
      "insufficient_material",
      "threefold_repetition",
      "fifty_move_rule",
    ]),
  })
  .strict();

export type SaveBotGameBody = z.infer<typeof saveBotGameSchema>;

const clock = z.number().int().min(TIME_LIMITS.minTime).max(TIME_LIMITS.maxTime);

/** POST /games/table: a finished table game (src/game/tableGame.ts) */
export const saveTableGameSchema = z
  .object({
    pgn: z.string().min(1).max(MAX_TABLE_GAME_PGN_LENGTH),
    result: z.enum(["white_win", "black_win", "draw"]),
    endReason: z.enum(TABLE_END_REASONS),
    // The recorder's side of the board
    color: z.enum(["white", "black"]),
    // Each side's starting clock in seconds (time odds when they differ)
    whiteTime: clock,
    blackTime: clock,
    increment: z.number().int().min(0).max(TIME_LIMITS.maxIncrement),
    opponent: z.discriminatedUnion("kind", [
      // Only bounded here; cleaned and checked by cleanGuestName
      z.object({ kind: z.literal("guest"), name: z.string().min(1).max(100) }).strict(),
      z.object({ kind: z.literal("friend"), userId: z.number().int().positive().max(2_147_483_647) }).strict(),
    ]),
    // The browser's own id for the game (migration 041): the same game sent
    // again returns the one stored the first time
    clientId: z.string().regex(TABLE_GAME_CLIENT_ID).optional(),
  })
  .strict();
