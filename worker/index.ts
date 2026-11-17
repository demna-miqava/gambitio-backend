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
  /** Which set of backend objects serves requests; see generationOf */
  BACKEND_GENERATION?: string;
  // Secrets, set with `npx wrangler secret put <NAME>`
  POSTGRES_CONNECTION_STRING: string;
  REDIS_URL: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  // Optional secrets: web push is off without the two keys (see DEPLOY.md)
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
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
      ...(env.VAPID_PUBLIC_KEY &&
        env.VAPID_PRIVATE_KEY && {
          VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
          VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
          ...(env.VAPID_SUBJECT && { VAPID_SUBJECT: env.VAPID_SUBJECT }),
        }),
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
export function instanceFor(request: Request, instances: number, generation = 1): string {
  if (instances <= 1) return instanceName(0, generation);
  const { pathname } = new URL(request.url);
  const game = /^\/api\/ws\/game\/(\d+)/.exec(pathname);
  const key = game ? `game:${game[1]}` : `ip:${request.headers.get("cf-connecting-ip") ?? ""}`;
  return instanceName(hash(key) % instances, generation);
}

/** "main", "main-1", ... in generation 1; "g2-main", "g2-main-1", ... after that. */
export function instanceName(index: number, generation: number): string {
  const base = index === 0 ? "main" : `main-${index}`;
  return generation <= 1 ? base : `g${generation}-${base}`;
}

/**
 * BACKEND_GENERATION (wrangler.jsonc), a whole number from 1.
 *
 * A Backend object reads its secrets and settings once, when it is created,
 * and Cloudflare keeps it (and so its container) alive for as long as anyone
 * has the site open. A changed or added secret, or a change to the Backend
 * class itself, therefore doesn't reach a backend that is already running,
 * not even when a deploy replaces its container.
 *
 * Raising the generation and deploying makes this Worker, which is always
 * the current code, send every request to backends with new names: they are
 * created on the spot, with today's code and secrets. The previous
 * generation's containers are stopped (retirePrevious); people connected to
 * them reconnect to the new ones within a few seconds.
 */
export function generationOf(value: string | undefined): number {
  const n = Math.floor(Number(value ?? "1"));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

let previousRetired = false;

/**
 * Stops the previous generation's containers, once per Worker instance. They
 * would otherwise run on, with the old settings, until the last person
 * connected to them left. Stopping one that isn't running does nothing.
 */
async function retirePrevious(env: Env, instances: number, generation: number): Promise<void> {
  if (previousRetired || generation <= 1) return;
  previousRetired = true;
  for (let index = 0; index < instances; index++) {
    await getContainer(env.BACKEND, instanceName(index, generation - 1))
      .destroy()
      .catch((error: unknown) => console.log("Stopping an old backend failed", String(error)));
  }
}

/** Must match max_instances in wrangler.jsonc: a higher BACKEND_INSTANCES would route to containers that can't start. */
const MAX_INSTANCES = 4;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const instances = Math.min(MAX_INSTANCES, Math.max(1, Math.floor(Number(env.BACKEND_INSTANCES ?? "1")) || 1));
    const generation = generationOf(env.BACKEND_GENERATION);
    ctx.waitUntil(retirePrevious(env, instances, generation));
    return getContainer(env.BACKEND, instanceFor(request, instances, generation)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
