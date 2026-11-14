-- Shared study rooms: friends explore one board together. The whole
-- analysis (move tree, comments, arrows, and where the group is looking)
-- is one JSON document, changed only under the room's row lock; "version"
-- goes up with every change so clients can tell when they missed one.
-- See src/game/studyState.ts for its shape.

CREATE TABLE study_rooms (
  id serial PRIMARY KEY,
  "ownerId" integer NOT NULL REFERENCES users(id),
  name varchar(80) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0,
  state jsonb NOT NULL
);
CREATE INDEX study_rooms_owner_idx ON study_rooms ("ownerId");

-- The owner is a member too
CREATE TABLE study_room_members (
  "roomId" integer NOT NULL REFERENCES study_rooms(id) ON DELETE CASCADE,
  "userId" integer NOT NULL REFERENCES users(id),
  "joinedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("roomId", "userId")
);
CREATE INDEX study_room_members_user_idx ON study_room_members ("userId");
