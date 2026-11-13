import { Container, getContainer } from "@cloudflare/containers";

/*
 * Gambitio on Cloudflare: this Worker serves the built frontend
 * (../gambitio-frontend/dist) and hands every /api request, WebSockets
 * included, to the Fastify backend running unchanged in a container.
 * Static files never reach this code; see "assets" in wrangler.jsonc.
 */

interface Env {
  BACKEND: DurableObjectNamespace<Backend>;
  // Plain vars, from wrangler.jsonc
  SITE_ORIGIN: string;
  /** How many backend containers share the load (at most max_instances) */
  BACKEND_INSTANCES?: string;
  // Secrets, set with `npx wrangler secret put <NAME>`
  POSTGRES_CONNECTION_STRING: string;
  REDIS_URL: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
}

/**
 * The backend container (the Dockerfile next to wrangler.jsonc).
 *
 * Open WebSockets count as activity, so it stays up while anyone has the site
 * open and goes to sleep 15 minutes after the last person leaves; the next
 * request starts it again in a few seconds. A game whose players both left
 * is settled when it wakes: startup arms a deadline timer for every game in
 * progress, from the stored timestamps.
 */
export class Backend extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "15m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: "production",
      PORT: "8080",
      FRONTEND_URL: env.SITE_ORIGIN,
      POSTGRES_CONNECTION_STRING: env.POSTGRES_CONNECTION_STRING,
      REDIS_URL: env.REDIS_URL,
      CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY,
      CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
    };
  }
}

/** Small stable string hash (FNV-1a), to spread keys over instances. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Which backend container serves a request. With BACKEND_INSTANCES = 1 (the
 * default) that is always "main". With more, the backends stay correct (they
 * coordinate through Postgres and Redis), and requests are spread so each
 * instance's in-memory state is useful:
 *
 * - A game's sockets (both players and every spectator) go to one instance,
 *   chosen by game id: moves are delivered without a Redis hop, and the
 *   game's parsed position stays cached there.
 * - Everything else goes by the caller's IP, so a player's requests keep
 *   hitting the same per-instance caches and rate limits.
 */
export function instanceFor(request: Request, instances: number): string {
  if (instances <= 1) return "main";
  const { pathname } = new URL(request.url);
  const game = /^\/api\/ws\/game\/(\d+)/.exec(pathname);
  const key = game ? `game:${game[1]}` : `ip:${request.headers.get("cf-connecting-ip") ?? ""}`;
  const index = hash(key) % instances;
  return index === 0 ? "main" : `main-${index}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const instances = Math.max(1, Math.floor(Number(env.BACKEND_INSTANCES ?? "1")) || 1);
    return getContainer(env.BACKEND, instanceFor(request, instances)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
