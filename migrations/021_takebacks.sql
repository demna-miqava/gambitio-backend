-- Takebacks in live games: a player asks to take back their last move (and
-- the opponent's reply, if any); the opponent accepts or declines. Like a
-- draw offer, the pending request lives on the game row so it changes under
-- the row lock.
--
-- "takebackDeclinedFor" is the player whose request was declined since the
-- last move: they can't ask again until someone moves, so a declined request
-- can't be repeated over and over. Every move, an accepted takeback and the
-- end of the game clear both.

ALTER TABLE games
  ADD COLUMN "takebackRequestedBy" integer REFERENCES users(id),
  ADD COLUMN "takebackDeclinedFor" integer REFERENCES users(id);
