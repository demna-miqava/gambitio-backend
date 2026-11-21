-- Puzzle duels (src/services/puzzleDuelService.ts): two friends race
-- through the same puzzles, in the same order, for three minutes, by Puzzle
-- Rush's rules (a wrong move is a strike and moves on; three strikes and
-- you're out). The server owns the clock and the score and checks every
-- move; solutions reach a browser only once that player is done with the
-- puzzle.
--
-- Puzzles come from the unrated half (see RATED_POOL_SQL in
-- src/services/puzzleService.ts), the half Rush and Survival already serve
-- with solutions, so a duel never shows, solves or uses up a puzzle rated
-- mode would later serve. Nothing here touches puzzle ratings,
-- puzzle_attempts or solved_puzzles. No rating, no leaderboard.
--
-- Only new tables; nothing existing is altered.

CREATE TABLE puzzle_duels (
  id serial PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  -- playerOne sent the invite, playerTwo accepted it
  "playerOneId" integer NOT NULL REFERENCES users(id),
  "playerTwoId" integer NOT NULL REFERENCES users(id),
  -- The puzzles, easiest first; both players get them in this order
  "puzzleIds" text[] NOT NULL,
  -- After a short countdown from the accept
  "startsAt" timestamptz NOT NULL,
  "endsAt" timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active',
  "endedAt" timestamptz,
  -- 'time': the clock ran out; 'both_out': both players reached three strikes
  "endReason" text,
  -- Null for a draw (equal scores)
  "winnerId" integer REFERENCES users(id),
  "rematchOf" integer REFERENCES puzzle_duels(id) ON DELETE SET NULL,
  CONSTRAINT puzzle_duels_two_players CHECK ("playerOneId" <> "playerTwoId"),
  CONSTRAINT puzzle_duels_status CHECK (status IN ('active', 'finished')),
  CONSTRAINT puzzle_duels_end_reason CHECK ("endReason" IS NULL OR "endReason" IN ('time', 'both_out')),
  CONSTRAINT puzzle_duels_clock CHECK ("endsAt" > "startsAt")
);
-- The backstop sweep: active duels by when their clock runs out
CREATE INDEX puzzle_duels_active_idx ON puzzle_duels ("endsAt") WHERE status = 'active';

-- Each player's run through a duel
CREATE TABLE puzzle_duel_players (
  "duelId" integer NOT NULL REFERENCES puzzle_duels(id) ON DELETE CASCADE,
  "userId" integer NOT NULL REFERENCES users(id),
  score smallint NOT NULL DEFAULT 0,
  strikes smallint NOT NULL DEFAULT 0,
  -- Index into the duel's puzzleIds of the puzzle the player is on
  "current" smallint NOT NULL DEFAULT 0,
  -- The player's own moves (UCI) in the current puzzle so far
  progress text[] NOT NULL DEFAULT '{}',
  -- One entry per finished puzzle, in order: [{ "index": 0, "solved": true }, ...]
  results jsonb NOT NULL DEFAULT '[]',
  -- When the third strike came
  "outAt" timestamptz,
  PRIMARY KEY ("duelId", "userId"),
  CONSTRAINT puzzle_duel_players_strikes CHECK (strikes BETWEEN 0 AND 3)
);
-- A player's duels (one active at a time, their history)
CREATE INDEX puzzle_duel_players_user_idx ON puzzle_duel_players ("userId", "duelId" DESC);

-- An invite to a duel, answered from the inbox. Friends only, no block
-- either way; it expires after a few minutes.
CREATE TABLE puzzle_duel_invites (
  id serial PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "senderId" integer NOT NULL REFERENCES users(id),
  "recipientId" integer NOT NULL REFERENCES users(id),
  "expiresAt" timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  "duelId" integer REFERENCES puzzle_duels(id) ON DELETE SET NULL,
  -- A rematch: the duel it follows
  "rematchOf" integer REFERENCES puzzle_duels(id) ON DELETE SET NULL,
  CONSTRAINT puzzle_duel_invites_two_players CHECK ("senderId" <> "recipientId"),
  CONSTRAINT puzzle_duel_invites_status CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired'))
);
-- One waiting invite per sender and recipient
CREATE UNIQUE INDEX puzzle_duel_invites_pending_pair ON puzzle_duel_invites ("senderId", "recipientId")
  WHERE status = 'pending';
-- A player's inbox, and the expiry sweep
CREATE INDEX puzzle_duel_invites_recipient_idx ON puzzle_duel_invites ("recipientId") WHERE status = 'pending';
CREATE INDEX puzzle_duel_invites_expiry_idx ON puzzle_duel_invites ("expiresAt") WHERE status = 'pending';
