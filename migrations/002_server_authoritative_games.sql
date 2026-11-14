-- Server-authoritative games: clock, result, draw/rematch state live on the
-- game row so every state change happens under one row lock.

-- PGN grows past 512 chars around move 60; fen never needs a limit either.
ALTER TABLE games ALTER COLUMN pgn TYPE text, ALTER COLUMN fen TYPE text;

CREATE TYPE game_result AS ENUM ('white_win', 'black_win', 'draw', 'aborted');

ALTER TABLE games
  ADD COLUMN result game_result,
  ADD COLUMN "endReason" varchar(40),
  ADD COLUMN "endedAt" timestamptz,
  ADD COLUMN "whiteTimeLeftMs" integer,
  ADD COLUMN "blackTimeLeftMs" integer,
  ADD COLUMN "lastMoveAt" timestamptz,
  ADD COLUMN "deadlineAt" timestamptz,
  ADD COLUMN "drawOfferedBy" integer REFERENCES users(id),
  ADD COLUMN "rematchRequestedBy" integer REFERENCES users(id),
  ADD COLUMN "rematchGameId" integer REFERENCES games(id),
  ADD COLUMN "whiteRatingChange" integer,
  ADD COLUMN "blackRatingChange" integer;

UPDATE games SET "numMoves" = 0 WHERE "numMoves" IS NULL;
ALTER TABLE games ALTER COLUMN "numMoves" SET DEFAULT 0, ALTER COLUMN "numMoves" SET NOT NULL;
UPDATE games SET increment = 0 WHERE increment IS NULL;
ALTER TABLE games ALTER COLUMN increment SET DEFAULT 0, ALTER COLUMN increment SET NOT NULL;

-- Backfill results for finished games
UPDATE games SET
  result = CASE
    WHEN "winnerId" IS NULL THEN 'draw'::game_result
    WHEN "winnerId" = "whiteId" THEN 'white_win'::game_result
    ELSE 'black_win'::game_result
  END,
  "endedAt" = "createdAt"
WHERE status = 'finished';

-- Games left in progress by the old code have no clock on the row and can
-- never finish; close them without rating changes.
UPDATE games SET status = 'finished', result = 'aborted', "endReason" = 'aborted', "endedAt" = now()
WHERE status = 'in_progress';

ALTER TABLE games ADD CONSTRAINT games_finished_has_result
  CHECK (status = 'in_progress' OR result IS NOT NULL);
ALTER TABLE games ADD CONSTRAINT games_time_positive CHECK ("time" > 0 AND increment >= 0);

CREATE INDEX games_white_created_idx ON games ("whiteId", "createdAt" DESC);
CREATE INDEX games_black_created_idx ON games ("blackId", "createdAt" DESC);
CREATE INDEX games_deadline_idx ON games ("deadlineAt") WHERE status = 'in_progress';

-- Challenges: one pending challenge per pair, sane values
UPDATE challenges SET increment = 0 WHERE increment IS NULL;
ALTER TABLE challenges ALTER COLUMN increment SET DEFAULT 0, ALTER COLUMN increment SET NOT NULL;
DELETE FROM challenges a USING challenges b
  WHERE a.id > b.id AND a."challengerId" = b."challengerId" AND a."challengedId" = b."challengedId";
ALTER TABLE challenges
  ADD CONSTRAINT challenges_pair_key UNIQUE ("challengerId", "challengedId"),
  ADD CONSTRAINT challenges_not_self CHECK ("challengerId" <> "challengedId"),
  ADD CONSTRAINT challenges_time_positive CHECK ("time" > 0 AND increment >= 0);
CREATE INDEX challenges_challenged_idx ON challenges ("challengedId");

-- Matchmaking queue is transient; one entry per user
TRUNCATE matchmaking;
ALTER TABLE matchmaking ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE matchmaking ALTER COLUMN increment SET DEFAULT 0, ALTER COLUMN increment SET NOT NULL;
ALTER TABLE matchmaking ADD CONSTRAINT matchmaking_user_key UNIQUE ("userId");
CREATE INDEX matchmaking_pool_idx ON matchmaking ("time", increment, rating);

-- Friends: one row per pair regardless of order
CREATE UNIQUE INDEX friends_pair_key ON friends (LEAST("userOneId", "userTwoId"), GREATEST("userOneId", "userTwoId"));
CREATE UNIQUE INDEX friend_requests_pair_key ON friend_requests ("senderId", "receiverId");

-- Users: case-insensitive unique usernames. The old CHECK required more than
-- 3 characters while the API accepted 3, so 3-letter names failed with a 500.
ALTER TABLE users DROP CONSTRAINT username_min_length;
ALTER TABLE users ADD CONSTRAINT username_min_length CHECK (length(username) >= 3);
CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));
