-- Peak ratings below the current rating. Before games were finished on the
-- server (finishGame in src/services/gameService.ts), ending a game only set
-- the rating column and never touched "highest<Variant>Rating", so players
-- who climbed under that code show a peak below their rating (e.g. rating
-- 1408, peak 1400).
--
-- Rebuild each peak as the highest of: the stored peak, the current rating,
-- every rating the player started a game with, and the rating after each
-- game (rating at start + stored change, when the change was recorded).
-- Puzzle peaks get the same treatment from puzzle_attempts. Only raises
-- values, so running it on correct rows changes nothing.
--
-- Time-control thresholds must match getTimeControl (src/models/common.ts):
-- bullet < 180s, blitz < 600s, rapid otherwise.

WITH played AS (
  SELECT "whiteId" AS id, "time",
         GREATEST("whiteRating", "whiteRating" + COALESCE("whiteRatingChange", 0)) AS peak
  FROM games WHERE "whiteId" IS NOT NULL AND "time" IS NOT NULL
  UNION ALL
  SELECT "blackId", "time",
         GREATEST("blackRating", "blackRating" + COALESCE("blackRatingChange", 0))
  FROM games WHERE "blackId" IS NOT NULL AND "time" IS NOT NULL
), peaks AS (
  SELECT id,
         MAX(peak) FILTER (WHERE "time" < 180) AS bullet,
         MAX(peak) FILTER (WHERE "time" >= 180 AND "time" < 600) AS blitz,
         MAX(peak) FILTER (WHERE "time" >= 600) AS rapid
  FROM played GROUP BY id
)
UPDATE users u SET
  "highestBulletRating" = GREATEST(u."highestBulletRating", u."bulletRating", p.bullet),
  "highestBlitzRating" = GREATEST(u."highestBlitzRating", u."blitzRating", p.blitz),
  "highestRapidRating" = GREATEST(u."highestRapidRating", u."rapidRating", p.rapid)
FROM peaks p
WHERE u.id = p.id
  AND (u."highestBulletRating" < GREATEST(u."bulletRating", p.bullet)
    OR u."highestBlitzRating" < GREATEST(u."blitzRating", p.blitz)
    OR u."highestRapidRating" < GREATEST(u."rapidRating", p.rapid));

-- Players with no games have no row in peaks
UPDATE users SET
  "highestBulletRating" = GREATEST("highestBulletRating", "bulletRating"),
  "highestBlitzRating" = GREATEST("highestBlitzRating", "blitzRating"),
  "highestRapidRating" = GREATEST("highestRapidRating", "rapidRating")
WHERE "highestBulletRating" < "bulletRating"
   OR "highestBlitzRating" < "blitzRating"
   OR "highestRapidRating" < "rapidRating";

WITH puzzle_peaks AS (
  SELECT "userId" AS id, MAX(GREATEST("ratingBefore", "ratingBefore" + "ratingChange")) AS peak
  FROM puzzle_attempts GROUP BY "userId"
)
UPDATE users u SET "highestPuzzleRating" = GREATEST(u."highestPuzzleRating", u."puzzleRating", p.peak)
FROM puzzle_peaks p
WHERE u.id = p.id AND u."highestPuzzleRating" < GREATEST(u."puzzleRating", p.peak);

UPDATE users SET "highestPuzzleRating" = "puzzleRating"
WHERE "highestPuzzleRating" < "puzzleRating";
