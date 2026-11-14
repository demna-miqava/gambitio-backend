import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  POSTGRES_CONNECTION_STRING: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  // Postgres pool. Neon's pooled endpoint takes many more connections than
  // this; the limit protects the database and this small container.
  PG_POOL_MAX: z.coerce.number().int().positive().default(15),
  // Longest any one statement may run. A slow query fails instead of holding
  // a pool connection (and, in a transaction, a game's row lock) for ages.
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  // Comma-separated origins also allowed besides FRONTEND_URL, e.g. the LAN
  // address used to open the dev server from a phone
  EXTRA_FRONTEND_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.string().url()))
    .optional(),
  // "true" also allows any origin on a private network (192.168.x.x, 10.x.x.x,
  // 172.16-31.x.x, *.local): for opening the dev server from a phone when
  // the Mac's IP keeps changing. Never set in production.
  ALLOW_LAN_ORIGINS: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1")
    .optional(),
});

export type Config = z.infer<typeof envSchema>;

/** Every frontend origin allowed to call the API and mint session tokens for it. */
export function allowedOrigins(config: Config): string[] {
  return [config.FRONTEND_URL, ...(config.EXTRA_FRONTEND_ORIGINS ?? [])];
}

/** An http(s) origin whose host is a private-network IPv4 address or a *.local name. */
export function isLanOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname;
  if (host.endsWith(".local")) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** Whether a frontend origin may call the API and have its session tokens accepted. */
export function originChecker(config: Config): (origin: string) => boolean {
  const listed = new Set(allowedOrigins(config));
  // Never in production, even if loadConfig was bypassed
  const allowLan = config.ALLOW_LAN_ORIGINS === true && config.NODE_ENV !== "production";
  return (origin) => listed.has(origin) || (allowLan && isLanOrigin(origin));
}

/**
 * Validates environment variables once at startup so a missing secret fails
 * fast instead of on the first request that needs it.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  if (result.data.NODE_ENV === "production" && result.data.ALLOW_LAN_ORIGINS) {
    throw new Error("Invalid environment configuration:\n  ALLOW_LAN_ORIGINS: not allowed in production");
  }
  return result.data;
}
