import { z } from "zod";

/**
 * Search query schema with pagination and search term validation
 */
export const suggestionsQuerySchema = z.object({
  q: z
    .string()
    .min(2, "Search query must be at least 2 characters")
    .max(100, "Search query cannot exceed 100 characters")
    .optional(),
});

/**
 * Send friend request body schema
 */
export const sendFriendRequestSchema = z.object({
  receiverId: z
    .number({ error: "Receiver ID must be a number" })
    .int("Receiver ID must be an integer")
    .positive("Receiver ID must be a positive number"),
});

/**
 * Friend ID parameter schema with transformation
 */
export const friendIdParamSchema = z.object({
  friendId: z
    .string({ error: "Friend ID must be a string number" })
    .regex(/^\d+$/, "Friend ID must be a valid number")
    .transform((val) => parseInt(val, 10))
    .pipe(
      z
        .number()
        .int("Friend ID must be an integer")
        .positive("Friend ID must be a positive number")
    ),
});

/**
 * Request ID parameter schema with transformation
 */
export const requestIdParamSchema = z.object({
  requestId: z
    .string({ error: "Request ID must be a string number" })
    .regex(/^\d+$/, "Request ID must be a valid number")
    .transform((val) => parseInt(val, 10))
    .pipe(
      z
        .number()
        .int("Request ID must be an integer")
        .positive("Request ID must be a positive number")
    ),
});

// Type exports
export type SuggestionsQuery = z.infer<typeof suggestionsQuerySchema>;
export type SendFriendRequest = z.infer<typeof sendFriendRequestSchema>;
export type FriendIdParam = z.infer<typeof friendIdParamSchema>;
export type RequestIdParam = z.infer<typeof requestIdParamSchema>;
