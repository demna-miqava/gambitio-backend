-- Chat between the two players of a live game.
--
-- Messages are plain text, cleaned by the server before they are stored (see
-- src/game/chatText.ts); the length check here is the last line of defence.
-- Only the two players ever receive them. They are deleted with the sender's
-- account and by a sweep an hour after their game ended.

CREATE TABLE game_chat_messages (
  id bigserial PRIMARY KEY,
  "gameId" integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  "senderId" integer NOT NULL REFERENCES users(id),
  body text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_chat_body_length CHECK (char_length(body) BETWEEN 1 AND 200)
);
-- A game's messages in order (history, and the per-player count)
CREATE INDEX game_chat_messages_game_idx ON game_chat_messages ("gameId", id);

-- Who a player chats with during games. Both players' settings must allow
-- the other for a game to have chat.
ALTER TABLE user_settings
  ADD COLUMN "gameChatAllowedFrom" messages_allowed_from NOT NULL DEFAULT 'everyone';
