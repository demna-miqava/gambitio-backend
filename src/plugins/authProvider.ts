import { createPublicKey } from "node:crypto";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { createClerkClient, verifyToken } from "@clerk/backend";

/**
 * How requests are authenticated. The default verifies Clerk session tokens;
 * tests inject a fake so they never call Clerk.
 */
export interface AuthProvider {
  /** Clerk user id for a session token, or null if it's invalid. */
  verifyToken(token: string): Promise<string | null>;
  /** Primary email of a Clerk user, used when creating the profile. */
  getEmail(clerkId: string): Promise<string | null>;
  /** Deletes the Clerk user (account deletion). Must succeed if already gone. */
  deleteUser(clerkId: string): Promise<void>;
}

declare module "fastify" {
  interface FastifyInstance {
    authProvider: AuthProvider;
  }
}

/** Token from `Authorization: Bearer <token>`. */
export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) || null : null;
}

/**
 * The `kid` of a token's header, read without verifying anything, or null if
 * the token can't be a Clerk session token: not three parts, a header that
 * isn't JSON, or an algorithm other than RS256 (the only one Clerk signs
 * session tokens with). Such tokens are rejected before any key is looked up.
 */
export function sessionTokenKid(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = parts[0]!;
  if (!header || header.length > 1024) return null;
  try {
    const { alg, kid } = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as {
      alg?: unknown;
      kid?: unknown;
    };
    if (alg !== "RS256" || typeof kid !== "string" || kid.length === 0 || kid.length > 128) return null;
    return kid;
  } catch {
    return null;
  }
}

/** Clerk's signing keys by kid, as PEM (the form verifyToken's jwtKey takes). */
export type SigningKeyFetcher = () => Promise<Map<string, string>>;

export const signingKeyTimings = {
  /**
   * At most one fetch per this long. A token with an unknown kid is the only
   * thing a stranger can use to make us call Clerk, so this bounds that to
   * one request a minute for the whole process, however many tokens arrive.
   */
  minFetchIntervalMs: 60_000,
  /**
   * After a failed fetch (Clerk unreachable, or no usable key in its
   * answer) the next one may come sooner
   */
  retryAfterFailureMs: 10_000,
  /**
   * Sooner still while no key is known at all (a cold start), since then
   * nobody can sign in. Still one fetch at a time, so forged tokens can't
   * cause more than one fetch per this long.
   */
  coldRetryAfterFailureMs: 2_000,
  /** Keys are refreshed (in the background) once they are this old, as Clerk's own cache does */
  maxAgeMs: 5 * 60_000,
  /** A fetch that hasn't answered by then counts as failed */
  fetchTimeoutMs: 10_000,
};

/**
 * Clerk's public signing keys, fetched from Clerk's API only when needed.
 *
 * Without this, Clerk's verifyToken re-downloads the key set (with retries)
 * whenever a token names a kid it hasn't cached, and it reads the kid before
 * checking any signature: anyone could make the server call Clerk with our
 * secret key on every request just by sending made-up tokens.
 *
 * Here a fetch happens only for a kid not in the last key set, or to refresh
 * a key set older than maxAgeMs, and never more than once per
 * minFetchIntervalMs. Concurrent callers share the fetch in flight (no
 * second request is made); a caller with an unknown kid outside the window
 * is rejected at once, not queued. A fetch learns every key Clerk currently
 * has, not just the asking token's, so after Clerk rotates its keys the new
 * kid is known after the first fetch that follows, which is at most
 * minFetchIntervalMs away whoever triggers it.
 */
export class SigningKeys {
  private keys = new Map<string, string>();
  private fetchedAt = -Infinity;
  private nextFetchAt = -Infinity;
  private inFlight: Promise<void> | null = null;

  constructor(
    private fetchKeys: SigningKeyFetcher,
    private log?: Pick<FastifyBaseLogger, "error">,
    private now: () => number = Date.now
  ) {}

  /** The PEM for a kid, or null if Clerk doesn't have (or we can't learn) that key. */
  async keyFor(kid: string): Promise<string | null> {
    const known = this.keys.get(kid);
    if (known !== undefined) {
      // Stale keys keep working while a refresh runs, so a refresh (or a
      // failing one, if Clerk is down) never delays sign-ins
      if (this.now() - this.fetchedAt >= signingKeyTimings.maxAgeMs) void this.refresh();
      return known;
    }
    if (this.inFlight) await this.inFlight;
    else if (this.now() >= this.nextFetchAt) await this.refresh();
    else return null;
    return this.keys.get(kid) ?? null;
  }

