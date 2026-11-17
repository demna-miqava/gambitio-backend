/** Same values as the CHECK in migrations/015_color_palette.sql */
export const COLOR_PALETTES = ["emerald", "club", "midnight", "walnut"] as const;
export type ColorPalette = (typeof COLOR_PALETTES)[number];

/** Same values as the messages_allowed_from enum (migration 001) */
export const ALLOWED_FROM = ["everyone", "only_friends", "nobody"] as const;
export type AllowedFrom = (typeof ALLOWED_FROM)[number];

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
  messagesAllowedFrom: AllowedFrom;
  /** Who the user chats with during games; both players must allow the other */
  gameChatAllowedFrom: AllowedFrom;
  colorPalette: ColorPalette;
}

export type UpdateSettingsRequest = {
  [K in keyof Omit<Settings, "userId">]?: Settings[K] | undefined;
};
