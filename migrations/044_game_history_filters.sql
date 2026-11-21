-- Game history filters (GET /users/:userId/games with result, timeControl,
-- color, rated, kind, opponent, since, before).
--
-- The history is read one side at a time (gameRepository.findPageByUserId):
-- the player's games as White, then as Black, newest first. With a filter,
-- the page and its total count need the filtered columns of every game the
-- player has: on the old ("whiteId", "createdAt") indexes that was a heap
-- fetch per game, a read of the player's whole history from the table (a
-- rare filter, like table games or rapid for a blitz player, did the same
-- just to fill page one). These replace them: same leading columns, so
-- every query that used the old ones still can, plus each column a filter
-- reads, so a filtered count is an index-only scan of the player's own
-- entries. Measured on a player with 60,000 games: a filtered count went
-- from reading every one of their games from the table to about 6 ms over
-- the index. The page itself still reads its rows from the table (the list
-- shows columns that aren't here). The opponent filter uses the opponent's
-- id column below.
--
-- None of these columns changes on a move, so moves stay HOT updates
-- (migration 014): "winnerId" and result change once, when the game ends,
-- which already updates the partial index on games in progress.
--
-- Migrations run inside a transaction, so these can't be built
-- CONCURRENTLY: building them blocks writes to games (moves, game starts
-- and ends) until the migration commits. Last on purpose for that reason.
CREATE INDEX games_white_history_idx
  ON games ("whiteId", "createdAt" DESC, id DESC)
  INCLUDE ("blackId", "time", rated, "winnerId", result, "botId", "tableGame", "tournamentId");
CREATE INDEX games_black_history_idx
  ON games ("blackId", "createdAt" DESC, id DESC)
  INCLUDE ("whiteId", "time", rated, "winnerId", result, "botId", "tableGame", "tournamentId");
DROP INDEX games_white_created_idx;
DROP INDEX games_black_created_idx;
