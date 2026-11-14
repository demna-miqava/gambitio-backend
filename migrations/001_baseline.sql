-- Baseline: the schema as it existed before migrations were tracked.
-- On an existing database this file is recorded as applied without running
-- (see scripts/migrate.ts). On a fresh database it creates everything.

CREATE TYPE game_status AS ENUM ('in_progress', 'finished');
CREATE TYPE messages_allowed_from AS ENUM ('nobody', 'everyone', 'only_friends');
CREATE TYPE player_color AS ENUM ('white', 'black');
CREATE TYPE userstatus AS ENUM ('online', 'offline', 'in_game');

CREATE TABLE users (
    id serial PRIMARY KEY,
    username varchar(30),
    email varchar(255),
    "avatarUrl" varchar(255),
    "rapidRating" integer NOT NULL,
    "blitzRating" integer NOT NULL,
    "bulletRating" integer NOT NULL,
    "highestRapidRating" integer NOT NULL,
    "highestBlitzRating" integer NOT NULL,
    "highestBulletRating" integer NOT NULL,
    "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP,
    "clerkId" varchar(255) UNIQUE,
    CONSTRAINT username_min_length CHECK (length(username) > 3)
);
CREATE INDEX idx_users_clerk_id ON users ("clerkId");

CREATE TABLE user_settings (
    "userId" integer PRIMARY KEY REFERENCES users(id),
    "boardCoordinatesEnabled" boolean DEFAULT true,
    "moveHighlightEnabled" boolean DEFAULT true,
    "soundsEnabled" boolean DEFAULT true,
    "premovesEnabled" boolean DEFAULT false,
    "autoPromoteToQueenEnabled" boolean DEFAULT false,
    "confirmDrawResignationEnabled" boolean DEFAULT true,
    "showLegalMovesEnabled" boolean DEFAULT false,
    "engineEvaluationEnabled" boolean DEFAULT false,
    "showTimestampsEnabled" boolean DEFAULT false,
    "showRatingsDuringGameEnabled" boolean DEFAULT true,
    "pieceIconNotationEnabled" boolean DEFAULT false,
    "emailNotificationsEnabled" boolean DEFAULT false,
    "messagesAllowedFrom" messages_allowed_from DEFAULT 'nobody' NOT NULL
);

CREATE TABLE games (
    id serial PRIMARY KEY,
    "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP,
    pgn varchar(512),
    fen varchar(512),
    "winnerId" integer REFERENCES users(id),
    "numMoves" integer,
    "whiteRating" integer NOT NULL,
    "blackRating" integer NOT NULL,
    "time" integer NOT NULL,
    increment integer,
    "whiteId" integer REFERENCES users(id),
    "blackId" integer REFERENCES users(id),
    "whiteUsername" varchar(30) NOT NULL,
    "blackUsername" varchar(30) NOT NULL,
    "whiteAvatarUrl" varchar(255),
    "blackAvatarUrl" varchar(255),
    status game_status DEFAULT 'in_progress' NOT NULL
);

CREATE TABLE challenges (
    id serial PRIMARY KEY,
    "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP,
    "challengerId" integer NOT NULL REFERENCES users(id),
    "challengedId" integer NOT NULL REFERENCES users(id),
    "challengerUsername" varchar(30) NOT NULL,
    "challengedUsername" varchar(30),
    "challengerAvatarUrl" varchar(255),
    "challengedAvatarUrl" varchar(255),
    "time" integer NOT NULL,
    increment integer,
    "challengerColor" player_color DEFAULT 'white' NOT NULL
);

CREATE TABLE matchmaking (
    id serial PRIMARY KEY,
    "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP,
    rating integer NOT NULL,
    "time" integer NOT NULL,
    increment integer,
    "userId" integer REFERENCES users(id)
);

CREATE TABLE friends (
    id serial PRIMARY KEY,
    "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP,
    "userOneId" integer REFERENCES users(id),
    "userTwoId" integer REFERENCES users(id),
    "userOneUsername" varchar(30),
    "userTwoUsername" varchar(30)
);

CREATE TABLE friend_requests (
    id serial PRIMARY KEY,
    "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP,
    "senderId" integer REFERENCES users(id),
    "receiverId" integer REFERENCES users(id),
    "senderUsername" varchar(30) NOT NULL,
    "receiverUsername" varchar(30) NOT NULL,
    "senderAvatarUrl" varchar(255),
    "receiverAvatarUrl" varchar(255)
);

CREATE TABLE puzzles (
    id text PRIMARY KEY,
    fen text NOT NULL,
    moves text NOT NULL,
    rating integer NOT NULL,
    themes text[]
);
