import { z } from "zod";

export const signupSchema = z.object({
  email: z.string().email("Invalid email address"),
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  skill: z.enum(["new", "beginner", "intermediate", "advanced"]),
});

export type SignupSchemaType = z.infer<typeof signupSchema>;

export const signinSchema = z.object({
  emailOrUsername: z.string().min(1, "Email or username is required"),
  password: z.string().min(1, "Password is required"),
});

export type SigninSchemaType = z.infer<typeof signinSchema>;
