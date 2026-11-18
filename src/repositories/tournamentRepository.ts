import type { Queryable } from "../db.js";
import type {
  Standing,
  Tournament,
  TournamentLiveGame,
  TournamentPlayer,
  TournamentPlayerStatus,
  TournamentStatus,
  TournamentSummary,
} from "../models/Tournament.js";
import { getTimeControl, ratingColumns } from "../models/common.js";
import { provisionalSql } from "../utils/glicko2.js";
import type { ScoredGame } from "../game/arena.js";

const TOURNAMENT_COLUMNS = `id, "createdAt", "createdBy", name, format, time, increment, rated,
  "startsAt", "endsAt", status, "maxPlayers", "playerCount", "startedAt", "finishedAt", "winnerId"`;

const PLAYER_COLUMNS = `"tournamentId", "userId", "joinedAt", status, score, streak, games, wins, draws,
  "opponentRatingSum", performance, sheet, whites, "lastOpponentId", "waitingSince"`;

/** Digits of the score sheet a standings line carries */
const SHEET_SHOWN = 20;

/**
 * Who is in the standings: everyone who hasn't withdrawn, and anyone who
 * has but played first (their opponents' points came from those games).
 * Must match the WHERE of tournament_standings_idx (migration 034).
 */
const LISTED = (alias: string) => `(${alias}.status <> 'withdrawn' OR ${alias}.games > 0)`;

type SummaryRow = Tournament & { creatorName: string; winnerName: string | null };

/** TOURNAMENT_COLUMNS as columns of `t` */
const T_COLUMNS = TOURNAMENT_COLUMNS.split(",")
  .map((column) => `t.${column.trim()}`)
  .join(", ");

/** A summary's SELECT; `extra` adds columns (each starting with a comma). */
const summarySelect = (extra = "") => `SELECT ${T_COLUMNS},
  c.username AS "creatorName", w.username AS "winnerName"${extra}
  FROM tournaments t
  JOIN users c ON c.id = t."createdBy"
  LEFT JOIN users w ON w.id = t."winnerId"`;

export function toTournamentSummary(row: SummaryRow): TournamentSummary {
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    time: row.time,
    increment: row.increment,
    type: getTimeControl(row.time),
    rated: row.rated,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
    maxPlayers: row.maxPlayers,
    playerCount: row.playerCount,
    createdBy: { id: row.createdBy, username: row.creatorName },
    winner: row.winnerId !== null && row.winnerName !== null ? { id: row.winnerId, username: row.winnerName } : null,
  };
}

type StandingRow = Omit<Standing, "rank">;

/**
 * The standings' SELECT for a tournament with this clock (the rating shown
 * is that time control's); `extra` adds columns (each starting with a
 * comma). The rating columns are only in `users`, so they need no alias.
 */
function standingSelect(time: number, extra = ""): string {
  const columns = ratingColumns(getTimeControl(time));
  return `SELECT p."userId", u.username, u."avatarUrl", u."${columns.rating}" AS rating,
      ${provisionalSql(columns)} AS provisional,
      p.score, p.streak, p.games, p.wins, p.draws, p.performance,
      right(p.sheet, ${SHEET_SHOWN}) AS sheet, p.status${extra}
    FROM tournament_players p JOIN users u ON u.id = p."userId"`;
}

export interface NewTournament {
  createdBy: number;
  name: string;
  time: number;
  increment: number;
  rated: boolean;
  startsAt: Date;
  endsAt: Date;
  maxPlayers: number;
}

/**
 * Data access for tournaments. Every method takes the connection to use, so
 * callers decide whether it runs inside a transaction.
 */
