const test = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { GUARD_LOCATION_UPDATE_SQL } = require("../guard-location");

const databaseUrl = process.env.TEST_DATABASE_URL;

test("Guard location update explicitly casts mixed PostgreSQL coordinate types", () => {
  assert.match(GUARD_LOCATION_UPDATE_SQL, /last_latitude = \$1::numeric/);
  assert.match(GUARD_LOCATION_UPDATE_SQL, /last_longitude = \$2::numeric/);
  assert.match(GUARD_LOCATION_UPDATE_SQL, /last_location_accuracy = \$3::integer/);
  assert.match(GUARD_LOCATION_UPDATE_SQL, /last_geocoded_latitude = CASE[\s\S]*\$1::double precision/);
  assert.match(GUARD_LOCATION_UPDATE_SQL, /last_geocoded_longitude = CASE[\s\S]*\$2::double precision/);
  assert.match(GUARD_LOCATION_UPDATE_SQL, /last_location_address = COALESCE\(\$6::text, last_location_address\)/);
});

test("real PostgreSQL accepts the Guard location update without type ambiguity", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const schema = `guard_location_${process.pid}_${Date.now()}`;

  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE guard_sessions (
        id integer PRIMARY KEY,
        guard_id integer NOT NULL,
        logout_time timestamp,
        last_latitude numeric(10,8),
        last_longitude numeric(11,8),
        last_location_accuracy integer,
        last_speed numeric(8,2),
        last_battery_level integer,
        last_location_address text,
        last_location_at timestamp,
        last_geocoded_latitude double precision,
        last_geocoded_longitude double precision,
        last_reverse_geocode_at timestamptz
      )
    `);
    await client.query(`
      INSERT INTO guard_sessions (
        id, guard_id, last_location_address,
        last_geocoded_latitude, last_geocoded_longitude,
        last_reverse_geocode_at
      ) VALUES (1, 7, 'Existing address', 38.04, 23.79, '2026-09-23T10:00:00Z')
    `);

    await client.query(GUARD_LOCATION_UPDATE_SQL, [
      38.04001, 23.79001, 18, 0, 76, null, 7, 1, false,
    ]);
    const stationary = await client.query(`SELECT * FROM guard_sessions WHERE id = 1`);
    assert.equal(stationary.rows[0].last_latitude, "38.04001000");
    assert.equal(stationary.rows[0].last_longitude, "23.79001000");
    assert.equal(stationary.rows[0].last_location_accuracy, 18);
    assert.equal(stationary.rows[0].last_battery_level, 76);
    assert.equal(stationary.rows[0].last_location_address, "Existing address");
    assert.equal(stationary.rows[0].last_geocoded_latitude, 38.04);
    assert.ok(stationary.rows[0].last_location_at);

    await client.query(GUARD_LOCATION_UPDATE_SQL, [
      38.042, 23.792, 12, 1.25, 74, "Updated address", 7, 1, true,
    ]);
    const moved = await client.query(`SELECT * FROM guard_sessions WHERE id = 1`);
    assert.equal(moved.rows[0].last_location_address, "Updated address");
    assert.equal(moved.rows[0].last_geocoded_latitude, 38.042);
    assert.equal(moved.rows[0].last_geocoded_longitude, 23.792);
    assert.ok(moved.rows[0].last_reverse_geocode_at);
  } finally {
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  }
});
