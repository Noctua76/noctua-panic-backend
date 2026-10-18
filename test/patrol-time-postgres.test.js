const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const databaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL converts Athens patrol wall times correctly across DST", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT
        to_char(
          (TIMESTAMP '2026-03-29 02:30:00' AT TIME ZONE 'Europe/Athens') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS spring_before,
        to_char(
          (TIMESTAMP '2026-03-29 04:30:00' AT TIME ZONE 'Europe/Athens') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS spring_after,
        to_char(
          (TIMESTAMP '2026-10-25 02:30:00' AT TIME ZONE 'Europe/Athens') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS autumn_before,
        to_char(
          (TIMESTAMP '2026-10-25 04:30:00' AT TIME ZONE 'Europe/Athens') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS autumn_after
    `);

    assert.deepEqual(result.rows[0], {
      spring_before: "2026-03-29T00:30:00.000Z",
      spring_after: "2026-03-29T01:30:00.000Z",
      autumn_before: "2026-10-24T23:30:00.000Z",
      autumn_after: "2026-10-25T02:30:00.000Z",
    });
  } finally {
    await client.end();
  }
});
