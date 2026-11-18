import { z } from "zod";
import { TOURNAMENT_LIMITS } from "../services/tournamentService.js";

export const createTournamentSchema = z
  .object({
    // Cleaned and measured again in TournamentService.create
    name: z.string().min(1).max(TOURNAMENT_LIMITS.nameMax * 4),
    time: z.number().int().min(TOURNAMENT_LIMITS.minTime).max(TOURNAMENT_LIMITS.maxTime),
    increment: z.number().int().min(0).max(TOURNAMENT_LIMITS.maxIncrement).default(0),
    minutes: z.number().int().min(TOURNAMENT_LIMITS.minMinutes).max(TOURNAMENT_LIMITS.maxMinutes),
    // A time as text (the app sends an ISO string). Not coerced from
    // anything: null, true and numbers all "are" dates near 1970
    startsAt: z.string().max(64).pipe(z.coerce.date()),
    rated: z.boolean().default(true),
    maxPlayers: z.number().int().min(TOURNAMENT_LIMITS.minPlayers).max(TOURNAMENT_LIMITS.maxPlayers).default(100),
  })
  .strict();

export const listTournamentsQuery = z.object({
  status: z.enum(["open", "finished"]).default("open"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const standingsQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
