-- createdAt columns were "timestamp without time zone", filled by
-- CURRENT_TIMESTAMP in the server's time zone. Casting uses the session time
-- zone (the same server default), so existing values keep their meaning.
ALTER TABLE users ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt"::timestamptz;
ALTER TABLE games ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt"::timestamptz;
ALTER TABLE challenges ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt"::timestamptz;
ALTER TABLE matchmaking ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt"::timestamptz;
ALTER TABLE friends ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt"::timestamptz;
ALTER TABLE friend_requests ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt"::timestamptz;

-- Lookups from the second side of a pair
CREATE INDEX friends_user_two_idx ON friends ("userTwoId");
CREATE INDEX friend_requests_receiver_idx ON friend_requests ("receiverId");

-- Global rank / percentile counts (stats) become index-only scans.
-- The expression must match ALL_RATING_EXPR in statsService.ts.
CREATE INDEX users_bullet_rating_idx ON users ("bulletRating");
CREATE INDEX users_blitz_rating_idx ON users ("blitzRating");
CREATE INDEX users_rapid_rating_idx ON users ("rapidRating");
CREATE INDEX users_all_rating_idx ON users (ROUND(("bulletRating" + "blitzRating" + "rapidRating") / 3.0));
