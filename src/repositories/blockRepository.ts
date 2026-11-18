import type { Queryable } from "../db.js";

/**
 * Whether either of two players has blocked the other. `byFirst`: `first`
 * blocked `second`; `bySecond`: the other way round.
 */
export async function blocksBetween(
  db: Queryable,
  first: number,
  second: number
): Promise<{ byFirst: boolean; bySecond: boolean }> {
  const { rows } = await db.query<{ blockerId: number }>(
    `SELECT "blockerId" FROM user_blocks
     WHERE ("blockerId" = $1 AND "blockedId" = $2) OR ("blockerId" = $2 AND "blockedId" = $1)`,
    [first, second]
  );
  return {
    byFirst: rows.some((r) => r.blockerId === first),
    bySecond: rows.some((r) => r.blockerId === second),
  };
}

/**
 * SQL condition: no block in either direction between the two user id
 * expressions. Both must be trusted SQL (a column or a `$n` placeholder).
 */
export const notBlockedSql = (a: string, b: string) => `NOT EXISTS (
    SELECT 1 FROM user_blocks ub
    WHERE (ub."blockerId" = ${a} AND ub."blockedId" = ${b})
       OR (ub."blockerId" = ${b} AND ub."blockedId" = ${a}))`;
