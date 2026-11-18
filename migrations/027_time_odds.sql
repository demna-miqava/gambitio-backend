-- Time odds: a friend challenge (single game or series) where the two
-- players start with different clocks, e.g. 5 minutes against 1.
--
-- The per-player columns are set only when the clocks differ, and always
-- both. "time" is then the longer of the two, so the time control (bullet,
-- blitz, rapid) and every list that shows it keep working. The increment is
-- shared.
--
-- A game with time odds is unrated: it never changes ratings, the
-- leaderboard game counters or stats. Until now only bot games were unrated.

ALTER TABLE challenges
  ADD COLUMN "challengerTime" integer,
  ADD COLUMN "challengedTime" integer,
  ADD CONSTRAINT challenges_time_odds CHECK (
    ("challengerTime" IS NULL AND "challengedTime" IS NULL)
    OR ("challengerTime" > 0 AND "challengedTime" > 0 AND "challengerTime" <> "challengedTime"
        AND "time" = GREATEST("challengerTime", "challengedTime"))
  );

ALTER TABLE series
  ADD COLUMN "playerOneTime" integer,
  ADD COLUMN "playerTwoTime" integer,
  ADD CONSTRAINT series_time_odds CHECK (
    ("playerOneTime" IS NULL AND "playerTwoTime" IS NULL)
    OR ("playerOneTime" > 0 AND "playerTwoTime" > 0 AND "playerOneTime" <> "playerTwoTime"
        AND "time" = GREATEST("playerOneTime", "playerTwoTime"))
  );

ALTER TABLE games
  ADD COLUMN "whiteTime" integer,
  ADD COLUMN "blackTime" integer,
  ADD CONSTRAINT games_time_odds CHECK (
    ("whiteTime" IS NULL AND "blackTime" IS NULL)
    OR ("whiteTime" > 0 AND "blackTime" > 0 AND "whiteTime" <> "blackTime"
        AND "time" = GREATEST("whiteTime", "blackTime") AND NOT rated)
  );
