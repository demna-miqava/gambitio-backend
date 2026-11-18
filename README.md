# Gambitio backend

Fastify + PostgreSQL + Redis. The server is authoritative for games: it
validates every move with chess.js, runs the clocks, detects checkmate and
draws, and decides results. Clients only send intents (move, resign, offer draw).

## Setup

```bash
npm install
cp .env.example .env   # fill in values
npm run migrate        # applies migrations/*.sql
npm run dev            # watch mode
```

Production: `npm run build && npm start`.

Required env (validated at startup in `src/config.ts`): `POSTGRES_CONNECTION_STRING`,
`REDIS_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `FRONTEND_URL`, `PORT`.
Optional: `CLERK_JWT_KEY`, the Clerk instance's JWT public key (dashboard,
API keys, "JWT public key": the PEM text; one line with `\n` escapes works
too). With it, session tokens are verified locally and never cause a call to
Clerk. Without it the server downloads Clerk's signing keys itself, at most
once a minute for a token whose key it doesn't know, so made-up tokens can't
make it call Clerk on every request (`SigningKeys` in
`src/plugins/authProvider.ts`). `EXTRA_FRONTEND_ORIGINS`, comma-separated origins allowed besides
`FRONTEND_URL` (e.g. your LAN address, to open the dev server from a phone);
`PG_POOL_MAX` (Postgres connections, default 15); `PG_STATEMENT_TIMEOUT_MS`
(longest a query may run, default 5000); `ALLOW_LAN_ORIGINS=true` (local dev
only) also allows any private-network origin, so a phone keeps working when
the Mac's IP changes; `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (both or
neither, from `npm run generate-vapid-keys`) turn web push notifications on,
with `VAPID_SUBJECT` as the contact address push services see (a `mailto:` or
`https:` address, default `FRONTEND_URL`).

To open the dev server from a phone on the same Wi-Fi, run the backend with
`ALLOW_LAN_ORIGINS=true` and the frontend with `VITE_API_BASE_URL` and
`VITE_WS_BASE_URL` empty and `--host`: the app then calls its own origin and
Vite proxies `/api` to the backend.

### Puzzles

Puzzles are split in two halves by id: rated (Infinite) mode serves one,
never sends its solutions and checks every move on the server
(`POST /api/puzzles/:id/check`); Rush and Survival serve the other half with
solutions, to play locally. See `RATED_POOL_SQL` in
`src/services/puzzleService.ts`.

Migration 005 seeds a handful of verified puzzles. Load the full Lichess set
(https://database.lichess.org/#puzzles, decompress with `zstd -d`):

```bash
npm run import-puzzles -- ./lichess_db_puzzle.csv --limit 200000
```

## Tests

```bash
npm test
```

Unit tests always run. Integration tests (real WebSockets against a real
database) need a migrated throwaway database and a Redis instance:

```bash
createdb chess_test
POSTGRES_CONNECTION_STRING=postgres://.../chess_test npm run migrate
redis-server --port 6390 --save "" --daemonize yes
TEST_POSTGRES_URL=postgres://.../chess_test TEST_REDIS_URL=redis://localhost:6390 npm test
```

Auth is faked in tests (no Clerk calls) via `buildApp(config, { authProvider })`.

## Layout

- `src/game/` – pure chess rules (`engine.ts`) and clock math (`clock.ts`)
- `src/services/liveGameService.ts` – every live-game action, each in a
  transaction holding the game row lock
- `src/services/gameService.ts` – game creation (the only place games are
  created), ending games and rating updates
- `src/services/matchmakingService.ts` – queue pairing with `FOR UPDATE SKIP LOCKED`
- `src/game/positionCache.ts` – parsed positions of live games, so a move
  doesn't replay the game from its PGN
- `src/realtime/hub.ts` – WebSocket delivery (local first, then Redis pub/sub
  to other instances, skipped while no other instance is running), presence
  with one liveness key per instance
- `src/realtime/socket.ts` – socket message handling, rate limits (per
  socket, and per user across all their sockets on an instance), session
  re-authentication
- `src/jobs.ts` – backstop sweeps that only run while there's something to
  do; games end at their deadline through per-game timers
  (`LiveGameService.watchDeadline`)
- `src/game/series.ts`, `src/services/seriesService.ts` – best-of-3/5 friend
  series: a challenge with `bestOf` starts one; each game is scored in the
  transaction that ends it, and the next game is the rematch (the series
  picks the colours). Head-to-head records live here too
- `src/game/repertoire.ts`, `src/services/repertoireService.ts` – opening
  repertoire lines, spaced-repetition practice, and where recent games left
  the preparation (`GET /api/repertoire/check`)
- `src/game/studyState.ts`, `src/services/studyService.ts`,
  `src/routes/ws/study.ts` – shared study rooms: one JSON move tree per room,
  changed under the room's row lock with a version number; the socket sends
  small updates (cursor, node, tree) and clients resync on a version gap
- `src/routes/endgames.ts` – endgame lab progress (the exercises run in the
  browser)
- `src/game/chatText.ts`, `src/services/gameChatService.ts` – chat between
  the two players of a live game, over the game socket (`{ type: "chat" }`).
  Text is cleaned (invisible and control characters, length) and stored as
  typed; it is never escaped or put into SQL, only bound as a parameter.
  Messages go to the two players' own topics, so spectators never get them.
  Each player's `gameChatAllowedFrom` setting must allow the other; changing
  it during a game sends both players a `chat_status`, so the opponent sees
  that chat went off. Messages are deleted an hour after their game ends
- `src/services/challengeService.ts` – challenges. Who may challenge a player
  is their `challengesAllowedFrom` setting (anyone, friends, no one);
  challenges are limited per pair and have a cooldown after a decline, and
  challenges to non-friends are rate-limited. A challenge has a `version`
  that changes with its terms; accepting can name it, and a stale one is
  refused with `CHALLENGE_CHANGED` (migration 030)
- `src/services/pushService.ts`, `src/routes/push.ts` – web push: browsers
  register a subscription, and challenges, friend requests and game starts
  are also sent as notifications, throttled per recipient and deduplicated
  per kind and sender. Endpoints are only accepted on the browsers' own push
  services
- `migrations/` – SQL migrations; `scripts/migrate.ts` applies them
