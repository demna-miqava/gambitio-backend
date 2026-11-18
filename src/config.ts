import { createPublicKey } from "node:crypto";
import { z } from "zod";

// An empty value (KEY= in a .env file) counts as not set
const optionalText = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

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
  // The instance's "JWT public key" (PEM) from the Clerk dashboard (API keys
  // page). With it, session tokens are verified locally and never cause a
  // request to Clerk; without it the signing keys are fetched from Clerk's
  // API (rate-guarded, see clerkAuthProvider). See clerkJwtKey for the format.
  CLERK_JWT_KEY: optionalText.transform((value, ctx) => {
    if (value === undefined) return undefined;
    const pem = clerkJwtKey(value);
    if (!pem) {
      ctx.addIssue({
        code: "custom",
        message:
          "must be the PEM public key from the Clerk dashboard (-----BEGIN PUBLIC KEY----- ... -----END PUBLIC KEY-----, RSA 2048)",
      });
      return z.NEVER;
    }
    return pem;
  }).optional(),
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
  // Web push (notifications when the tab is in the background or closed).
  // Both keys or neither: without them push is simply off. Make a pair with
  // `npm run generate-vapid-keys`. The subject is how a push service can
  // reach the site's owner: a mailto: or https: address (default: FRONTEND_URL).
  VAPID_PUBLIC_KEY: optionalText.optional(),
  VAPID_PRIVATE_KEY: optionalText.optional(),
  VAPID_SUBJECT: optionalText
    .pipe(
      z
        .string()
        .regex(/^(mailto:|https:\/\/)/, "must start with mailto: or https://")
        .optional()
    )
    .optional(),
});

export type Config = z.infer<typeof envSchema>;

const PEM_HEADER = "-----BEGIN PUBLIC KEY-----";
const PEM_TRAILER = "-----END PUBLIC KEY-----";

/**
 * The Clerk JWT public key as a clean PEM, or null if it isn't one Clerk can
 * use. Secret stores often keep a multi-line value as one line with literal
 * "\n" escapes (or with spaces where the line breaks were), so the body is
 * rebuilt from its base64 characters. Clerk turns the PEM into a key by
 * cutting a fixed prefix off it (loadClerkJwkFromPem in @clerk/backend),
 * which only works for a 2048-bit RSA key with exponent 65537: anything else
 * is rejected here rather than failing every sign-in later.
 */
export function clerkJwtKey(raw: string): string | null {
  const text = raw.replace(/\\r/g, "").replace(/\\n/g, "\n").trim();
  if (!text.startsWith(PEM_HEADER) || !text.endsWith(PEM_TRAILER)) return null;
  const body = text.slice(PEM_HEADER.length, -PEM_TRAILER.length).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const pem = `${PEM_HEADER}\n${body.match(/.{1,64}/g)!.join("\n")}\n${PEM_TRAILER}`;
  try {
    const key = createPublicKey(pem);
    const details = key.asymmetricKeyDetails;
    if (key.asymmetricKeyType !== "rsa" || details?.modulusLength !== 2048 || details.publicExponent !== 65537n) {
      return null;
    }
  } catch {
    return null;
  }
  return pem;
}

/** The VAPID keys push messages are signed with, or null when push isn't configured. */
export function vapidKeys(config: Config): { subject: string; publicKey: string; privateKey: string } | null {
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) return null;
  return {
    subject: config.VAPID_SUBJECT ?? config.FRONTEND_URL,
    publicKey: config.VAPID_PUBLIC_KEY,
    privateKey: config.VAPID_PRIVATE_KEY,
  };
}

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
  if (Boolean(result.data.VAPID_PUBLIC_KEY) !== Boolean(result.data.VAPID_PRIVATE_KEY)) {
    throw new Error(
      "Invalid environment configuration:\n  VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY: set both or neither"
    );
  }
  if (result.data.NODE_ENV === "production" && result.data.ALLOW_LAN_ORIGINS) {
    throw new Error("Invalid environment configuration:\n  ALLOW_LAN_ORIGINS: not allowed in production");
  }
  return result.data;
}
