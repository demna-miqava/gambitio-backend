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
}

export type UpdateSettingsRequest = {
  [K in keyof Omit<Settings, "userId">]?: Settings[K] | undefined;
};
