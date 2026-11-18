-- Ratings move from a fixed scale (8 points a game, give or take) to
-- Glicko-2 (src/utils/glicko2.ts). Besides the rating itself a player now has,
-- per time control:
--   Rd          rating deviation: how unsure the rating is. 350 for someone
--               who has never played; it falls with every rated game and
--               grows again with time away
--   Volatility  how erratic their results have been
--   RatedAt     their last rated game, which the growth with time away is
--               measured from. NULL before the first one under this system
--
-- The ratings themselves are kept as they are.
ALTER TABLE users
  ADD COLUMN "bulletRd" real NOT NULL DEFAULT 350,
  ADD COLUMN "bulletVolatility" real NOT NULL DEFAULT 0.06,
  ADD COLUMN "bulletRatedAt" timestamptz,
  ADD COLUMN "blitzRd" real NOT NULL DEFAULT 350,
  ADD COLUMN "blitzVolatility" real NOT NULL DEFAULT 0.06,
  ADD COLUMN "blitzRatedAt" timestamptz,
  ADD COLUMN "rapidRd" real NOT NULL DEFAULT 350,
  ADD COLUMN "rapidVolatility" real NOT NULL DEFAULT 0.06,
  ADD COLUMN "rapidRatedAt" timestamptz;

-- Players who already have rated games aren't newcomers: their deviation
-- starts where 350 would have come down to after that many games between
-- equals,
--   1/rd^2 = 1/350^2 + games * (ln(10)/400)^2 / 4
-- never below the floor of 50 (rdAfterGames in src/utils/glicko2.ts: about
-- 105 after 10 games, 76 after 20, 50 from 50 games on).
UPDATE users SET
  "bulletRd" = GREATEST(50, 1 / sqrt(1 / 122500.0 + "bulletGames" * 0.0000082842)),
  "blitzRd" = GREATEST(50, 1 / sqrt(1 / 122500.0 + "blitzGames" * 0.0000082842)),
  "rapidRd" = GREATEST(50, 1 / sqrt(1 / 122500.0 + "rapidGames" * 0.0000082842))
WHERE "bulletGames" > 0 OR "blitzGames" > 0 OR "rapidGames" > 0;

-- Whether each player's rating was provisional (deviation above 110) when
-- the game started: shown as "1500?" beside the board and in game lists, like
-- the rating itself a snapshot. Games from before this have none.
ALTER TABLE games
  ADD COLUMN "whiteProvisional" boolean NOT NULL DEFAULT false,
  ADD COLUMN "blackProvisional" boolean NOT NULL DEFAULT false;
