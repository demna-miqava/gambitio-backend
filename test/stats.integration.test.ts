import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createUser, integrationEnabled, resetDb, startTestApp } from "./helpers.js";
import { cachedField, cachedValue, invalidateCacheGroups, type CacheGroup } from "../src/utils/cache.js";
import { invalidateStats, statsCache } from "../src/services/statsService.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The rating history as it was computed before migration 031 (running sums
 * over every game the player has finished), kept here to check the faster
 * query gives the same points.
 */
async function referenceHistory(app: FastifyInstance, userId: number, variant: string | null, since: Date) {
  const { rows: users } = await app.pg.query(`SELECT "bulletRating", "blitzRating", "rapidRating" FROM users WHERE id = $1`, [
    userId,
  ]);
  const user = users[0];
  const { rows } = await app.pg.query(
    `WITH played AS (
       SELECT g.id, g."createdAt",
         CASE WHEN g.time < 180 THEN 'bullet' WHEN g.time < 600 THEN 'blitz' ELSE 'rapid' END AS variant,
         COALESCE(CASE WHEN g."whiteId" = $1 THEN g."whiteRatingChange" ELSE g."blackRatingChange" END, 0) AS change
       FROM games g
       WHERE (g."whiteId" = $1 OR g."blackId" = $1) AND g.status = 'finished' AND g.result <> 'aborted' AND g.rated),
     running AS (
       SELECT id, "createdAt", variant,
         COALESCE(SUM(change) FILTER (WHERE variant = 'bullet') OVER w, 0)::int AS bullet,
         COALESCE(SUM(change) FILTER (WHERE variant = 'blitz') OVER w, 0)::int AS blitz,
         COALESCE(SUM(change) FILTER (WHERE variant = 'rapid') OVER w, 0)::int AS rapid,
         COALESCE(SUM(change) FILTER (WHERE variant = 'bullet') OVER (), 0)::int AS "totalBullet",
         COALESCE(SUM(change) FILTER (WHERE variant = 'blitz') OVER (), 0)::int AS "totalBlitz",
         COALESCE(SUM(change) FILTER (WHERE variant = 'rapid') OVER (), 0)::int AS "totalRapid"
       FROM played
       WINDOW w AS (ORDER BY "createdAt", id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))
     SELECT DISTINCT ON (day) "createdAt", bullet, blitz, rapid, "totalBullet", "totalBlitz", "totalRapid"
     FROM (SELECT *, ("createdAt" AT TIME ZONE 'UTC')::date AS day FROM running) r
     WHERE ($2::text IS NULL OR variant = $2::text) AND "createdAt" >= $3
     ORDER BY day, "createdAt" DESC, id DESC`,
    [userId, variant, since]
  );
  const points = rows.map((r) => {
    const ratings = {
      bullet: user.bulletRating - r.totalBullet + r.bullet,
      blitz: user.blitzRating - r.totalBlitz + r.blitz,
      rapid: user.rapidRating - r.totalRapid + r.rapid,
    };
    const rating =
      variant === null
        ? Math.round((ratings.bullet + ratings.blitz + ratings.rapid) / 3)
        : ratings[variant as keyof typeof ratings];
    const date = (r.createdAt as Date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return { date, rating };
  });
  if (points.length <= 30) return points;
  const step = (points.length - 1) / 29;
  return Array.from({ length: 30 }, (_, i) => points[Math.round(i * step)]!);
}

describe("profile stats", { skip }, () => {
  let app: FastifyInstance;

  before(async () => {
    ({ app } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(app);
  });

  const get = async (url: string, clerkId: string) => {
    const res = await app.inject({ url, headers: { authorization: `Bearer ${clerkId}` } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };

  /** Finished games for `player` against others, spread over the last ~400 days. */
  const seedGames = async (player: { id: number }, opponents: { id: number }[], count: number) => {
    let x = 42;
    const random = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let i = 0; i < count; i++) {
      const opponent = opponents[i % opponents.length]!;
      const white = random() < 0.5;
      const time = [60, 180, 600][Math.floor(random() * 3)]!;
      const outcome = random();
      const winnerId = outcome < 0.45 ? player.id : outcome < 0.9 ? opponent.id : null;
      const change = winnerId === player.id ? 8 : winnerId === null ? 0 : -8;
      // Some unrated (time odds) and aborted games, which stats leave out
      const rated = i % 17 !== 0;
      const aborted = i % 23 === 0;
      const createdAt = new Date(Date.now() - random() * 400 * DAY_MS);
      const row = [
        createdAt,
        white ? player.id : opponent.id,
        white ? opponent.id : player.id,
        1200 + Math.floor(random() * 400),
        1200 + Math.floor(random() * 400),
        time,
        aborted ? "aborted" : winnerId === null ? "draw" : (winnerId === player.id) === white ? "white_win" : "black_win",
        aborted ? null : winnerId,
        white ? change : -change,
        white ? -change : change,
        rated,
      ];
      const base = values.length;
      values.push(...row);
      tuples.push(`(${row.map((_, j) => `$${base + j + 1}`).join(", ")})`);
    }
    await app.pg.query(
      `INSERT INTO games ("createdAt", "whiteId", "blackId", "whiteRating", "blackRating", time, result, "winnerId",
         "whiteRatingChange", "blackRatingChange", rated, status, "whiteUsername", "blackUsername", "numMoves")
       SELECT c::timestamptz, w::int, b::int, wr::int, br::int, t::int, r::game_result, win::int, wc::int, bc::int, rated::boolean,
         'finished', 'w', 'b', 10
       FROM (VALUES ${tuples.join(", ")}) v(c, w, b, wr, br, t, r, win, wc, bc, rated)`,
      values
    );
  };

  test("rating history reads only the period and matches the running-sum version", async () => {
    const player = await createUser(app, "player", 1500);
    const opponents = await Promise.all(["oppone1", "oppone2", "oppone3"].map((n) => createUser(app, n)));
    await seedGames(player, opponents, 400);

    for (const days of ["30", "90", "365", "all-time"]) {
      for (const variant of ["all", "bullet", "blitz", "rapid"]) {
        const stats = await get(`/api/users/${player.id}/stats?days=${days}&variant=${variant}`, player.clerkId);
        const since = new Date(days === "all-time" ? 0 : Date.now() - Number(days) * DAY_MS);
        const expected = await referenceHistory(app, player.id, variant === "all" ? null : variant, since);
        assert.deepEqual(stats.ratingHistory, expected, `${days} ${variant}`);
        assert.ok(stats.ratingHistory.length > 0);
      }
    }
    const summary = await get(`/api/users/${player.id}/stats/summary`, player.clerkId);
    const { rows } = await app.pg.query(
      `SELECT COUNT(*)::int AS n FROM games WHERE ("whiteId" = $1 OR "blackId" = $1)
         AND status = 'finished' AND result <> 'aborted' AND rated`,
      [player.id]
    );
    assert.equal(summary.numberOfGames, rows[0].n);
  });

  test("ranks and percentile count the listed players", async () => {
    const me = await createUser(app, "mememe", 1500);
    const ratings = [1700, 1600, 1500, 1500, 1400, 1300, 1200];
    const others = await Promise.all(ratings.map((r, i) => createUser(app, `player${i}`, r)));
    const unlisted = await createUser(app, "unlisted", 1900);
    await app.pg.query(`UPDATE users SET "blitzGames" = 1 WHERE id <> $1`, [unlisted.id]);
    await app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2), ($3, $1)`, [
      me.id,
      others[0]!.id,
      others[5]!.id,
    ]);
    const stats = await get(`/api/users/${me.id}/stats?days=30&variant=blitz`, me.clerkId);
    // Above: 1700, 1600. Below: 1400, 1300, 1200 out of the 7 others
    assert.equal(stats.globalRank, 3);
    assert.equal(stats.percentile, Math.round((3 / 7) * 100));
    assert.equal(stats.friendsRank, 2);
    assert.equal(stats.friendsCount, 2);
    // The number of listed players is cached for everyone
    assert.equal(JSON.parse((await app.redis.get("listed:total:blitz"))!).v, 8);
  });

  test("a result computed before an invalidation isn't stored after it", async () => {
    const group: CacheGroup = statsCache(1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Started before the game's commit: reads the old data, then is slow
    const slow = cachedField(app.redis, app.log, group, "summary", 60, async () => {
      await gate;
      return "old";
    });
    await new Promise((r) => setTimeout(r, 20));
    await invalidateStats(app.redis, [1]); // the game ended meanwhile
    release();
    assert.equal(await slow, "old"); // the caller still gets its answer...
    assert.equal(await app.redis.hGet(group.key, "summary"), null); // ...but it isn't cached
    assert.equal(await cachedField(app.redis, app.log, group, "summary", 60, async () => "new"), "new");
    assert.equal(await cachedField(app.redis, app.log, group, "summary", 60, async () => "newer"), "new");
    await invalidateCacheGroups(app.redis, [group]);
    assert.equal(await app.redis.exists(group.key), 0);
  });

  test("cached values are computed once per key at a time, and served stale while refreshed", async () => {
    let calls = 0;
    const compute = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return calls;
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => cachedValue(app.redis, app.log, "test:sf", 60, compute)));
    assert.deepEqual(results, [1, 1, 1, 1, 1]);
    assert.equal(calls, 1);

    // Past its freshness but within the stale window: answered at once, refreshed behind
    await app.redis.setEx("test:sf", 120, JSON.stringify({ v: "stale", freshUntil: Date.now() - 1 }));
    const options = { staleSeconds: 60 };
    assert.equal(await cachedValue(app.redis, app.log, "test:sf", 60, compute, options), "stale");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls, 2);
    assert.equal(await cachedValue(app.redis, app.log, "test:sf", 60, compute, options), 2);
    // Without a stale window an expired value is computed again before answering
    await app.redis.setEx("test:sf", 120, JSON.stringify({ v: "stale", freshUntil: Date.now() - 1 }));
    assert.equal(await cachedValue(app.redis, app.log, "test:sf", 60, compute), 3);
  });
});
