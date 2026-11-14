-- Friend matches played as a series (best of 3 or best of 5).
--
-- A challenge with "bestOf" > 1 creates a series when it is accepted; its
-- games are ordinary rated live games that point back at it ("seriesId",
-- "seriesGame"). Colours alternate game by game. Points are stored doubled
-- ("half points") so a draw is a whole number: one half point each.
--
-- The series is decided as soon as one player has more than half the
-- points on offer, or once "bestOf" games have counted (aborted games don't);
-- equal points after the last game is a drawn series.

CREATE TABLE series (
  id serial PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  -- The challenger is player one
  "playerOneId" integer NOT NULL REFERENCES users(id),
  "playerTwoId" integer NOT NULL REFERENCES users(id),
  "playerOneStartsWhite" boolean NOT NULL,
  "bestOf" smallint NOT NULL,
  "time" integer NOT NULL,
  increment integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  "playerOneHalfPoints" smallint NOT NULL DEFAULT 0,
  "playerTwoHalfPoints" smallint NOT NULL DEFAULT 0,
  -- Games that counted (finished, not aborted)
  "gamesPlayed" smallint NOT NULL DEFAULT 0,
  "winnerId" integer REFERENCES users(id),
  "endReason" text,
  "endedAt" timestamptz,
  CONSTRAINT series_not_self CHECK ("playerOneId" <> "playerTwoId"),
  CONSTRAINT series_best_of CHECK ("bestOf" IN (3, 5)),
  CONSTRAINT series_status CHECK (status IN ('active', 'finished')),
  CONSTRAINT series_end_reason CHECK ("endReason" IS NULL OR "endReason" IN ('played_out', 'resignation')),
  CONSTRAINT series_time_positive CHECK ("time" > 0 AND increment >= 0)
);
CREATE INDEX series_player_one_idx ON series ("playerOneId", "createdAt" DESC);
CREATE INDEX series_player_two_idx ON series ("playerTwoId", "createdAt" DESC);

ALTER TABLE games
  ADD COLUMN "seriesId" integer REFERENCES series(id),
  ADD COLUMN "seriesGame" smallint;
CREATE INDEX games_series_idx ON games ("seriesId", id) WHERE "seriesId" IS NOT NULL;

ALTER TABLE challenges
  ADD COLUMN "bestOf" smallint NOT NULL DEFAULT 1
  CONSTRAINT challenges_best_of CHECK ("bestOf" IN (1, 3, 5));
