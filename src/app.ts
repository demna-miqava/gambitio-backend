import { isIPv4, isIPv6 } from "node:net";
import fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import postgres from "@fastify/postgres";
import { ZodError } from "zod";
import { registerRedis } from "./plugins/redis.js";
import { clerkAuthProvider, type AuthProvider } from "./plugins/authProvider.js";
import { AppError } from "./errors/AppError.js";
import { isUniqueViolation, ensureSessionTimeouts } from "./db.js";
import { RealtimeHub } from "./realtime/hub.js";
import { LiveGameService } from "./services/liveGameService.js";
import { MatchmakingService } from "./services/matchmakingService.js";
import { ChallengeService } from "./services/challengeService.js";
import { SeriesService } from "./services/seriesService.js";
import { StudyService } from "./services/studyService.js";
import { GameChatService } from "./services/gameChatService.js";
import { ModerationService } from "./services/moderationService.js";
import { TournamentService } from "./services/tournamentService.js";
import { PushService, webPushSender, type PushSender } from "./services/pushService.js";
import { createJobs } from "./jobs.js";
import { UserLookup } from "./plugins/userLookup.js";
import { selectWsProtocol, wsHandshakeToken } from "./middleware/wsAuth.js";
import { originChecker, vapidKeys, type Config } from "./config.js";
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
import { seriesRoutes } from "./routes/series.js";
import { repertoireRoutes } from "./routes/repertoire.js";
import { studyRoutes } from "./routes/study.js";
import { endgameRoutes } from "./routes/endgames.js";
import { pushRoutes } from "./routes/push.js";
import { moderationRoutes } from "./routes/moderation.js";
import { tournamentRoutes } from "./routes/tournaments.js";
import { openingRoutes } from "./routes/openings.js";
import { conversionDrillRoutes } from "./routes/conversionDrills.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    hub: RealtimeHub;
    liveGames: LiveGameService;
    matchmaking: MatchmakingService;
    challenges: ChallengeService;
    series: SeriesService;
    study: StudyService;
    gameChat: GameChatService;
    moderation: ModerationService;
    tournaments: TournamentService;
    push: PushService;
    jobs: ReturnType<typeof createJobs>;
    users: UserLookup;
  }
}

