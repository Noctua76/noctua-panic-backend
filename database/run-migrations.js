const fs = require("fs");
const path = require("path");

const MIGRATIONS = [
  "2026-09-14-operational-security.sql",
  "2026-09-15-unified-alert-dispatch.sql",
  "2026-09-16-alert-delivery-status.sql",
  "2026-09-17-random-daily-patrols.sql",
  "2026-09-18-same-day-random-activation.sql",
];

async function runMigrations(pool) {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(180) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const migrationName of MIGRATIONS) {
      await client.query("BEGIN");

      try {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [`aegis-link:${migrationName}`]
        );

        const existing = await client.query(
          "SELECT 1 FROM schema_migrations WHERE name = $1",
          [migrationName]
        );

        if (existing.rows.length === 0) {
          const migrationSql = fs.readFileSync(
            path.join(__dirname, migrationName),
            "utf8"
          );

          await client.query(migrationSql);
          await client.query(
            "INSERT INTO schema_migrations (name) VALUES ($1)",
            [migrationName]
          );
          console.log(`[MIGRATION] Applied ${migrationName}`);
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
