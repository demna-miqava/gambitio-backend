-- Who may challenge a player to a game. Until now only friends could; the
-- default opens challenges to everyone, and a player can narrow it to friends
-- or turn them off.
--
-- "focusModeEnabled": during a live game, show only the board, the clocks and
-- the game actions.

ALTER TABLE user_settings
  ADD COLUMN "challengesAllowedFrom" messages_allowed_from NOT NULL DEFAULT 'everyone',
  ADD COLUMN "focusModeEnabled" boolean NOT NULL DEFAULT false;
