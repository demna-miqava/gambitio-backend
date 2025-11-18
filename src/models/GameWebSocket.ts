export type DrawOfferMessage = {
  type: "draw_offer";
};

export type DrawResponseMessage = {
  type: "draw_response";
  accepted: boolean;
  userId?: number;
};

export type GameEndedMessage = {
  type: "game_ended";
  winnerId?: number | null;
  result: "white_win" | "black_win" | "draw" | "aborted";
  reason:
    | "checkmate"
    | "resignation"
    | "draw_agreement"
    | "stalemate"
    | "timeout"
    | "aborted";
  ratingChanges?: {
    whiteRatingChange: number;
    blackRatingChange: number;
    whiteNewRating: number;
    blackNewRating: number;
  };
};

export type ResignMessage = {
  type: "resign";
  userId?: number;
};

export type AbortMessage = {
  type: "abort";
};

export type TimeoutMessage = {
  type: "timeout";
  userId?: number;
};

export type CheckmateMessage = {
  type: "checkmate";
  winnerId: number;
};

export type StalemateMessage = {
  type: "stalemate";
};

export type RematchRequestMessage = {
  type: "rematch_request";
  data: {};
};

export type RematchResponseMessage = {
  type: "rematch_response";
  data: {
    accepted: boolean;
  };
};

export type RematchDeclinedMessage = {
  type: "rematch_response";
  data: {
    accepted: false;
  };
};

export type RematchCanceledMessage = {
  type: "rematch_canceled";
  data: {
    reason: "opponent_in_game" | "opponent_disconnected";
  };
};

export type CancelRematchMessage = {
  type: "cancel_rematch";
  data: {};
};

export type MoveMessage = {
  type: "move";
  move: {
    lan: string;
    san?: string;
    from: string;
    to: string;
  };
  userId?: number;
  fen?: string;
  pgn?: string;
  moveNumber?: number;
  whiteTimeLeft?: number; // in milliseconds
  blackTimeLeft?: number; // in milliseconds
};

export type InitialGameStateMessage = {
  type: "initial_game_state";
  data: {
    gameId: number;
    fen: string;
    pgn: string | null;
    whitePlayer: {
      id: number | null;
      username: string;
      rating: number;
      avatarUrl: string | null;
    };
    blackPlayer: {
      id: number | null;
      username: string;
      rating: number;
      avatarUrl: string | null;
    };
    time: number;
    increment: number | null;
    status: string;
    numMoves: number | null;
    isFinished: boolean;
    whiteTimeLeft?: number; // in milliseconds
    blackTimeLeft?: number; // in milliseconds
  };
};

export type ErrorMessage = {
  type: "error";
  message: string;
};

export type GameWebSocketMessage =
  | DrawOfferMessage
  | DrawResponseMessage
  | GameEndedMessage
  | ResignMessage
  | AbortMessage
  | TimeoutMessage
  | CheckmateMessage
  | StalemateMessage
  | RematchRequestMessage
  | RematchResponseMessage
  | RematchDeclinedMessage
  | RematchCanceledMessage
  | CancelRematchMessage
  | MoveMessage
  | InitialGameStateMessage
  | ErrorMessage;
