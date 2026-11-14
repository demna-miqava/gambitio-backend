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
Optional: `EXTRA_FRONTEND_ORIGINS`, comma-separated origins allowed besides
`FRONTEND_URL` (e.g. your LAN address, to open the dev server from a phone);
`PG_POOL_MAX` (Postgres connections, default 15); `PG_STATEMENT_TIMEOUT_MS`
(longest a query may run, default 5000); `ALLOW_LAN_ORIGINS=true` (local dev
only) also allows any private-network origin, so a phone keeps working when
the Mac's IP changes.

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
  to other instances), presence with one liveness key per instance
- `src/realtime/socket.ts` – socket message handling, rate limit, session
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
- `migrations/` – SQL migrations; `scripts/migrate.ts` applies them
