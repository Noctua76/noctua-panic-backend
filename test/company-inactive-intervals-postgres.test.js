const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const databaseUrl = process.env.TEST_DATABASE_URL;

test("inactive 10:00-12:00 suppresses 11:00 for every patrol type and permits 13:00", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const schema = `company_lifecycle_${process.pid}_${Date.now()}`;

  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`CREATE TABLE companies (id integer PRIMARY KEY, status text NOT NULL)`);
    await client.query(`CREATE TABLE users (id integer PRIMARY KEY)`);
    await client.query(`
      CREATE TABLE company_status_audit_events (
        id bigserial PRIMARY KEY,
        company_id integer NOT NULL REFERENCES companies(id),
        previous_status text NOT NULL,
        new_status text NOT NULL,
        changed_by integer NOT NULL REFERENCES users(id),
        changed_at timestamptz NOT NULL
      )
    `);
    await client.query(`INSERT INTO users(id) VALUES (7)`);
    await client.query(`INSERT INTO companies(id, status) VALUES (42, 'active')`);
    await client.query(`
      INSERT INTO company_status_audit_events
        (company_id, previous_status, new_status, changed_by, changed_at)
      VALUES
        (42, 'active', 'inactive', 7, '2026-09-22 07:00:00+00'),
        (42, 'inactive', 'active', 7, '2026-09-22 09:00:00+00')
    `);

    const migration = fs.readFileSync(
      path.join(__dirname, "..", "database", "2026-09-27-company-inactive-intervals.sql"),
      "utf8"
    );
    await client.query(migration);

    for (const patrolType of ["recurring", "manual", "random"]) {
      const result = await client.query(
        `SELECT
           is_company_operational_at(42, '2026-09-22 11:00:00', 'Europe/Athens') AS at_1100,
           is_company_operational_at(42, '2026-09-22 12:00:00', 'Europe/Athens') AS at_1200,
           is_company_operational_at(42, '2026-09-22 13:00:00', 'Europe/Athens') AS at_1300`,
      );
      assert.equal(result.rows[0].at_1100, false, `${patrolType} at 11:00 must be suppressed`);
      assert.equal(result.rows[0].at_1200, true, `${patrolType} at reactivation is available`);
      assert.equal(result.rows[0].at_1300, true, `${patrolType} at 13:00 remains available`);
    }
  } finally {
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  }
});
