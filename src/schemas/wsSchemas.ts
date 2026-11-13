import { z } from "zod";
import { TIME_LIMITS } from "../models/common.js";

const square = z.string().regex(/^[a-h][1-8]$/);
const userId = z.number().int().positive();

export const gameClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move"),
    move: z.object({
      from: square,
      to: square,
      promotion: z.enum(["q", "r", "b", "n"]).optional(),
    }),
  }),
  z.object({ type: z.literal("resign") }),
  z.object({ type: z.literal("abort") }),
  z.object({ type: z.literal("draw_offer") }),
  z.object({ type: z.literal("draw_response"), accepted: z.boolean() }),
  // A hint that a clock reached zero; the server checks its own clock
  z.object({ type: z.literal("timeout") }),
  z.object({ type: z.literal("rematch_request") }),
  z.object({
    type: z.literal("rematch_response"),
    data: z.object({ accepted: z.boolean() }),
  }),
  z.object({ type: z.literal("cancel_rematch") }),
  // The client's board drifted (a missed move): send the full state again
  z.object({ type: z.literal("sync") }),
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
      color: z.enum(["white", "black", "random"]),
    }),
  }),
  z.object({ type: z.literal("challenge_declined"), data: z.object({ challengerId: userId }) }),
  z.object({ type: z.literal("challenge_accepted"), data: z.object({ challengerId: userId }) }),
  z.object({ type: z.literal("challenge_cancelled"), data: z.object({ challengedId: userId }) }),
]);
export type NotificationClientMessage = z.infer<typeof notificationClientMessageSchema>;
