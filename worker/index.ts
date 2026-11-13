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
 * is settled by the clock sweep when it wakes, from the stored timestamps.
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One named instance: every player shares the same game server.
    return getContainer(env.BACKEND, "main").fetch(request);
  },
} satisfies ExportedHandler<Env>;
