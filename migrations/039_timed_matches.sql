-- Timed matches: two friends play as many games as fit in a fixed time
-- (say 15 minutes), scored like an arena tournament (src/game/arena.ts):
-- 2 for a win, 1 for a draw, doubled after two wins in a row. Most points
-- when the time is up wins; equal points is a drawn match.
--
-- A timed match is a series (migration 016) with "matchMinutes" set and
-- "bestOf" 0. Its clock starts when the challenge is accepted ("endsAt").
-- Each next game starts by itself a moment after the last one ended, with
-- the colours swapped; no game starts in the last minute or so (see
-- src/game/timedMatch.ts), and one still going at the end is played out and
-- counts. Not making the first move loses the game (unrated, like a
-- tournament no-show); two such games in a row end the match ("abandoned").
--
-- "playerOneHalfPoints" / "playerTwoHalfPoints" still hold the plain score
-- (a draw is half a point each); the arena points that decide the match are
-- in "playerOnePoints" / "playerTwoPoints".
--
-- New columns are nullable or default to the old behaviour, so the code from
-- before this migration keeps working with them in place. Run it before
-- deploying the code that uses it.

ALTER TABLE challenges ADD COLUMN "matchMinutes" smallint;
ALTER TABLE challenges ADD CONSTRAINT challenges_match_minutes
  CHECK ("matchMinutes" IS NULL OR ("matchMinutes" BETWEEN 1 AND 120 AND "bestOf" = 1));

ALTER TABLE series
  ADD COLUMN "matchMinutes" smallint,
  ADD COLUMN "endsAt" timestamptz,
  ADD COLUMN "playerOnePoints" smallint NOT NULL DEFAULT 0,
  ADD COLUMN "playerTwoPoints" smallint NOT NULL DEFAULT 0,
  -- Wins in a row, for the double points
  ADD COLUMN "playerOneStreak" smallint NOT NULL DEFAULT 0,
  ADD COLUMN "playerTwoStreak" smallint NOT NULL DEFAULT 0,
  -- Games in a row that ended with a player not making their first move
  ADD COLUMN "noShows" smallint NOT NULL DEFAULT 0;

ALTER TABLE series DROP CONSTRAINT series_best_of;
ALTER TABLE series ADD CONSTRAINT series_best_of CHECK (
  ("matchMinutes" IS NULL AND "bestOf" IN (2, 3, 5))
  OR ("matchMinutes" IS NOT NULL AND "bestOf" = 0 AND "endsAt" IS NOT NULL)
);

ALTER TABLE series DROP CONSTRAINT series_end_reason;
ALTER TABLE series ADD CONSTRAINT series_end_reason CHECK (
  "endReason" IS NULL OR "endReason" IN ('played_out', 'resignation', 'expired', 'time_up', 'abandoned')
);

-- The timed-match sweep reads only the active timed matches
CREATE INDEX series_timed_active_idx ON series ("endsAt")
  WHERE status = 'active' AND "matchMinutes" IS NOT NULL;
