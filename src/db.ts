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
