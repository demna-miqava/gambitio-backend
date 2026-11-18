-- Friend challenges from a chosen opening, and mirror matches.
--
-- A challenge (and the series it starts) can name an opening from
-- src/game/openings.ts. Its games start with the opening's moves already
-- played: they are the first "startPly" half-moves of the game's PGN, and
-- the first-move rules (clocks starting, abort, the first-move timeout,
-- takebacks) count from there.
--
-- A mirror match is a series of exactly two games ("bestOf" = 2): one with
-- each colour, scored as a pair, so 1-1 is a drawn match. It is meant to be
-- played from an opening, but the standard position is allowed too.
--
-- The new columns are nullable or default to the old behaviour, so the code
-- from before this migration keeps working with them in place. Run it before
-- deploying the code that uses it.

ALTER TABLE challenges ADD COLUMN "openingId" text;
ALTER TABLE challenges DROP CONSTRAINT challenges_best_of;
ALTER TABLE challenges ADD CONSTRAINT challenges_best_of CHECK ("bestOf" IN (1, 2, 3, 5));

ALTER TABLE series ADD COLUMN "openingId" text;
ALTER TABLE series DROP CONSTRAINT series_best_of;
ALTER TABLE series ADD CONSTRAINT series_best_of CHECK ("bestOf" IN (2, 3, 5));

ALTER TABLE games
  ADD COLUMN "openingId" text,
  ADD COLUMN "startPly" smallint NOT NULL DEFAULT 0,
  -- NOT VALID: new and changed rows are checked at once, but the rows already
  -- there aren't scanned while this holds the table's exclusive lock.
  -- Migration 042 validates it under a lock that doesn't block play.
  ADD CONSTRAINT games_start_ply CHECK (
    "startPly" >= 0 AND "numMoves" >= "startPly" AND ("openingId" IS NULL) = ("startPly" = 0)
  ) NOT VALID;
