-- Leaderboards. A player is listed in a variant once they have finished at
-- least one rated game in it (finished, result <> 'aborted'); everyone else
-- would sit at their starting rating. Deleted accounts ("clerkId" IS NULL)
-- are never listed.
--
-- Counting games per user on every request would scan the games table, so
-- each variant gets a counter that finishGame increments in the same UPDATE
-- that applies the rating change (see ratingColumns in src/models/common.ts).

ALTER TABLE users
  ADD COLUMN "bulletGames" integer NOT NULL DEFAULT 0,
  ADD COLUMN "blitzGames" integer NOT NULL DEFAULT 0,
  ADD COLUMN "rapidGames" integer NOT NULL DEFAULT 0;

-- Backfill. Thresholds must match getTimeControl (src/models/common.ts):
-- bullet < 180s, blitz < 600s, rapid otherwise.
WITH played AS (
  SELECT "whiteId" AS id, "time" FROM games WHERE status = 'finished' AND result <> 'aborted'
  UNION ALL
  SELECT "blackId", "time" FROM games WHERE status = 'finished' AND result <> 'aborted'
), counts AS (
  SELECT id,
         COUNT(*) FILTER (WHERE "time" < 180) AS bullet,
         COUNT(*) FILTER (WHERE "time" >= 180 AND "time" < 600) AS blitz,
         COUNT(*) FILTER (WHERE "time" >= 600) AS rapid
  FROM played WHERE id IS NOT NULL GROUP BY id
)
UPDATE users u
SET "bulletGames" = c.bullet, "blitzGames" = c.blitz, "rapidGames" = c.rapid
FROM counts c
WHERE u.id = c.id;

-- Leaderboard pages (rating DESC, id ASC) and rank counts are index scans
-- over listed players only. The WHERE clauses must match the eligibility
-- filter in src/repositories/leaderboardRepository.ts for the planner to use
-- these partial indexes.
CREATE INDEX users_bullet_leaderboard_idx ON users ("bulletRating" DESC, id)
  WHERE "bulletGames" > 0 AND "clerkId" IS NOT NULL;
CREATE INDEX users_blitz_leaderboard_idx ON users ("blitzRating" DESC, id)
  WHERE "blitzGames" > 0 AND "clerkId" IS NOT NULL;
CREATE INDEX users_rapid_leaderboard_idx ON users ("rapidRating" DESC, id)
  WHERE "rapidGames" > 0 AND "clerkId" IS NOT NULL;