export const tournamentRepository = {
  async insert(db: Queryable, tournament: NewTournament): Promise<Tournament> {
    const { rows } = await db.query<Tournament>(
      `INSERT INTO tournaments ("createdBy", name, time, increment, rated, "startsAt", "endsAt", "maxPlayers")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${TOURNAMENT_COLUMNS}`,
      [
        tournament.createdBy,
        tournament.name,
        tournament.time,
        tournament.increment,
        tournament.rated,
        tournament.startsAt,
        tournament.endsAt,
        tournament.maxPlayers,
      ]
    );
    return rows[0]!;
  },

  async find(db: Queryable, id: number): Promise<Tournament | null> {
    const { rows } = await db.query<Tournament>(`SELECT ${TOURNAMENT_COLUMNS} FROM tournaments WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async summary(db: Queryable, id: number): Promise<TournamentSummary | null> {
    const { rows } = await db.query<SummaryRow>(`${summarySelect()} WHERE t.id = $1`, [id]);
    return rows[0] ? toTournamentSummary(rows[0]) : null;
  },

  /**
   * Locks the tournament for the rest of the transaction (joining,
   * cancelling: they wait their turn).
   *
   * FOR NO KEY UPDATE, here and in tryLock, not FOR UPDATE: a game row
   * points at its tournament, and Postgres checks that foreign key again
   * (locking the tournament's row FOR KEY SHARE) when a game row written
   * earlier in a transaction is updated once more, as the end of a game does
   * after a checkmating move or when it makes the game unrated. That happens
   * while the players' tournament rows are held. FOR UPDATE would make it
   * wait for whoever holds the tournament, and a player joining or leaving
   * as their game ends holds it while waiting for their own row: a
   * deadlock. The two modes don't conflict, so the end of a game never
   * waits for the tournament's row (and never makes a pairing pass skip).
   */
  async lock(tx: Queryable, id: number): Promise<Tournament | null> {
    const { rows } = await tx.query<Tournament>(
      `SELECT ${TOURNAMENT_COLUMNS} FROM tournaments WHERE id = $1 FOR NO KEY UPDATE`,
      [id]
    );
    return rows[0] ?? null;
  },

  /**
   * Locks the tournament unless someone else holds it: null then, as for a
   * tournament that doesn't exist. For the tick (start, pair, finish), which
   * every instance runs: whoever gets the row does the work, the others skip.
   */
  async tryLock(tx: Queryable, id: number): Promise<Tournament | null> {
    const { rows } = await tx.query<Tournament>(
      `SELECT ${TOURNAMENT_COLUMNS} FROM tournaments WHERE id = $1 FOR NO KEY UPDATE SKIP LOCKED`,
      [id]
    );
    return rows[0] ?? null;
  },

  /** Tournaments the tick has work for at `now`: running ones, and scheduled ones whose start has come. */
  async findDue(db: Queryable, now: Date, limit: number): Promise<Tournament[]> {
    const { rows } = await db.query<Tournament>(
      `SELECT ${TOURNAMENT_COLUMNS} FROM tournaments
       WHERE status = 'running' OR (status = 'scheduled' AND "startsAt" <= $1)
       ORDER BY "startsAt" LIMIT $2`,
      [now, limit]
    );
    return rows;
  },

  /** Every tournament that is on or still to come, soonest first. */
  async findOpen(db: Queryable, limit: number): Promise<Tournament[]> {
    const { rows } = await db.query<Tournament>(
      `SELECT ${TOURNAMENT_COLUMNS} FROM tournaments
       WHERE status IN ('scheduled', 'running') ORDER BY "startsAt" LIMIT $1`,
      [limit]
    );
    return rows;
  },

  async setStatus(
    tx: Queryable,
    id: number,
    status: TournamentStatus,
    at: Date,
    winnerId: number | null = null
  ): Promise<void> {
    await tx.query(
      `UPDATE tournaments SET status = $2,
         "startedAt" = CASE WHEN $2 = 'running' THEN $3::timestamptz ELSE "startedAt" END,
         "finishedAt" = CASE WHEN $2 IN ('finished', 'cancelled') THEN $3::timestamptz ELSE "finishedAt" END,
         "winnerId" = $4
       WHERE id = $1`,
      [id, status, at, winnerId]
    );
  },

  /**
   * A page of the list. "open": what is running, then what is coming up,
   * soonest first. "finished": the latest first (cancelled ones aren't
   * listed). `joined` says whether the viewer is in each.
   */
  async list(
    db: Queryable,
    filter: "open" | "finished",
    viewerId: number,
    limit: number,
    offset: number
  ): Promise<{ data: (TournamentSummary & { joined: boolean })[]; total: number }> {
    const where = filter === "open" ? `t.status IN ('scheduled', 'running')` : `t.status = 'finished'`;
    const order =
      filter === "open" ? `(t.status = 'running') DESC, t."startsAt", t.id` : `t."endsAt" DESC, t.id DESC`;
    const [{ rows }, { rows: count }] = await Promise.all([
      db.query<SummaryRow & { joined: boolean }>(
        `${summarySelect(`, EXISTS (
             SELECT 1 FROM tournament_players p
             WHERE p."tournamentId" = t.id AND p."userId" = $1 AND p.status <> 'withdrawn') AS joined`)}
         WHERE ${where} ORDER BY ${order} LIMIT $2 OFFSET $3`,
        [viewerId, limit, offset]
      ),
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tournaments t WHERE ${where}`),
    ]);
    return {
      data: rows.map((row) => ({ ...toTournamentSummary(row), joined: row.joined })),
      total: count[0]!.n,
    };
  },

  async findPlayer(db: Queryable, tournamentId: number, userId: number): Promise<TournamentPlayer | null> {
    const { rows } = await db.query<TournamentPlayer>(
      `SELECT ${PLAYER_COLUMNS} FROM tournament_players WHERE "tournamentId" = $1 AND "userId" = $2`,
      [tournamentId, userId]
    );
    return rows[0] ?? null;
  },

  /**
   * Adds a player, or brings back one who withdrew (their score is kept).
   * `waitingSince`: when they start waiting for a game (a running
   * tournament), or null. Returns whether the player count went up.
   */
  async join(tx: Queryable, tournamentId: number, userId: number, waitingSince: Date | null): Promise<boolean> {
    const { rows } = await tx.query<{ status: TournamentPlayerStatus }>(
      `SELECT status FROM tournament_players WHERE "tournamentId" = $1 AND "userId" = $2 FOR UPDATE`,
      [tournamentId, userId]
    );
    const before = rows[0]?.status;
    await tx.query(
      `INSERT INTO tournament_players ("tournamentId", "userId", "waitingSince") VALUES ($1, $2, $3)
       ON CONFLICT ("tournamentId", "userId") DO UPDATE SET status = 'active', "waitingSince" = $3`,
      [tournamentId, userId, waitingSince]
    );
    const counted = before === undefined || before === "withdrawn";
    if (counted) await this.addToCount(tx, tournamentId, 1);
    return counted;
  },

  /**
   * Whether the user still has an account, holding it until the transaction
   * ends: an account deletion's last step (which clears the Clerk id under
   * the row's lock) waits for this transaction, and one that got there first
   * makes this say no. So whoever joins either commits before the account
   * is gone, where the deletion's last sweep finds their row, or is refused.
   * Taken after the tournament's and the player's rows, the order every
   * other path takes the user's row in.
   */
  async holdAccount(tx: Queryable, userId: number): Promise<boolean> {
    const { rows } = await tx.query(
      `SELECT 1 FROM users WHERE id = $1 AND "clerkId" IS NOT NULL FOR KEY SHARE`,
      [userId]
    );
    return rows.length > 0;
  },

  async addToCount(tx: Queryable, tournamentId: number, delta: number): Promise<void> {
    await tx.query(`UPDATE tournaments SET "playerCount" = GREATEST(0, "playerCount" + $2) WHERE id = $1`, [
      tournamentId,
      delta,
    ]);
  },

  /** Changes a player's own state; `waitingSince` null takes them out of the pairing queue. */
  async setPlayerStatus(
    tx: Queryable,
    tournamentId: number,
    userId: number,
    status: TournamentPlayerStatus,
    waitingSince: Date | null
  ): Promise<void> {
    await tx.query(
      `UPDATE tournament_players SET status = $3, "waitingSince" = $4 WHERE "tournamentId" = $1 AND "userId" = $2`,
      [tournamentId, userId, status, waitingSince]
    );
  },

  /** Removes a player who never played (they left before the start). */
  async removePlayer(tx: Queryable, tournamentId: number, userId: number): Promise<void> {
    await tx.query(`DELETE FROM tournament_players WHERE "tournamentId" = $1 AND "userId" = $2`, [
      tournamentId,
      userId,
    ]);
  },

  async countActive(db: Queryable, tournamentId: number): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tournament_players WHERE "tournamentId" = $1 AND status = 'active'`,
      [tournamentId]
    );
    return rows[0]!.n;
  },

  /** The start: everyone who is in starts waiting for a game. */
  async queueActive(tx: Queryable, tournamentId: number, at: Date): Promise<void> {
    await tx.query(
      `UPDATE tournament_players SET "waitingSince" = $2 WHERE "tournamentId" = $1 AND status = 'active'`,
      [tournamentId, at]
    );
  },

  /** The end: nobody is waiting any more. */
  async clearQueue(tx: Queryable, tournamentId: number): Promise<void> {
    await tx.query(
      `UPDATE tournament_players SET "waitingSince" = NULL
       WHERE "tournamentId" = $1 AND "waitingSince" IS NOT NULL`,
      [tournamentId]
    );
  },

  /**
   * Locks and reads the players waiting for a game at `now`, in user id
   * order (the order the end of a game locks two of them in). Someone whose
   * wait starts later (they just finished a game: see
   * tournamentTimings.requeueDelayMs) isn't waiting yet. A row someone else
   * holds (a game of theirs ending right now) is skipped: next pass.
   */
  async lockWaiting(tx: Queryable, tournamentId: number, now: Date, limit: number): Promise<TournamentPlayer[]> {
    const { rows } = await tx.query<TournamentPlayer>(
      `SELECT ${PLAYER_COLUMNS} FROM tournament_players
       WHERE "tournamentId" = $1 AND "waitingSince" <= $2 AND status = 'active'
       ORDER BY "userId" LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [tournamentId, now, limit]
    );
    return rows;
  },

  /** The players who are in (not paused, not gone), for the "it has started" notification. */
  async activePlayerIds(db: Queryable, tournamentId: number, limit: number): Promise<number[]> {
    const { rows } = await db.query<{ userId: number }>(
      `SELECT "userId" FROM tournament_players WHERE "tournamentId" = $1 AND status = 'active'
       ORDER BY "joinedAt" LIMIT $2`,
      [tournamentId, limit]
    );
    return rows.map((r) => r.userId);
  },

  /** Pairs with a block between them, among these users, as "low:high" id pairs. */
  async blockedPairs(db: Queryable, userIds: number[]): Promise<Set<string>> {
    const { rows } = await db.query<{ blockerId: number; blockedId: number }>(
      `SELECT "blockerId", "blockedId" FROM user_blocks WHERE "blockerId" = ANY($1) AND "blockedId" = ANY($1)`,
      [userIds]
    );
    return new Set(rows.map((r) => pairKey(r.blockerId, r.blockedId)));
  },

  /** The two players of a new game leave the queue; white's count goes up. */
  async markPaired(tx: Queryable, tournamentId: number, whiteId: number, blackId: number): Promise<void> {
    await tx.query(
      `UPDATE tournament_players SET "waitingSince" = NULL,
         whites = whites + CASE WHEN "userId" = $2 THEN 1 ELSE 0 END,
         "lastOpponentId" = CASE WHEN "userId" = $2 THEN $3::int ELSE $2::int END
       WHERE "tournamentId" = $1 AND "userId" IN ($2, $3)`,
      [tournamentId, whiteId, blackId]
    );
  },

  /** Locks the two players' rows of a game that is ending, in user id order. */
  async lockPlayers(tx: Queryable, tournamentId: number, userIds: number[]): Promise<TournamentPlayer[]> {
    const { rows } = await tx.query<TournamentPlayer>(
      `SELECT ${PLAYER_COLUMNS} FROM tournament_players
       WHERE "tournamentId" = $1 AND "userId" = ANY($2) ORDER BY "userId" FOR UPDATE`,
      [tournamentId, userIds]
    );
    return rows;
  },

  /** Writes a finished game onto a player's row. */
  async saveGame(
    tx: Queryable,
    tournamentId: number,
    userId: number,
    scored: ScoredGame | null,
    next: { status: TournamentPlayerStatus; waitingSince: Date | null }
  ): Promise<void> {
    if (!scored) {
      await this.setPlayerStatus(tx, tournamentId, userId, next.status, next.waitingSince);
      return;
    }
    await tx.query(
      `UPDATE tournament_players SET score = $3, streak = $4, games = $5, wins = $6, draws = $7,
         "opponentRatingSum" = $8, performance = $9, sheet = $10, status = $11, "waitingSince" = $12
       WHERE "tournamentId" = $1 AND "userId" = $2`,
      [
        tournamentId,
        userId,
        scored.score,
        scored.streak,
        scored.games,
        scored.wins,
        scored.draws,
        scored.opponentRatingSum,
        scored.performance,
        scored.sheet,
        next.status,
        next.waitingSince,
      ]
    );
  },

  async hasGameInProgress(db: Queryable, tournamentId: number): Promise<boolean> {
    const { rows } = await db.query(
      `SELECT 1 FROM games WHERE "tournamentId" = $1 AND status = 'in_progress' LIMIT 1`,
      [tournamentId]
    );
    return rows.length > 0;
  },

  async liveGames(db: Queryable, tournamentId: number, limit: number): Promise<TournamentLiveGame[]> {
    const { rows } = await db.query<{
      id: number;
      whiteId: number;
      blackId: number;
      whiteUsername: string;
      blackUsername: string;
    }>(
      `SELECT id, "whiteId", "blackId", "whiteUsername", "blackUsername" FROM games
       WHERE "tournamentId" = $1 AND status = 'in_progress'
       ORDER BY ("whiteRating" + "blackRating") DESC, id LIMIT $2`,
      [tournamentId, limit]
    );
    return rows.map((g) => ({
      id: g.id,
      white: { id: g.whiteId, username: g.whiteUsername },
      black: { id: g.blackId, username: g.blackUsername },
    }));
  },

  /** The viewer's game in progress in this tournament, if any. */
  async liveGameOf(db: Queryable, tournamentId: number, userId: number): Promise<number | null> {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM games
       WHERE "tournamentId" = $1 AND status = 'in_progress' AND ("whiteId" = $2 OR "blackId" = $2) LIMIT 1`,
      [tournamentId, userId]
    );
    return rows[0]?.id ?? null;
  },

  /** A page of the standings, best first. */
  async standings(
    db: Queryable,
    tournament: Pick<Tournament, "id" | "time">,
    limit: number,
    offset: number
  ): Promise<Standing[]> {
    const { rows } = await db.query<StandingRow>(
      `${standingSelect(tournament.time)}
       WHERE p."tournamentId" = $1 AND ${LISTED("p")}
       ORDER BY p.score DESC, p.performance DESC, p."userId" LIMIT $2 OFFSET $3`,
      [tournament.id, limit, offset]
    );
    return rows.map((row, index) => ({ ...row, rank: offset + index + 1 }));
  },

  async countListed(db: Queryable, tournamentId: number): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tournament_players p WHERE p."tournamentId" = $1 AND ${LISTED("p")}`,
      [tournamentId]
    );
    return rows[0]!.n;
  },

  /** One player's line with their place, or null if they aren't in the tournament. */
  async standingOf(
    db: Queryable,
    tournament: Pick<Tournament, "id" | "time">,
    userId: number
  ): Promise<Standing | null> {
    const { rows } = await db.query<StandingRow & { rank: number }>(
      `${standingSelect(
        tournament.time,
        `, (SELECT count(*)::int + 1 FROM tournament_players o
           WHERE o."tournamentId" = p."tournamentId" AND ${LISTED("o")}
             AND (o.score, o.performance, -o."userId") > (p.score, p.performance, -p."userId")) AS rank`
      )}
       WHERE p."tournamentId" = $1 AND p."userId" = $2`,
      [tournament.id, userId]
    );
    return rows[0] ?? null;
  },

  /**
   * Locks every open tournament a user created or is in, in id order: what
   * deleting their account is about to change (TournamentService.removeUser).
   * The tournaments' rows before the players' rows, the order joining and
   * leaving take them in.
   */
  async lockOpenOf(tx: Queryable, userId: number): Promise<void> {
    await tx.query(
      `SELECT t.id FROM tournaments t
       WHERE t.status IN ('scheduled', 'running')
         AND (t."createdBy" = $1
           OR EXISTS (SELECT 1 FROM tournament_players p
                      WHERE p."tournamentId" = t.id AND p."userId" = $1 AND p.status <> 'withdrawn'))
       ORDER BY t.id FOR NO KEY UPDATE OF t`,
      [userId]
    );
  },

  /**
   * A deleted account leaves every tournament still open; returns those
   * tournaments. The caller holds their rows (lockOpenOf).
   */
  async withdrawEverywhere(tx: Queryable, userId: number): Promise<number[]> {
    const { rows } = await tx.query<{ tournamentId: number }>(
      `WITH left_ AS (
         UPDATE tournament_players p SET status = 'withdrawn', "waitingSince" = NULL
         FROM tournaments t
         WHERE p."userId" = $1 AND p.status <> 'withdrawn'
           AND t.id = p."tournamentId" AND t.status IN ('scheduled', 'running')
         RETURNING p."tournamentId"
       )
       UPDATE tournaments t SET "playerCount" = GREATEST(0, t."playerCount" - 1)
       FROM left_ WHERE t.id = left_."tournamentId"
       RETURNING t.id AS "tournamentId"`,
      [userId]
    );
    return rows.map((r) => r.tournamentId);
  },
};

/** One key for a pair of users, whichever way round they are given. */
export const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
