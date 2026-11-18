-- Watch together: a study room linked to a live game, so friends watching
-- it share a private analysis board and chat (src/services/studyService.ts).
--
-- The room's main line is the game: clients ask the server to extend it
-- from the game's stored moves (the "sync_game" op); the live-game move
-- transaction never touches the room. While the game is in progress its
-- two players can't create, join, be invited to or open the room; once it
-- has ended the room is an ordinary study room. A linked room counts
-- toward its owner's room limit like any other.
ALTER TABLE study_rooms
  ADD COLUMN "gameId" integer REFERENCES games(id) ON DELETE SET NULL;
CREATE INDEX study_rooms_game_idx ON study_rooms ("gameId") WHERE "gameId" IS NOT NULL;

-- Chat between the members of a linked room, over the study socket. Text is
-- cleaned like game chat (src/game/chatText.ts) and the length check here
-- is the last line of defence. It goes the way game chat does: an hour
-- after the linked game ends (the same sweep), with the room, and with the
-- sender's account.
CREATE TABLE study_chat_messages (
  id bigserial PRIMARY KEY,
  "roomId" integer NOT NULL REFERENCES study_rooms(id) ON DELETE CASCADE,
  "senderId" integer NOT NULL REFERENCES users(id),
  body text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT study_chat_body_length CHECK (char_length(body) BETWEEN 1 AND 200)
);
-- A room's messages in order (history, and the per-sender count)
CREATE INDEX study_chat_messages_room_idx ON study_chat_messages ("roomId", id);
