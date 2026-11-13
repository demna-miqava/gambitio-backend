import fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import postgres from "@fastify/postgres";
import { ZodError } from "zod";
import { registerRedis } from "./plugins/redis.js";
import { clerkAuthProvider, type AuthProvider } from "./plugins/authProvider.js";
import { AppError } from "./errors/AppError.js";
import { isUniqueViolation } from "./db.js";
import { RealtimeHub } from "./realtime/hub.js";
import { LiveGameService } from "./services/liveGameService.js";
import { MatchmakingService } from "./services/matchmakingService.js";
import { ChallengeService } from "./services/challengeService.js";
import { createJobs } from "./jobs.js";
import { UserLookup } from "./plugins/userLookup.js";
import { selectWsProtocol, wsHandshakeToken } from "./middleware/wsAuth.js";
import { allowedOrigins, type Config } from "./config.js";
import { userRoutes } from "./routes/users.js";
import { gameRoutes } from "./routes/games.js";
import { liveGameRoutes } from "./routes/liveGames.js";
import { webSocketRoutes } from "./routes/ws/index.js";
import { friendsRoutes } from "./routes/friends.js";
import { friendRequestsRoutes } from "./routes/friendRequests.js";
import { settingsRoutes } from "./routes/settings.js";
import { challengeRoutes } from "./routes/challenges.js";
import { puzzleRoutes } from "./routes/puzzles.js";
import { leaderboardRoutes } from "./routes/leaderboard.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    hub: RealtimeHub;
    liveGames: LiveGameService;
    matchmaking: MatchmakingService;
    challenges: ChallengeService;
    jobs: ReturnType<typeof createJobs>;
    users: UserLookup;
  }
}

export interface BuildOptions {
  /** Replaces Clerk token verification (tests). */
  authProvider?: AuthProvider;
  /** Start background sweepers (default true). */
  jobs?: boolean;
  logger?: boolean;
}

/**
 * The caller's address. On Cloudflare every request reaches the backend
 * through the Worker, so req.ip is Cloudflare's; the edge puts the real one
 * in CF-Connecting-IP (and overwrites any value a client sends).
 */
export function clientIp(req: { ip: string; headers: Record<string, string | string[] | undefined> }): string {
  const forwarded = req.headers["cf-connecting-ip"];
  return typeof forwarded === "string" && forwarded ? forwarded : req.ip;
}

/**
 * The `sub` claim of the caller's session token (bearer header or the
 * WebSocket handshake), read WITHOUT verifying the token. Only for rate-limit
 * keys, where it is always paired with the IP: a forged token then only
 * splits the forger's own traffic, it can't drain someone else's bucket.
 */
export function unverifiedSubject(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | null {
  const header = req.headers.authorization;
  const token =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7)
      : wsHandshakeToken(req.headers);
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload || payload.length > 4096) return null;
  try {
    const sub = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub.length <= 128 ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Requests per minute one IP may make in total, whatever tokens it sends.
 * The per-user limit (300/min) is the one people normally meet; this only
 * bounds a single address flooding with made-up tokens. Counted per instance.
 */
const PER_IP_PER_MINUTE = 3_000;

function perIpLimiter() {
  let windowStart = Date.now();
  let counts = new Map<string, number>();
  return (ip: string): boolean => {
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      counts = new Map();
    }
    const n = (counts.get(ip) ?? 0) + 1;
    counts.set(ip, n);
    return n <= PER_IP_PER_MINUTE;
  };
}

/** Removes ?token=... from logged URLs: WebSocket auth tokens travel in the query string. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]*/g, "$1[REDACTED]");
}

export async function buildApp(config: Config, options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = fastify({
    logger:
      options.logger === false
        ? false
        : {
            serializers: {
              req: (req) => ({
                method: req.method,
                url: redactUrl(req.url),
                host: req.host,
                remoteAddress: clientIp(req),
              }),
            },
          },
  });

  app.decorate("config", config);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "Validation error",
        code: "VALIDATION_ERROR",
        details: error.issues,
      });
    }
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: error.message, code: error.code });
    }
    if (isUniqueViolation(error)) {
      return reply.status(409).send({ error: "Already exists", code: "CONFLICT" });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: error.message, code: error.code });
    }
    request.log.error({ err: error }, "Unhandled error");
    return reply.status(500).send({ error: "Internal server error", code: "INTERNAL_ERROR" });
  });

  app.decorate(
    "authProvider",
    options.authProvider ??
      // Only accept session tokens minted for our own frontend
      clerkAuthProvider(config.CLERK_SECRET_KEY, allowedOrigins(config))
  );

  await app.register(postgres, {
    connectionString: config.POSTGRES_CONNECTION_STRING,
    max: config.PG_POOL_MAX,
    // Waiting this long for a free connection means the pool is saturated:
    // fail the request rather than queue it indefinitely
    connectionTimeoutMillis: 5_000,
    // Idle connections close, so an idle server lets Neon suspend
    idleTimeoutMillis: 30_000,
    statement_timeout: config.PG_STATEMENT_TIMEOUT_MS,
    // A transaction left open (a bug, a stuck await) releases its row locks
    idle_in_transaction_session_timeout: 10_000,
  });
  // Without a listener, an idle connection dropped by the database (or its
  // pooler, or Neon suspending) is an unhandled 'error' event and kills the
  // process. The pool discards the broken client and opens a new one.
  app.pg.pool.on("error", (err) => app.log.error({ err }, "Idle Postgres connection error"));
  await registerRedis(app, config.REDIS_URL);
  app.decorate("users", new UserLookup(app.pg));

  await app.register(cors, {
    origin: allowedOrigins(config),
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  });
  // Per signed-in user (and IP), so a school or club behind one address
  // doesn't share a single bucket; anonymous requests are limited per IP
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const ip = clientIp(req);
      const sub = unverifiedSubject(req);
      return sub ? `${ip}|${sub}` : ip;
    },
  });
  const ipAllowed = perIpLimiter();
  app.addHook("onRequest", async (req, reply) => {
    if (!ipAllowed(clientIp(req))) {
      return reply.status(429).send({ error: "Too many requests", code: "RATE_LIMITED" });
    }
  });
  await app.register(websocket, {
    options: { maxPayload: 16 * 1024, handleProtocols: selectWsProtocol },
  });

  const hub = new RealtimeHub(app.redis, app.log);
  app.decorate("hub", hub);
  app.decorate("liveGames", new LiveGameService(app, hub));
  app.decorate("matchmaking", new MatchmakingService(app, hub));
  app.decorate("challenges", new ChallengeService(app, hub));
  app.decorate("jobs", createJobs(app));

  app.addHook("onReady", async () => {
    await hub.start();
    if (options.jobs !== false) app.jobs.start();
  });
  // Hooks run in reverse order, so this runs before Redis/Postgres close
  app.addHook("onClose", async () => {
    app.jobs.stop();
    await hub.stop();
  });

  await app.register(userRoutes, { prefix: "/api" });
  await app.register(gameRoutes, { prefix: "/api" });
  await app.register(liveGameRoutes, { prefix: "/api" });
  await app.register(webSocketRoutes, { prefix: "/api" });
  await app.register(friendsRoutes, { prefix: "/api" });
  await app.register(friendRequestsRoutes, { prefix: "/api" });
  await app.register(settingsRoutes, { prefix: "/api" });
  await app.register(challengeRoutes, { prefix: "/api" });
  await app.register(puzzleRoutes, { prefix: "/api" });
  await app.register(leaderboardRoutes, { prefix: "/api" });

  return app;
}
