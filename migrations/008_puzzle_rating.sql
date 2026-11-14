-- Puzzle rating: an Elo rating per user, updated by the first attempt at each
-- puzzle in the rated (Infinite) mode. Rush/Survival stay unrated.
-- "puzzleAttempts" counts rated attempts: it picks the K-factor (provisional
-- players move faster) and says who has a real puzzle rating (> 0).
ALTER TABLE users
  ADD COLUMN "puzzleRating" integer NOT NULL DEFAULT 1500,
  ADD COLUMN "highestPuzzleRating" integer NOT NULL DEFAULT 1500,
  ADD COLUMN "puzzleAttempts" integer NOT NULL DEFAULT 0;

-- Rank / percentile counts, like the per-variant indexes in migration 004
CREATE INDEX users_puzzle_rating_idx ON users ("puzzleRating");
-- Leaderboard pages (rating DESC, id ASC) over players who have rated
-- puzzle attempts; a query must repeat this WHERE to use it.
CREATE INDEX users_puzzle_leaderboard_idx ON users ("puzzleRating" DESC, id)
  WHERE "puzzleAttempts" > 0 AND "clerkId" IS NOT NULL;

-- One row per (user, puzzle): the first, rated attempt. The primary key is
-- what makes a puzzle rate only once, even for concurrent submits. Retries
-- and later sessions are unrated and not recorded here (solves still go to
-- solved_puzzles).
CREATE TABLE puzzle_attempts (
    "userId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "puzzleId" text NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    success boolean NOT NULL,
    "ratingBefore" integer NOT NULL,
    "ratingChange" integer NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("userId", "puzzleId")
);
-- Per-user history / stats in time order
CREATE INDEX puzzle_attempts_user_created_idx ON puzzle_attempts ("userId", "createdAt");

-- GET /api/puzzles?theme=... filters with themes @> ARRAY[theme]
CREATE INDEX puzzles_themes_idx ON puzzles USING GIN (themes);
