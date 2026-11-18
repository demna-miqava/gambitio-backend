import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildApp, type BuildOptions } from "../src/app.js";
import type { AuthProvider } from "../src/plugins/authProvider.js";

/**
 * Integration tests need a throwaway Postgres database (migrated) and Redis:
 *   TEST_POSTGRES_URL=postgres://.../chess_test TEST_REDIS_URL=redis://localhost:6390 npm test
 * They are skipped when these aren't set. Auth is faked: the bearer token or
 * WebSocket token *is* the Clerk user id, so Clerk is never called.
 */
export const TEST_POSTGRES_URL = process.env.TEST_POSTGRES_URL;
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
export const integrationEnabled = Boolean(TEST_POSTGRES_URL && TEST_REDIS_URL);

export const fakeAuth: AuthProvider = {
  verifyToken: async (token) => token,
  getEmail: async (clerkId) => `${clerkId}@test.local`,
  deleteUser: async () => {},
};

export async function startTestApp(
  options: Pick<BuildOptions, "pushSender"> = {}
): Promise<{ app: FastifyInstance; baseUrl: string }> {
  const app = await buildApp(
    {
      NODE_ENV: "test",
      PORT: 0,
      POSTGRES_CONNECTION_STRING: TEST_POSTGRES_URL!,
      REDIS_URL: TEST_REDIS_URL!,
      PG_POOL_MAX: 10,
      PG_STATEMENT_TIMEOUT_MS: 5_000,
      CLERK_PUBLISHABLE_KEY: "pk_test",
      CLERK_SECRET_KEY: "sk_test",
      FRONTEND_URL: "http://localhost:5173",
    },
    { authProvider: fakeAuth, jobs: false, logger: false, ...options }
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { app, baseUrl: `127.0.0.1:${port}` };
}

export async function resetDb(app: FastifyInstance) {
  await app.pg.query(
    `TRUNCATE games, series, challenges, matchmaking, friends, friend_requests, user_settings, puzzle_attempts,
       repertoire_lines, study_rooms, study_room_members, endgame_progress, tournaments, tournament_players, users
     RESTART IDENTITY CASCADE`
  );
  await app.redis.flushDb();
  // Ids restart, so cached Clerk id -> user entries would point at old rows
  app.users.clear();
  app.tournaments.clear();
}

export async function createUser(
  app: FastifyInstance,
  name: string,
  rating = 1200
): Promise<{ id: number; clerkId: string }> {
  const clerkId = `clerk_${name}`;
  const { rows } = await app.pg.query<{ id: number }>(
    `INSERT INTO users ("clerkId", email, username, "rapidRating", "blitzRating", "bulletRating",
       "highestRapidRating", "highestBlitzRating", "highestBulletRating")
     VALUES ($1, $2, $3, $4, $4, $4, $4, $4, $4) RETURNING id`,
    [clerkId, `${name}@test.local`, name, rating]
  );
  return { id: rows[0]!.id, clerkId };
}

export interface TestSocket {
  ws: WebSocket;
  messages: any[];
  /** Resolves with the next unseen message of this type (optionally matching). */
  next(type: string, match?: (m: any) => boolean, timeoutMs?: number): Promise<any>;
  /** Asserts no message of this type arrives within the window. */
  none(type: string, windowMs?: number): Promise<void>;
  send(message: object): void;
  close(): Promise<void>;
}

export async function connect(baseUrl: string, path: string, clerkId: string): Promise<TestSocket> {
  // The token travels as a subprotocol, like the browser sends it
  const ws = new WebSocket(`ws://${baseUrl}/api/ws${path}`, ["gambitio", `auth.${clerkId}`]);
  const messages: any[] = [];
  const consumed = new Set<any>();
  const waiters: (() => void)[] = [];
  ws.on("message", (raw) => {
    messages.push(JSON.parse(raw.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const find = (type: string, match?: (m: any) => boolean) =>
    messages.find((m) => !consumed.has(m) && m.type === type && (!match || match(m)));

  return {
    ws,
    messages,
    next(type, match, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for "${type}". Got: ${JSON.stringify(messages)}`)),
          timeoutMs
        );
        const check = () => {
          const found = find(type, match);
          if (found) {
            consumed.add(found);
            clearTimeout(timer);
            resolve(found);
          } else {
            waiters.push(check);
          }
        };
        check();
      });
    },
    async none(type, windowMs = 300) {
      await new Promise((r) => setTimeout(r, windowMs));
      const found = find(type);
      if (found) throw new Error(`Unexpected "${type}": ${JSON.stringify(found)}`);
    },
    send: (message) => ws.send(JSON.stringify(message)),
    close: () =>
      new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}

export const move = (uci: string) => ({
  type: "move",
  move: { from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) },
});
