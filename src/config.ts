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
});

export type Config = z.infer<typeof envSchema>;

/** Every frontend origin allowed to call the API and mint session tokens for it. */
export function allowedOrigins(config: Config): string[] {
  return [config.FRONTEND_URL, ...(config.EXTRA_FRONTEND_ORIGINS ?? [])];
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
  return result.data;
}
