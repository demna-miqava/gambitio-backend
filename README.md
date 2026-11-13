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
`FRONTEND_URL` (e.g. your LAN address, to open the dev server from a phone).

### Puzzles

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
- `src/realtime/hub.ts` – WebSocket delivery via Redis pub/sub, presence, heartbeats
- `src/jobs.ts` – clock and matchmaking sweepers (safe on every instance)
- `migrations/` – SQL migrations; `scripts/migrate.ts` applies them
