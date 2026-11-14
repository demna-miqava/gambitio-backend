-- Indexes for the queries rewritten in the scalability pass, and fewer
-- indexes to maintain on every write.

-- users ----------------------------------------------------------------
-- Every game end and rated puzzle attempt rewrites a users row, and with it
-- every index on the table (the rating columns are indexed, so these are
-- never HOT updates). Drop the ones no query uses.

-- Duplicates the UNIQUE constraint's own index on "clerkId"
DROP INDEX IF EXISTS idx_users_clerk_id;

-- Rank counts now use the leaderboard's partial indexes (migration 010) so
-- profile ranks match the leaderboard; nothing reads these anymore
DROP INDEX IF EXISTS users_bullet_rating_idx;
DROP INDEX IF EXISTS users_blitz_rating_idx;
DROP INDEX IF EXISTS users_rapid_rating_idx;
DROP INDEX IF EXISTS users_all_rating_idx;
DROP INDEX IF EXISTS users_puzzle_rating_idx;

-- Rank counts for the "all" variant over listed players. The expression and
-- the WHERE must match allRatingExpr and listed("all") in
-- src/services/statsService.ts.
CREATE INDEX users_all_rating_listed_idx
  ON users (ROUND(("bulletRating" + "blitzRating" + "rapidRating") / 3.0))
  WHERE ("bulletGames" > 0 OR "blitzGames" > 0 OR "rapidGames" > 0) AND "clerkId" IS NOT NULL;

-- Username search (friend suggestions): ILIKE '%q%' and 'q%' use this
-- instead of reading every user
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX users_username_trgm_idx ON users USING gin (username gin_trgm_ops);

-- friend_requests ------------------------------------------------------
-- The unique index was directional, so A->B and B->A sent at the same moment
-- both went in. Keep the older of any such pair, then make the pair unique
-- regardless of direction. (friend_requests_pair_key stays: it is also the
-- index for "requests I sent".)
DELETE FROM friend_requests a USING friend_requests b
  WHERE a."senderId" = b."receiverId" AND a."receiverId" = b."senderId"
    AND (a."createdAt", a.id) > (b."createdAt", b.id);
CREATE UNIQUE INDEX friend_requests_unordered_pair_key
  ON friend_requests (LEAST("senderId", "receiverId"), GREATEST("senderId", "receiverId"));

-- games ----------------------------------------------------------------
-- Every move changed the indexed "deadlineAt", so every move wrote a new
-- entry in every index on games. Games now end at their deadline through an
-- in-process timer; the backstop sweep and the "games in progress" lookups
-- use these instead, whose columns a move never changes. Moves can then be
-- HOT updates (same page, no index writes), helped by leaving room on each
-- page for the growing PGN.
DROP INDEX IF EXISTS games_deadline_idx;
CREATE INDEX games_white_live_idx ON games ("whiteId") WHERE status = 'in_progress';
CREATE INDEX games_black_live_idx ON games ("blackId") WHERE status = 'in_progress';
ALTER TABLE games SET (fillfactor = 85);
