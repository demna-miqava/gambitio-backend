import { z } from "zod";
import { TIME_LIMITS } from "../models/common.js";
import { CHAT_MAX_RAW_LENGTH } from "../game/chatText.js";
import { OPENING_IDS } from "../game/openings.js";

const square = z.string().regex(/^[a-h][1-8]$/);
// Ids are Postgres integers: a larger number would fail the query instead of finding nothing
const userId = z.number().int().positive().max(2_147_483_647);

export const gameClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move"),
    move: z.object({
      from: square,
      to: square,
      promotion: z.enum(["q", "r", "b", "n"]).optional(),
    }),
    // How long the player's own clock ran for this move (see clock.ts)
    thinkMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
    // Half-moves on the client's board before this move. A move meant for a
    // position the server no longer has (a takeback was accepted meanwhile)
    // is rejected instead of being played in the new one.
    ply: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal("resign") }),
  z.object({ type: z.literal("abort") }),
  z.object({ type: z.literal("draw_offer") }),
  z.object({ type: z.literal("draw_response"), accepted: z.boolean() }),
  // Asks to take back the sender's last move (and the reply after it)
  z.object({ type: z.literal("takeback_request") }),
  z.object({ type: z.literal("takeback_response"), accepted: z.boolean() }),
  // A hint that a clock reached zero; the server checks its own clock
  z.object({ type: z.literal("timeout") }),
  // Adds GIVE_TIME_MS to the opponent's clock
  z.object({ type: z.literal("give_time") }),
  z.object({ type: z.literal("rematch_request") }),
  z.object({
    type: z.literal("rematch_response"),
    data: z.object({ accepted: z.boolean() }),
  }),
  z.object({ type: z.literal("cancel_rematch") }),
  // The client's board drifted (a missed move): send the full state again
  z.object({ type: z.literal("sync") }),
  // A chat message to the other player. Only bounded here: the text is
  // cleaned and its real length checked in GameChatService
  z.object({ type: z.literal("chat"), text: z.string().min(1).max(CHAT_MAX_RAW_LENGTH) }),
]);
export type GameClientMessage = z.infer<typeof gameClientMessageSchema>;

export const timeSettingsSchema = z.object({
  time: z.number().int().min(TIME_LIMITS.minTime).max(TIME_LIMITS.maxTime),
  increment: z.number().int().min(0).max(TIME_LIMITS.maxIncrement),
});

export const matchmakingQuerySchema = z.object({
  time: z.coerce.number().int().min(TIME_LIMITS.minTime).max(TIME_LIMITS.maxTime),
  increment: z.coerce.number().int().min(0).max(TIME_LIMITS.maxIncrement).default(0),
});

export const matchmakingClientMessageSchema = z.object({ type: z.literal("cancel_match") });

export const notificationClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("challenge_sent"),
    data: timeSettingsSchema.extend({
      challengedId: userId,
      // Time odds: the challenged player's clock, when it differs from the
      // challenger's (`time`). Such a game is unrated (migration 027)
      opponentTime: z.number().int().min(TIME_LIMITS.minTime).max(TIME_LIMITS.maxTime).optional(),
      color: z.enum(["white", "black", "random"]),
      // 3 or 5 plays a series (see migration 016); 2 a mirror match, one game
      // with each colour (migration 036)
      bestOf: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5)]).default(1),
      // Start from this opening (src/game/openings.ts) instead of the initial
      // position; every game of a series does. Ignored for a series' next game
      openingId: z.enum(OPENING_IDS).optional(),
      // False plays a casual game (or series): no rating changes. Ignored for
      // a series' next game, which keeps the series' setting
      rated: z.boolean().default(true),
      // Continues this series instead: its time control, length and colours
      // apply, and the challenged player must be the opponent in it
      seriesId: userId.optional(),
    }),
  }),
  z.object({ type: z.literal("challenge_declined"), data: z.object({ challengerId: userId }) }),
  z.object({
    type: z.literal("challenge_accepted"),
    data: z.object({
      challengerId: userId,
      // The version of the challenge the player saw (challenge_received,
      // GET /api/challenges). If the challenger changed the terms since, the
      // accept is refused with CHALLENGE_CHANGED. Older clients leave it out.
      version: z.number().int().min(1).max(2_147_483_647).nullish(),
    }),
  }),
  z.object({ type: z.literal("challenge_cancelled"), data: z.object({ challengedId: userId }) }),
]);
export type NotificationClientMessage = z.infer<typeof notificationClientMessageSchema>;

const nodeId = z.string().min(1).max(12);
const boardSquare = z.string().regex(/^[a-h][1-8]$/);

/** Messages a study room socket accepts (see src/game/studyState.ts). */
export const studyClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), nodeId, uci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/) }),
  z.object({ type: z.literal("goto"), nodeId }),
  z.object({ type: z.literal("comment"), nodeId, text: z.string().max(1_000) }),
  z.object({
    type: z.literal("shapes"),
    nodeId,
    shapes: z
      .array(
        z.object({
          orig: boardSquare,
          dest: boardSquare.optional(),
          brush: z.enum(["green", "red", "blue", "yellow"]),
        })
      )
      .max(40),
  }),
  z.object({ type: z.literal("delete"), nodeId }),
  z.object({ type: z.literal("promote"), nodeId }),
  // The client missed an update: send the whole room again
  z.object({ type: z.literal("sync") }),
]);
export type StudyClientMessage = z.infer<typeof studyClientMessageSchema>;

/** Messages a tournament lobby socket accepts: only a request for the whole state again. */
export const tournamentClientMessageSchema = z.object({ type: z.literal("sync") });
export type TournamentClientMessage = z.infer<typeof tournamentClientMessageSchema>;