  /** Starts a fetch unless one is running or the last one was too recent. */
  private refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.now() < this.nextFetchAt) return Promise.resolve();
    const startedAt = this.now();
    this.nextFetchAt = startedAt + signingKeyTimings.minFetchIntervalMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Fetching Clerk's signing keys timed out")), signingKeyTimings.fetchTimeoutMs);
      timer.unref();
    });
    this.inFlight = Promise.race([this.fetchKeys(), timeout])
      .then((keys) => {
        // An empty set would sign everyone out until the next fetch: keep
        // the old keys, as for any other failure
        if (keys.size === 0) throw new Error("Clerk's key set had no usable signing key");
        this.keys = keys;
        this.fetchedAt = startedAt;
      })
      .catch((err) => {
        // Old keys stay in use; the next attempt may come a little sooner,
        // and sooner still if there are none
        const retry = this.keys.size === 0
          ? signingKeyTimings.coldRetryAfterFailureMs
          : signingKeyTimings.retryAfterFailureMs;
        this.nextFetchAt = Math.min(this.nextFetchAt, this.now() + retry);
        this.log?.error({ err }, "Fetching Clerk's signing keys failed");
      })
      .finally(() => {
        clearTimeout(timer);
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

/** A key as Clerk's JWKS endpoint lists it. */
export interface JwksKey {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

/**
 * The RSA signing keys of a JWKS, as PEM by kid. Clerk's PEM loader only
 * handles 2048-bit RSA keys with exponent 65537 (what Clerk issues), so
 * other keys are skipped rather than mis-read.
 */
export function signingKeysFromJwks(keys: JwksKey[]): Map<string, string> {
  const pems = new Map<string, string>();
  for (const jwk of keys) {
    if (!jwk.kid || jwk.kty !== "RSA" || !jwk.n || !jwk.e) continue;
    if ((jwk.alg && jwk.alg !== "RS256") || (jwk.use && jwk.use !== "sig")) continue;
    try {
      const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
      const details = key.asymmetricKeyDetails;
      if (details?.modulusLength !== 2048 || details.publicExponent !== 65537n) continue;
      pems.set(jwk.kid, key.export({ type: "spki", format: "pem" }).toString());
    } catch {
      // Not a usable key
    }
  }
  return pems;
}

/** Downloads Clerk's signing keys (GET /v1/jwks, with the secret key). */
export function clerkSigningKeyFetcher(secretKey: string): SigningKeyFetcher {
  const clerk = createClerkClient({ secretKey });
  return async () => signingKeysFromJwks((await clerk.jwks.getJwks()).keys ?? []);
}

/**
 * Verifies Clerk session tokens (REST bearer tokens and WebSocket tokens
 * alike). `isAuthorizedParty` rejects tokens minted for other origins: like
 * Clerk's own `authorizedParties` option, it requires the `azp` claim (the
 * origin the browser asked for the token from) and rejects a token without
 * one, but can match origins by rule rather than from a fixed list.
 *
 * Verification itself is always Clerk's verifyToken with a local key
 * (`jwtKey`), so it never makes a network request: the key is CLERK_JWT_KEY
 * when set, otherwise the one SigningKeys holds for the token's kid.
 */
export function clerkAuthProvider(options: {
  secretKey: string;
  /** PEM public key (CLERK_JWT_KEY); without it keys come from Clerk's API */
  jwtKey?: string | undefined;
  isAuthorizedParty: (origin: string) => boolean;
  log?: Pick<FastifyBaseLogger, "error">;
  /** Replaces the JWKS download (tests) */
  fetchKeys?: SigningKeyFetcher;
}): AuthProvider {
  const { secretKey, jwtKey, isAuthorizedParty } = options;
  const clerk = createClerkClient({ secretKey });
  const signingKeys = jwtKey
    ? null
    : new SigningKeys(options.fetchKeys ?? clerkSigningKeyFetcher(secretKey), options.log);
  return {
    verifyToken: async (token) => {
      try {
        let key = jwtKey;
        if (!key) {
          const kid = sessionTokenKid(token);
          if (!kid) return null;
          key = (await signingKeys!.keyFor(kid)) ?? undefined;
          if (!key) return null;
        }
        const payload = await verifyToken(token, { jwtKey: key });
        if (typeof payload.azp !== "string" || !isAuthorizedParty(payload.azp)) return null;
        return payload.sub ?? null;
      } catch {
        return null;
      }
    },
    getEmail: async (clerkId) => {
      const user = await clerk.users.getUser(clerkId);
      return (
        user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ?? null
      );
    },
    deleteUser: async (clerkId) => {
      try {
        await clerk.users.deleteUser(clerkId);
      } catch (error) {
        // Already deleted (a retry after a partial failure) counts as done
        if ((error as { status?: number }).status === 404) return;
        throw error;
      }
    },
  };
}
