import { z } from "zod";

export const paginationQuerySchema = z.object({
  page: z.string().optional().default("1"),
  limit: z.string().optional().default("10"),
});

export const searchQuerySchema = paginationQuerySchema.extend({
  q: z.string().optional(),
});

export const suggestionsQuerySchema = z.object({
  q: z.string().optional(),
});

export const sendFriendRequestSchema = z.object({
  receiverId: z.number().positive("Receiver ID must be a positive number"),
});

export const friendIdParamSchema = z.object({
  friendId: z.string().regex(/^\d+$/, "Friend ID must be a number"),
});

export const requestIdParamSchema = z.object({
  requestId: z.string().regex(/^\d+$/, "Request ID must be a number"),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SuggestionsQuery = z.infer<typeof suggestionsQuerySchema>;
export type SendFriendRequest = z.infer<typeof sendFriendRequestSchema>;
export type FriendIdParam = z.infer<typeof friendIdParamSchema>;
export type RequestIdParam = z.infer<typeof requestIdParamSchema>;
