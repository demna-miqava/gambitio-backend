import { z } from "zod";

export const updateSettingsSchema = z
  .object({
    boardCoordinatesEnabled: z.boolean().optional(),
    moveHighlightEnabled: z.boolean().optional(),
    soundsEnabled: z.boolean().optional(),
    premovesEnabled: z.boolean().optional(),
    autoPromoteToQueenEnabled: z.boolean().optional(),
    confirmDrawResignationEnabled: z.boolean().optional(),
    showLegalMovesEnabled: z.boolean().optional(),
    engineEvaluationEnabled: z.boolean().optional(),
    showTimestampsEnabled: z.boolean().optional(),
    showRatingsDuringGameEnabled: z.boolean().optional(),
    pieceIconNotationEnabled: z.boolean().optional(),
    emailNotificationsEnabled: z.boolean().optional(),
    messagesAllowedFrom: z
      .enum(["nobody", "everyone", "only_friends"])
      .optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided for update",
  });

export type UpdateSettingsBody = z.infer<typeof updateSettingsSchema>;
