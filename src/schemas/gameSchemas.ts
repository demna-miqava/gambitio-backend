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
