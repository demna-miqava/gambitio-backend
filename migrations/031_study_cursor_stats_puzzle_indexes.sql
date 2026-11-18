-- Study rooms, profile stats and puzzles: fewer rewrites and full scans.

-- study_rooms ------------------------------------------------------------
-- Moving around a room's tree (goto, or replaying a move it already has)
-- only changes where the group is looking. With the cursor inside the JSON
-- document, every such step rewrote the whole document (up to 400 KB). It
-- now has its own column: those steps update a few bytes and leave the
-- document as it is (see StudyService.apply). "nodeCount" is kept with
-- every write of the document, so the room list doesn't count the keys of
-- every room's tree.
--
-- The cursor stays in the stored document for now: code still running from
-- before this migration reads it there. The app ignores it (the column
-- wins) and drops it the next time it writes the document.
ALTER TABLE study_rooms
  ADD COLUMN cursor text NOT NULL DEFAULT 'root',
  ADD COLUMN "nodeCount" integer NOT NULL DEFAULT 1;
UPDATE study_rooms SET
  cursor = CASE WHEN state->'nodes' ? (state->>'cursor') THEN state->>'cursor' ELSE 'root' END,
  "nodeCount" = (SELECT COUNT(*) FROM jsonb_object_keys(state->'nodes'));

-- puzzles ----------------------------------------------------------------
-- Rated mode and Rush / Survival serve the two halves of the puzzles, split
-- by the parity of the id's last character (RATED_POOL_SQL in
-- src/services/puzzleService.ts), always ordered by (rating, id). One index
-- per half, whose WHERE is exactly the expression the queries use, so a
-- page walks only its own half. They replace the index over both halves.
CREATE INDEX IF NOT EXISTS puzzles_rated_pool_idx
  ON puzzles (rating, id) WHERE ascii(right(id, 1)) % 2 = 0;
CREATE INDEX IF NOT EXISTS puzzles_unrated_pool_idx
  ON puzzles (rating, id) WHERE NOT (ascii(right(id, 1)) % 2 = 0);
DROP INDEX IF EXISTS puzzles_rating_idx;

-- Puzzles per theme, for the theme picker. Counting them reads every puzzle,
-- so it is done when puzzles change (scripts/import-lichess-puzzles.ts),
-- not per request.
CREATE TABLE puzzle_theme_counts (
  theme text PRIMARY KEY,
  count integer NOT NULL
);
INSERT INTO puzzle_theme_counts (theme, count)
  SELECT t, COUNT(*) FROM puzzles, unnest(themes) AS t GROUP BY t;

-- games ------------------------------------------------------------------
-- Last on purpose: building these blocks writes to games (every move) until
-- the migration commits, so nothing else should run after them.
--
-- Profile stats read every rated game a player has finished. They used one
-- scan with (whiteId = $1 OR blackId = $1): a bitmap over both per-player
-- indexes, then a heap fetch per game. Now each side is its own scan
-- (statsService.ts, playedSide) over one of these, which hold every column
-- the stats use, so a scan reads only that player's entries, in date order,
-- without visiting the table. The WHERE must match playedSide's. No column
-- here changes on a move, so moves stay HOT updates (migration 014).
CREATE INDEX IF NOT EXISTS games_white_rated_stats_idx
  ON games ("whiteId", "createdAt", id)
  INCLUDE ("time", "whiteRating", "whiteRatingChange", "blackRating", "winnerId")
  WHERE status = 'finished' AND result <> 'aborted' AND rated;
CREATE INDEX IF NOT EXISTS games_black_rated_stats_idx
  ON games ("blackId", "createdAt", id)
  INCLUDE ("time", "blackRating", "blackRatingChange", "whiteRating", "winnerId", "whiteId")
  WHERE status = 'finished' AND result <> 'aborted' AND rated;
