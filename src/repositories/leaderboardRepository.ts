import type { FastifyInstance } from "fastify";
import {
  LEADERBOARD_VARIANTS,
  type LeaderboardRow,
  type LeaderboardScope,
  type LeaderboardVariant,
} from "../models/Leaderboard.js";

interface Scope {
  scope: LeaderboardScope;
  /** The signed-in user; the friends scope is their friends plus themself */
  userId: number;
}

/** Collects query values and hands out their $n placeholders. */
class Params {
  values: unknown[] = [];
  add(value: unknown) {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * Leaderboard queries. Values are always parameterized; the only interpolated
 * SQL is column names from LEADERBOARD_VARIANTS.
 *
 * Eligibility: at least one rated (finished, non-aborted) game in the variant
 * and not a deleted account. The filter matches the partial indexes in
 * migration 010, so pages and counts are index scans over listed players.
 */
export class LeaderboardRepository {
  constructor(private fastify: FastifyInstance) {}

  /** WHERE clause for listed players in scope, on table alias `alias`. */
  private where(variant: LeaderboardVariant, { scope, userId }: Scope, alias: string, params: Params) {
    const { games } = LEADERBOARD_VARIANTS[variant];
    const eligible = `${alias}."${games}" > 0 AND ${alias}."clerkId" IS NOT NULL`;
    if (scope === "global") return eligible;
    const me = params.add(userId);
    return `${eligible} AND ${alias}.id IN (
      SELECT ${me}::int
      UNION SELECT "userTwoId" FROM friends WHERE "userOneId" = ${me}
      UNION SELECT "userOneId" FROM friends WHERE "userTwoId" = ${me})`;
  }

  private select(variant: LeaderboardVariant, alias: string) {
    const { rating, highest, games } = LEADERBOARD_VARIANTS[variant];
    // The peak can't be below the current rating (rows written before
    // finishGame kept the peak up to date had it lower; see migration 013)
    return `${alias}.id, ${alias}.username, ${alias}."avatarUrl", ${alias}."${rating}" AS rating,
      GREATEST(${alias}."${highest}", ${alias}."${rating}") AS "highestRating",
      ${alias}."${games}" AS "gamesPlayed"`;
  }

  /** One page, ordered by rating DESC then id ASC (stable order within ties). */
  async findPage(variant: LeaderboardVariant, scope: Scope, limit: number, offset: number) {
    const { rating } = LEADERBOARD_VARIANTS[variant];
    const params = new Params();
    const where = this.where(variant, scope, "u", params);
    const { rows } = await this.fastify.pg.query<LeaderboardRow>(
      `SELECT ${this.select(variant, "u")}
       FROM users u
       WHERE ${where}
       ORDER BY u."${rating}" DESC, u.id
       LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}`,
      params.values
    );
    return rows;
  }

  /** Listed players in scope, optionally only those rated strictly above `above`. */
  async count(variant: LeaderboardVariant, scope: Scope, above?: number) {
    const { rating } = LEADERBOARD_VARIANTS[variant];
    const params = new Params();
    let where = this.where(variant, scope, "u", params);
    if (above !== undefined) where += ` AND u."${rating}" > ${params.add(above)}`;
    const { rows } = await this.fastify.pg.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM users u WHERE ${where}`,
      params.values
    );
    return Number(rows[0]!.n);
  }

  /**
   * The user's own row with the number of listed players ranked above them
   * (higher rating) and tied ahead of them (same rating, lower id), or null
   * when they aren't listed.
   */
  async findPosition(variant: LeaderboardVariant, scope: Scope) {
    const { rating, games } = LEADERBOARD_VARIANTS[variant];
    const params = new Params();
    const others = this.where(variant, scope, "o", params);
    const me = params.add(scope.userId);
    const { rows } = await this.fastify.pg.query<LeaderboardRow & { above: string; tiedAhead: string }>(
      `SELECT ${this.select(variant, "u")},
         (SELECT COUNT(*) FROM users o WHERE ${others} AND o."${rating}" > u."${rating}") AS above,
         (SELECT COUNT(*) FROM users o
          WHERE ${others} AND o."${rating}" = u."${rating}" AND o.id < u.id) AS "tiedAhead"
       FROM users u
       WHERE u.id = ${me} AND u."${games}" > 0 AND u."clerkId" IS NOT NULL`,
      params.values
    );
    const row = rows[0];
    if (!row) return null;
    const { above, tiedAhead, ...entry } = row;
    return { entry, above: Number(above), tiedAhead: Number(tiedAhead) };
  }
}
