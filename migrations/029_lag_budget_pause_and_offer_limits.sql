-- Live-game clock and offer state. Every column here is added without an
-- index (and without a foreign key, which would need a scan of games to
-- validate): a move rewrites the row, and as long as it changes no indexed
-- column it stays a HOT update (see migration 014). Each ADD COLUMN has a
-- constant default or none, so it only changes the catalog and doesn't
-- rewrite the table.

-- Lag budgets (src/game/clock.ts): what is left of each player's allowance
-- for network delay the server can't measure. Spent when a move claims more
-- delay than the server measured, refilled a little on every move.
ALTER TABLE games
  ADD COLUMN "whiteLagBudgetMs" integer NOT NULL DEFAULT 500,
  ADD COLUMN "blackLagBudgetMs" integer NOT NULL DEFAULT 500;

-- Set when the server holding the game's player sockets shuts down (a deploy
-- or restart), so the downtime isn't charged to the side to move. Resuming
-- shifts "lastMoveAt" and "deadlineAt" forward by the pause (at most a
-- minute) and clears it. See LiveGameService.pauseForShutdown.
ALTER TABLE games
  ADD COLUMN "pausedAt" timestamptz;

-- The player whose draw offer was declined: they can't offer again until
-- they have made a move. Like "takebackDeclinedFor" (migration 021), but
-- only the offerer's own move clears it.
ALTER TABLE games
  ADD COLUMN "drawDeclinedFor" integer;

-- Whether each player has asked for a rematch of this (finished) game. One
-- request each: a declined or cancelled request can't be sent again.
ALTER TABLE games
  ADD COLUMN "whiteRematchAsked" boolean NOT NULL DEFAULT false,
  ADD COLUMN "blackRematchAsked" boolean NOT NULL DEFAULT false;
