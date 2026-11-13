/** Same values as the CHECK in migrations/015_color_palette.sql */
export const COLOR_PALETTES = ["emerald", "club", "midnight", "walnut"] as const;
export type ColorPalette = (typeof COLOR_PALETTES)[number];

export interface Settings {
  userId: number;
  boardCoordinatesEnabled: boolean;
  moveHighlightEnabled: boolean;
  soundsEnabled: boolean;
  premovesEnabled: boolean;
  autoPromoteToQueenEnabled: boolean;
  confirmDrawResignationEnabled: boolean;
  showLegalMovesEnabled: boolean;
  engineEvaluationEnabled: boolean;
  showTimestampsEnabled: boolean;
  showRatingsDuringGameEnabled: boolean;
  pieceIconNotationEnabled: boolean;
  emailNotificationsEnabled: boolean;
  messagesAllowedFrom: "nobody" | "everyone" | "only_friends";
  colorPalette: ColorPalette;
}

export type UpdateSettingsRequest = {
  [K in keyof Omit<Settings, "userId">]?: Settings[K] | undefined;
};
