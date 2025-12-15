import { z } from "zod";

// Schema for syncing user profile after Clerk auth
export const syncUserSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores"),
  skill: z.enum(["new", "beginner", "intermediate", "advanced"]),
});

export type SyncUserSchemaType = z.infer<typeof syncUserSchema>;

// Schema for checking username availability
export const checkUsernameSchema = z.object({
  username: z.string().min(1, "Username is required"),
});

export type CheckUsernameSchemaType = z.infer<typeof checkUsernameSchema>;
