-- Puzzle index. This migration used to seed starter puzzles, but those had
-- invalid solutions and were removed; migration 005 seeds verified ones.
-- Load the full Lichess puzzle set with:
--   npm run import-puzzles -- <path-to-lichess_db_puzzle.csv>

CREATE INDEX IF NOT EXISTS puzzles_rating_idx ON puzzles (rating, id);
