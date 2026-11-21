/**
 * Applies pending SQL migrations from ./migrations in filename order.
 * Usage: npm run migrate   (reads POSTGRES_CONNECTION_STRING)
 *
 * A database created before migrations were tracked already has the baseline
 * schema, so 001_baseline.sql is recorded as applied instead of being run.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);
const BASELINE = "001_baseline.sql";

export async function migrate(connectionString: string, log = console.log) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      "appliedAt" timestamptz NOT NULL DEFAULT now()
    )`);

    const { rows: applied } = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations"
    );
    const appliedNames = new Set(applied.map((r) => r.name));

    if (appliedNames.size === 0) {
      const { rows } = await client.query(
        "SELECT to_regclass('public.users') IS NOT NULL AS exists"
      );
      if (rows[0].exists) {
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [BASELINE]);
        appliedNames.add(BASELINE);
        log(`Existing schema detected, marked ${BASELINE} as applied`);
      }
    }

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (appliedNames.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        // The app's limits (statement_timeout 5 s and the idle one) may be
        // the role's defaults (ensureSessionTimeouts in src/db.ts), which
        // this session would get too: an index build or a backfill can take
        // longer. SET LOCAL holds for this transaction, also through a pooler
        await client.query("SET LOCAL statement_timeout = 0; SET LOCAL idle_in_transaction_session_timeout = 0");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log(`Applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.POSTGRES_CONNECTION_STRING;
  if (!connectionString) {
    console.error("POSTGRES_CONNECTION_STRING is not set");
    process.exit(1);
  }
  migrate(connectionString).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
