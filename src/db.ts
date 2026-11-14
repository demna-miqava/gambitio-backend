import type { PoolClient, QueryResultRow } from "pg";

/** Anything that can run a query: the pool or a transaction client. */
export interface Queryable {
  query<R extends QueryResultRow = any>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export type TxClient = PoolClient;

export const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/** A Postgres duration setting ("5s", "5000ms", "1min", "0") in milliseconds, or null if unreadable. */
export function parsePgDuration(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?$/.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = { us: 0.001, ms: 1, s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1;
  return Math.round(n * factor);
}

/**
 * The pool asks for statement_timeout and idle_in_transaction_session_timeout
 * as connection settings. A connection pooler in transaction mode (Neon's,
 * PgBouncer) may drop those, leaving runaway queries unbounded. This checks
 * what a session really has and, if it differs, stores the values as the
 * role's defaults instead, which every later session gets whatever opened it.
 */
export async function ensureSessionTimeouts(
  db: Queryable,
  wanted: { statement_timeout: number; idle_in_transaction_session_timeout: number },
  log: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void }
): Promise<void> {
  const missing: string[] = [];
  for (const [name, ms] of Object.entries(wanted)) {
    const { rows } = await db.query<Record<string, string>>(`SHOW ${name}`);
    const actual = parsePgDuration(rows[0]?.[name] ?? "");
    if (actual !== ms) missing.push(name);
  }
  if (missing.length === 0) return;
  log.warn({ missing }, "Connection settings were not applied (a pooler?); setting role defaults");
  for (const name of missing) {
    // Values are validated integers from the config; settings can't be bound as parameters
    const ms = Math.floor(wanted[name as keyof typeof wanted]);
    await db.query(`ALTER ROLE CURRENT_USER SET ${name} = '${ms}ms'`);
  }
  log.info({ missing }, "Role defaults set; new sessions will have them");
}
