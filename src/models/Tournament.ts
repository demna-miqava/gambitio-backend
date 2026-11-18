import type { TimeControl } from "./common.js";

export type TournamentStatus = "scheduled" | "running" | "finished" | "cancelled";
export type TournamentPlayerStatus = "active" | "paused" | "withdrawn";

/** A row of the tournaments table (migration 034). */
export interface Tournament {
  id: number;
  createdAt: Date;
  createdBy: number;
  name: string;
  format: "arena";
  time: number;
  increment: number;
  rated: boolean;
  startsAt: Date;
  endsAt: Date;
  status: TournamentStatus;
  maxPlayers: number;
  playerCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  winnerId: number | null;
}

/** A row of tournament_players. */
export interface TournamentPlayer {
  tournamentId: number;
  userId: number;
  joinedAt: Date;
  status: TournamentPlayerStatus;
  score: number;
  streak: number;
  games: number;
  wins: number;
  draws: number;
  opponentRatingSum: number;
  performance: number;
  sheet: string;
  whites: number;
  lastOpponentId: number | null;
  waitingSince: Date | null;
}

/** A tournament as lists and the lobby show it. */
export interface TournamentSummary {
  id: number;
  name: string;
  format: "arena";
  time: number;
  increment: number;
  type: TimeControl;
  rated: boolean;
  startsAt: Date;
  endsAt: Date;
  status: TournamentStatus;
  maxPlayers: number;
  playerCount: number;
  createdBy: { id: number; username: string };
  /** Set once finished, when at least one game was played */
  winner: { id: number; username: string } | null;
}

/** A line of the standings. */
export interface Standing {
  rank: number;
  userId: number;
  username: string;
  avatarUrl: string | null;
  /** Their rating now, in the tournament's time control */
  rating: number;
  provisional: boolean;
  score: number;
  /** Wins in a row; from 2 on their points count double */
  streak: number;
  games: number;
  wins: number;
  draws: number;
  performance: number;
  /** Points of their latest games, oldest first, one digit each */
  sheet: string;
  status: TournamentPlayerStatus;
}

/** A game of the tournament being played now. */
export interface TournamentLiveGame {
  id: number;
  white: { id: number; username: string };
  black: { id: number; username: string };
}

/** Everything the lobby shows, for one viewer. */
export interface TournamentState {
  tournament: TournamentSummary;
  /** The top of the standings (the rest is paged: GET /tournaments/:id/standings) */
  standings: Standing[];
  /** How many lines the standings have in all */
  standingsTotal: number;
  liveGames: TournamentLiveGame[];
  /** The viewer's own line, or null if they haven't joined */
  me: Standing | null;
  /** The viewer's game in progress in this tournament */
  myGameId: number | null;
}