export interface BuildOptions {
  /** Replaces Clerk token verification (tests). */
  authProvider?: AuthProvider;
  /** Replaces delivery to the browsers' push services (tests); turns push on without VAPID keys. */
  pushSender?: PushSender;
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
 * The address a rate limit counts against. IPv4 addresses (and IPv4-mapped
 * IPv6 ones, ::ffff:1.2.3.4) count one by one. IPv6 addresses count by their
 * /64 prefix: that is the smallest block a home or phone connection is given,
 * and anyone holding one can pick a fresh address from it for every request,
 * so counting exact addresses would give them a new bucket each time. A
 * value that isn't an address at all is used as it is.
 */
export function rateLimitAddress(ip: string): string {
  const address = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return address;
  const hextets = expandIPv6(address);
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    const [hi, lo] = [hextets[6]!, hextets[7]!];
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${hextets.slice(0, 4).map((h) => h.toString(16)).join(":")}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address, "::" and a dotted IPv4 tail expanded. */
function expandIPv6(address: string): number[] {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const parse = (part: string | undefined) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  const left = parse(head);
  const right = parse(tail);
  const zeros = tail === undefined ? [] : new Array<number>(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
}

/**
 * The `sub` claim of the caller's session token (bearer header or the
 * WebSocket handshake), read WITHOUT verifying the token. No longer used for
 * rate-limit keys (they are verified ids now, see rateLimitKey); kept for
 * code and tests that read it.
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
 * The key a request's rate limit (300/min, or a route's own) counts
 * against: the signed-in user when authentication succeeded, otherwise the
 * caller's address (rateLimitAddress). The limiter runs as a preHandler, after
 * the route's own preHandler (authMiddleware, clerkAuthMiddleware) or
 * preValidation (wsAuthHook) has verified the token, so the key can never be
 * a claim the caller made up: made-up tokens can neither split one person's
 * traffic over many buckets nor fill the limiter's memory with fake users and
 * push real users' counters out. Requests whose token fails verification are
 * answered 401 before the limiter and are bounded by the per-address limit.
 */
export function rateLimitKey(req: {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
  user?: { id: number } | undefined;
  wsUser?: { id: number } | undefined;
  clerkId?: string | undefined;
}): string {
  const userId = req.user?.id ?? req.wsUser?.id;
  if (userId !== undefined) return `user:${userId}`;
  // Signed in with Clerk, no profile yet (profile setup)
  if (req.clerkId) return `clerk:${req.clerkId}`;
  return `ip:${rateLimitAddress(clientIp(req))}`;
}

/**
 * Requests per minute one address (an IPv4 address or an IPv6 /64, see
 * rateLimitAddress) may make in total, whatever tokens it sends. Counted
 * before anything else, so it also covers requests that fail
 * authentication. The per-user limit (300/min) is the one people normally
 * meet; this bounds one address flooding, and still lets a school or club
 * behind one address use the site together. Counted per instance.
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
    const key = rateLimitAddress(ip);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
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

  const isAllowedOrigin = originChecker(config);
  app.decorate(
    "authProvider",
    options.authProvider ??
      clerkAuthProvider({
        secretKey: config.CLERK_SECRET_KEY,
        jwtKey: config.CLERK_JWT_KEY,
        // Only accept session tokens minted for our own frontend
        isAuthorizedParty: isAllowedOrigin,
        log: app.log,
      })
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
    origin: (origin, callback) => callback(null, origin !== undefined && isAllowedOrigin(origin)),
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  });
  // Per signed-in user, so a school or club behind one address doesn't
  // share a single bucket; anonymous requests are limited per address. Runs
  // after authentication so the key is a verified id: see rateLimitKey.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    hook: "preHandler",
    keyGenerator: rateLimitKey,
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
  app.decorate("series", new SeriesService(app, hub));
  app.decorate("study", new StudyService(app, hub));
  app.decorate("gameChat", new GameChatService(app, hub));
  app.decorate("moderation", new ModerationService(app, hub));
  app.decorate("tournaments", new TournamentService(app, hub));
  const vapid = vapidKeys(config);
  app.decorate(
    "push",
    new PushService(app, {
      publicKey: vapid?.publicKey ?? (options.pushSender ? "test-public-key" : null),
      sender: options.pushSender ?? (vapid ? webPushSender(vapid) : null),
    })
  );
  app.decorate("jobs", createJobs(app));

  app.addHook("onReady", async () => {
    await ensureSessionTimeouts(
      app.pg,
      { statement_timeout: config.PG_STATEMENT_TIMEOUT_MS, idle_in_transaction_session_timeout: 10_000 },
      app.log
    ).catch((err) => app.log.error({ err }, "Couldn't verify Postgres session timeouts"));
    await hub.start();
    if (options.jobs !== false) app.jobs.start();
  });
  // Hooks run in reverse order, so this runs before Redis/Postgres close
  app.addHook("onClose", async () => {
    app.jobs.stop();
    app.tournaments.stop();
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
  await app.register(seriesRoutes, { prefix: "/api" });
  await app.register(repertoireRoutes, { prefix: "/api" });
  await app.register(studyRoutes, { prefix: "/api" });
  await app.register(endgameRoutes, { prefix: "/api" });
  await app.register(pushRoutes, { prefix: "/api" });
  await app.register(moderationRoutes, { prefix: "/api" });
  await app.register(tournamentRoutes, { prefix: "/api" });
  await app.register(openingRoutes, { prefix: "/api" });
  await app.register(conversionDrillRoutes, { prefix: "/api" });

  return app;
}
