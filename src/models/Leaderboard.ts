import { ratingColumns } from "./common.js";

/** users columns behind one leaderboard. Fixed strings, safe to interpolate into SQL. */
export interface LeaderboardColumns {
  /** Current rating, the sort key */
  rating: string;
  /** Peak rating */
  highest: string;
  /** Rated games played; only players with games > 0 are listed */
  games: string;
}

/**
 * Leaderboard variant -> users columns. Adding a variant is one entry here, plus
 * a partial index like the ones in migrations 008 and 010
 * ("<rating>" DESC, id WHERE "<games>" > 0 AND "clerkId" IS NOT NULL).
 * The query schema and the response type pick new entries up automatically.
 */
export const LEADERBOARD_VARIANTS = {
  bullet: ratingColumns("bullet"),
  blitz: ratingColumns("blitz"),
  rapid: ratingColumns("rapid"),
  // Puzzle rating (migration 008): listed after one rated attempt in Infinite mode
  puzzle: { rating: "puzzleRating", highest: "highestPuzzleRating", games: "puzzleAttempts" },
} as const satisfies Record<string, LeaderboardColumns>;

export type LeaderboardVariant = keyof typeof LEADERBOARD_VARIANTS;
export const LEADERBOARD_VARIANT_NAMES = Object.keys(LEADERBOARD_VARIANTS) as [
  LeaderboardVariant,
  ...LeaderboardVariant[],
];

export const LEADERBOARD_SCOPES = ["global", "friends"] as const;
export type LeaderboardScope = (typeof LEADERBOARD_SCOPES)[number];

export interface LeaderboardRow {
  id: number;
  username: string;
  avatarUrl: string | null;
  rating: number;
  highestRating: number;
  gamesPlayed: number;
}

export interface LeaderboardEntry extends LeaderboardRow {
  rank: number;
}

export interface LeaderboardResponse {
  variant: LeaderboardVariant;
  scope: LeaderboardScope;
  data: LeaderboardEntry[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  /** The signed-in user's entry and the page it is on; null when they aren't listed. */
  me: (LeaderboardEntry & { page: number }) | null;
}

/**
 * Standard competition ranks ("1224") for one page of rows sorted by rating
 * DESC. firstRank is the rank of rows[0] (1 + players rated strictly higher),
 * offset the number of rows on earlier pages. A row tied with the one before
 * it shares its rank; otherwise its rank is its 1-based position overall.
 */
export function assignRanks(rows: LeaderboardRow[], offset: number, firstRank: number): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = [];
  rows.forEach((row, i) => {
    const previous = entries[i - 1];
    const rank =
      i === 0 ? firstRank : row.rating === previous!.rating ? previous!.rank : offset + i + 1;
    entries.push({ ...row, rank });
  });
  return entries;
}
