export type GameStatus = "in_progress" | "completed";

export interface Game {
  id: number;
  createdAt: Date;
  pgn: string | null;
  fen: string | null;
  winnerId: number | null;
  numMoves: number | null;
  whiteRating: number;
  blackRating: number;
  time: number;
  increment: number | null;
  whiteId: number | null;
  blackId: number | null;
  whiteUsername: string;
  blackUsername: string;
  whiteAvatarUrl: string;
  blackAvatarUrl: string;
  status: GameStatus;
}

export interface GameResponse {
  id: number;
  createdAt: Date;
  pgn: string | null;
  fen: string | null;
  winnerId: number | null;
  numMoves: number | null;
  time: number;
  increment: number | null;
  status: GameStatus;
  whitePlayer: {
    id: number | null;
    username: string;
    rating: number;
    avatarUrl: string;
  };
  blackPlayer: {
    id: number | null;
    username: string;
    rating: number;
    avatarUrl: string;
  };
}

export interface PaginatedGamesResponse {
  games: GameResponse[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
