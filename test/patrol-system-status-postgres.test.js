const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { PATROL_MISSED_STATS_SQL } = require("../patrol/system-status-missed");

const databaseUrl = process.env.TEST_DATABASE_URL;

test("System Status counts all patrol types at +2h and excludes inactive manual schedules", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const client = new Client({ connectionString: databaseUrl });
  const schema = `patrol_status_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE companies (
        id INTEGER PRIMARY KEY,
        timezone TEXT NOT NULL
      );
      CREATE TABLE sites (
        id INTEGER PRIMARY KEY,
        company_id INTEGER NOT NULL
      );
      CREATE TABLE patrol_schedules (
        id INTEGER PRIMARY KEY,
        site_id INTEGER NOT NULL,
        schedule_type TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        start_time TIME,
        interval_hours INTEGER,
        created_at TIMESTAMPTZ NOT NULL,
        scheduled_date DATE,
        scheduled_time TIME
      );
      CREATE TABLE patrol_logs (
        id INTEGER PRIMARY KEY,
        schedule_id INTEGER,
        schedule_type TEXT,
        scheduled_at TIMESTAMP,
        random_occurrence_id INTEGER
      );
      CREATE TABLE random_patrol_days (
        id INTEGER PRIMARY KEY,
        company_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        timezone TEXT NOT NULL
      );
      CREATE TABLE random_patrol_occurrences (
        id INTEGER PRIMARY KEY,
        random_patrol_day_id INTEGER NOT NULL,
        company_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        scheduled_at TIMESTAMP NOT NULL
      );
      CREATE TABLE company_inactive_intervals (
        company_id INTEGER NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ
      );
      CREATE FUNCTION is_company_operational_at(
        p_company_id INTEGER,
        p_local_timestamp TIMESTAMP,
        p_timezone TEXT
      ) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT NOT EXISTS (
          SELECT 1
          FROM company_inactive_intervals inactive
          WHERE inactive.company_id = p_company_id
            AND p_local_timestamp >= inactive.started_at AT TIME ZONE p_timezone
            AND (
              inactive.ended_at IS NULL
              OR p_local_timestamp < inactive.ended_at AT TIME ZONE p_timezone
            )
        )
      $$;
    `);

    await client.query(`
      INSERT INTO companies VALUES
        (1, 'Europe/Athens'),
        (2, 'Europe/Athens');
      INSERT INTO sites VALUES (10, 1), (20, 2);

      INSERT INTO patrol_schedules
        (id, site_id, schedule_type, active, start_time, interval_hours, created_at)
      VALUES
        (100, 10, 'recurring', TRUE, TIME '18:00', 1, TIMESTAMPTZ '2026-10-18 00:00:00+03');

      INSERT INTO patrol_schedules
        (id, site_id, schedule_type, active, created_at, scheduled_date, scheduled_time)
      VALUES
        (101, 10, 'manual', TRUE, TIMESTAMPTZ '2026-10-18 00:00:00+03', DATE '2026-10-18', TIME '17:59'),
        (102, 10, 'manual', TRUE, TIMESTAMPTZ '2026-10-18 00:00:00+03', DATE '2026-10-18', TIME '18:01'),
        (103, 10, 'manual', TRUE, TIMESTAMPTZ '2026-10-18 00:00:00+03', DATE '2026-10-18', TIME '17:00'),
        (104, 10, 'manual', TRUE, TIMESTAMPTZ '2026-10-18 00:00:00+03', DATE '2026-10-18', TIME '16:00'),
        (105, 10, 'manual', FALSE, TIMESTAMPTZ '2026-10-18 00:00:00+03', DATE '2026-10-18', TIME '18:45');

      INSERT INTO patrol_logs
        (id, schedule_id, schedule_type, scheduled_at)
      VALUES (1, 103, 'manual', TIMESTAMP '2026-10-18 17:00');

      INSERT INTO random_patrol_days VALUES
        (200, 1, 10, 'Europe/Athens'),
        (201, 2, 20, 'Europe/Athens');
      INSERT INTO random_patrol_occurrences VALUES
        (300, 200, 1, 10, TIMESTAMP '2026-10-18 17:30'),
        (301, 200, 1, 10, TIMESTAMP '2026-10-18 18:30'),
        (302, 200, 1, 10, TIMESTAMP '2026-10-18 17:15'),
        (303, 201, 2, 20, TIMESTAMP '2026-10-18 17:15');
      INSERT INTO patrol_logs
        (id, random_occurrence_id, scheduled_at)
      VALUES (2, 302, TIMESTAMP '2026-10-18 17:15');

      INSERT INTO company_inactive_intervals
        (company_id, started_at, ended_at)
      VALUES (
        1,
        TIMESTAMPTZ '2026-10-18 15:30:00+03',
        TIMESTAMPTZ '2026-10-18 16:30:00+03'
      );
    `);

    const before = await client.query(PATROL_MISSED_STATS_SQL, [
      1,
      "2026-10-18T16:59:59.999Z",
    ]);
    assert.equal(before.rows[0].missed_last_30_days, 2);
    assert.equal(before.rows[0].last_missed_at.toISOString(), "2026-10-18T14:59:00.000Z");

    const exact = await client.query(PATROL_MISSED_STATS_SQL, [
      1,
      "2026-10-18T17:00:00.000Z",
    ]);
    assert.equal(exact.rows[0].missed_last_30_days, 3);
    assert.equal(exact.rows[0].last_missed_at.toISOString(), "2026-10-18T15:00:00.000Z");

    const afterCancelledManualBoundary = await client.query(PATROL_MISSED_STATS_SQL, [
      1,
      "2026-10-18T17:45:00.000Z",
    ]);
    assert.equal(
      afterCancelledManualBoundary.rows[0].missed_last_30_days,
      5,
      "inactive manual schedule must not increase the missed count"
    );
    assert.equal(
      afterCancelledManualBoundary.rows[0].last_missed_at.toISOString(),
      "2026-10-18T15:30:00.000Z",
      "inactive manual schedule must not replace the latest valid missed patrol"
    );

    const otherTenant = await client.query(PATROL_MISSED_STATS_SQL, [
      2,
      "2026-10-18T17:30:00.000Z",
    ]);
    assert.equal(otherTenant.rows[0].missed_last_30_days, 1);
  } finally {
    await client.query("RESET search_path").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
