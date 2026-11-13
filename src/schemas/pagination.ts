import { z } from "zod";

/**
 * Reusable pagination schema with validation and transformation
 */
export const paginationSchema = z.object({
  page: z
    .string()
    .optional()
    .default("1")
    .transform((val) => parseInt(val, 10))
    .pipe(
      z
        .number()
        .int("Page must be an integer")
        .positive("Page must be a positive number")
        .max(1000, "Page cannot exceed 1000")
    ),
  limit: z
    .string()
    .optional()
    .default("10")
    .transform((val) => parseInt(val, 10))
    .pipe(
      z
        .number()
        .int("Limit must be an integer")
        .positive("Limit must be a positive number")
        .max(100, "Limit cannot exceed 100")
    ),
});

export type PaginationQuery = z.infer<typeof paginationSchema>;
