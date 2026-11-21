-- Spectator chat: one shared chat for everyone watching a live game
-- (src/services/spectatorChatService.ts), over the game socket.
--
-- The game's two players never receive it, during the game or after: the
-- server never subscribes a player's socket to it, sends no history to
-- them, and leaves both players out of every delivery. Text is cleaned like
-- game chat (src/game/chatText.ts); the length check here is the last line
-- of defence. Messages go an hour after the game ends (the game chat
-- sweep), and with the sender's account.
--
-- Only new objects and a small table (user_reports) are touched; the games
-- table isn't altered. Code from before this migration keeps working with
-- it applied.
CREATE TABLE spectator_chat_messages (
  id bigserial PRIMARY KEY,
  "gameId" integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  "senderId" integer NOT NULL REFERENCES users(id),
  body text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spectator_chat_body_length CHECK (char_length(body) BETWEEN 1 AND 200)
);
-- A game's messages in order (history, the per-sender count, the sweep's join)
CREATE INDEX spectator_chat_messages_game_idx ON spectator_chat_messages ("gameId", id);
-- Account deletion removes a sender's messages
CREATE INDEX spectator_chat_messages_sender_idx ON spectator_chat_messages ("senderId");

-- A report filed from a game's spectator chat: the game, with that chat
-- copied into "chatExcerpt" (as a game report copies the players' chat).
-- A report has at most one context: a game it was played in, a study room,
-- or a game's spectator chat.
ALTER TABLE user_reports
  ADD COLUMN "spectatorGameId" integer REFERENCES games(id) ON DELETE SET NULL,
  DROP CONSTRAINT user_reports_one_context,
  ADD CONSTRAINT user_reports_one_context CHECK (
    num_nonnulls("gameId", "studyRoomId", "spectatorGameId") <= 1
  );
CREATE INDEX user_reports_spectator_game_idx ON user_reports ("spectatorGameId")
  WHERE "spectatorGameId" IS NOT NULL;
