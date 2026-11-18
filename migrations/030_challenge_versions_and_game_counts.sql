-- Challenge versions, a game history counter, a head-to-head index and push
-- subscription failures.
--
-- Run this before deploying the code that uses it: the old code keeps
-- working with these columns in place (they all have defaults), the new code
-- needs them. Games that end between this migration and the deploy aren't
-- counted in "listedGames"; the backfill below can be run again after the
-- deploy to correct that (it is idempotent).

-- challenges -----------------------------------------------------------
-- Re-sending a challenge updates its row in place. "version" changes
-- whenever the terms do (time, increment, colours, length, series, time
-- odds), and accepting can name the version the player saw, so a challenge
-- can't be accepted on terms the player never saw. Values come from a
-- sequence rather than counting up from 1: a challenge that is cancelled
-- and sent again is a new row, and must not reuse the old row's version.
CREATE SEQUENCE challenges_version_seq AS integer;
ALTER TABLE challenges
  ADD COLUMN version integer NOT NULL DEFAULT nextval('challenges_version_seq');
ALTER SEQUENCE challenges_version_seq OWNED BY challenges.version;

-- users ----------------------------------------------------------------
-- Games in the user's history that have finished: what the history lists
-- (src/repositories/gameRepository.ts findPageByUserId) less the games in
-- progress, which are counted when the total is read. Aborted games aren't
-- listed. Kept up to date in the transaction that finishes a live game (with
-- the rating update) and the one that saves a bot game, so the history total
-- no longer counts every game the user ever played.
--
-- The ADD COLUMN only changes the catalog; the backfill rewrites every users
-- row once, which briefly blocks writes to users.
ALTER TABLE users ADD COLUMN "listedGames" integer NOT NULL DEFAULT 0;

UPDATE users u SET "listedGames" = c.n
FROM (
  SELECT player, count(*)::int AS n FROM (
    SELECT "whiteId" AS player FROM games
    WHERE "whiteId" IS NOT NULL
      AND status IS DISTINCT FROM 'in_progress' AND result IS DISTINCT FROM 'aborted'
    UNION ALL
    SELECT "blackId" FROM games
    WHERE "blackId" IS NOT NULL AND "whiteId" IS DISTINCT FROM "blackId"
      AND status IS DISTINCT FROM 'in_progress' AND result IS DISTINCT FROM 'aborted'
  ) listed
  GROUP BY player
) c
WHERE u.id = c.player AND u."listedGames" IS DISTINCT FROM c.n;

-- games ----------------------------------------------------------------
-- Head-to-head records (SeriesService.headToHead): the games between two
-- players, newest first, found by the unordered pair instead of reading
-- every game of both players. The WHERE matches the query's, so the index
-- holds nothing else (bot games have one player id, live and aborted games
-- don't count).
--
-- Migrations run inside a transaction, so this can't be built CONCURRENTLY:
-- it briefly blocks writes to games (moves, game starts and ends) while it
-- is built.
CREATE INDEX games_pair_finished_idx
  ON games (LEAST("whiteId", "blackId"), GREATEST("whiteId", "blackId"), "createdAt" DESC, id DESC)
  WHERE status = 'finished' AND result IS DISTINCT FROM 'aborted' AND "botId" IS NULL;

-- push_subscriptions ---------------------------------------------------
-- Failed deliveries in a row that suggest the subscription itself is bad
-- (the push service refused it, but without saying it is gone). After a few
-- the subscription is deleted (src/services/pushService.ts); a success
-- resets the count.
ALTER TABLE push_subscriptions ADD COLUMN failures integer NOT NULL DEFAULT 0;
