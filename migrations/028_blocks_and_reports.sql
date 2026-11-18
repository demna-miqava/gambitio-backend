-- Blocking and reporting players.
--
-- A block is one-directional (the blocker's choice) but cuts contact both
-- ways: neither player can challenge the other, send a friend request, chat
-- in a game or offer a rematch, and matchmaking doesn't pair them. Blocking
-- also ends a friendship and withdraws open requests and challenges between
-- the two. The blocked player is never told.
--
-- A report is a note for whoever moderates the site (see `npm run reports`).
-- "chatExcerpt" keeps the reported game's chat as it stood, since chat
-- messages are deleted an hour after their game ends (migration 025).

CREATE TABLE user_blocks (
  "blockerId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "blockedId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("blockerId", "blockedId"),
  CONSTRAINT user_blocks_not_self CHECK ("blockerId" <> "blockedId")
);
-- "Has this player blocked me?" is asked by the blocked player's id
CREATE INDEX user_blocks_blocked_idx ON user_blocks ("blockedId", "blockerId");

CREATE TABLE user_reports (
  id serial PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "reporterId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "reportedId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL,
  details text,
  -- The game it happened in, when reported from one
  "gameId" integer REFERENCES games(id) ON DELETE SET NULL,
  -- [{ "userId": 1, "text": "...", "at": "2026-11-18T10:00:00Z" }, ...]
  "chatExcerpt" jsonb,
  status text NOT NULL DEFAULT 'open',
  "resolvedAt" timestamptz,
  CONSTRAINT user_reports_not_self CHECK ("reporterId" <> "reportedId"),
  CONSTRAINT user_reports_reason CHECK (
    reason IN ('cheating', 'abusive_chat', 'unsporting', 'offensive_name', 'other')
  ),
  CONSTRAINT user_reports_status CHECK (status IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT user_reports_details_length CHECK (details IS NULL OR char_length(details) <= 1000)
);
CREATE INDEX user_reports_open_idx ON user_reports ("createdAt") WHERE status = 'open';
CREATE INDEX user_reports_reported_idx ON user_reports ("reportedId", "createdAt" DESC);
CREATE INDEX user_reports_reporter_idx ON user_reports ("reporterId", "createdAt" DESC);
