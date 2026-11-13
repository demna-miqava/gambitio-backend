# Deploying Gambitio

One Cloudflare Worker serves the built frontend and forwards `/api` (REST and
WebSockets) to this backend, which runs in a Cloudflare Container. Postgres
(Neon) and Redis (Upstash) are hosted outside Cloudflare. See
`wrangler.jsonc` and `worker/index.ts`.

## 1. Accounts and services

1. **Cloudflare** – a domain on your account (Containers need the Workers
   Paid plan). Docker must be running locally: `wrangler deploy` builds the
   image from `Dockerfile`.
2. **Neon** – create a project in the region closest to your players. Copy
   the **pooled** connection string (host contains `-pooler`), with
   `?sslmode=require`.
3. **Upstash Redis** – create a database in a nearby region and copy the
   `rediss://` URL (TLS). The heartbeat and matchmaking sweep send a steady
   stream of commands, so check the plan's command limit.
4. **Clerk** – create a *production* instance for your domain and finish its
   DNS setup. You need its `pk_live_...` and `sk_live_...` keys.

## 2. Configuration

- `wrangler.jsonc`: set `routes[0].pattern` to your domain (no `https://`) and
  `vars.SITE_ORIGIN` to the same domain with `https://`.
- `../gambitio-frontend/.env.production`: set
  `VITE_CLERK_PUBLISHABLE_KEY=pk_live_...` (public, fine to commit).
- Secrets (stored by Cloudflare, never in files):

  ```bash
  npx wrangler secret put POSTGRES_CONNECTION_STRING   # Neon pooled URL
  npx wrangler secret put REDIS_URL                    # Upstash rediss:// URL
  npx wrangler secret put CLERK_PUBLISHABLE_KEY        # pk_live_...
  npx wrangler secret put CLERK_SECRET_KEY             # sk_live_...
  ```

## 3. Database

Migrations are not run by the deploy. Run them from your machine against the
production database before the first deploy, and again whenever
`migrations/` gains a file (before deploying the code that needs it):

```bash
POSTGRES_CONNECTION_STRING='postgres://...neon...' npx tsx scripts/migrate.ts
```

It only applies files not yet recorded in `schema_migrations`, so re-running
is safe. Run it from one place at a time.

Optional, the full puzzle set (see README):

```bash
POSTGRES_CONNECTION_STRING='postgres://...' npx tsx scripts/import-lichess-puzzles.ts ./lichess_db_puzzle.csv --limit 200000
```

## 4. Deploy

```bash
npm run deploy
```

This refuses to run without a `pk_live_` key, builds the frontend, then
builds the container image and deploys the Worker.

## 5. Check after deploying

- Sign up, finish profile setup, and play a game between two browsers
  (one private window): moves, clocks, resign, rematch.
- Close one player's tab mid-game and confirm the opponent sees them go and
  the game is settled by the clock.
- `npx wrangler tail` shows Worker and container logs.

## Known limits

- One container instance (`max_instances: 1`): every player shares one game
  server. It sleeps 15 minutes after the last connection closes and starts
  again on the next request (a few seconds).
- Deleting an account deletes the Clerk user from the backend
  (`DELETE /api/users/me`). Users deleted directly in the Clerk dashboard keep
  their Gambitio profile; there is no Clerk webhook yet.
