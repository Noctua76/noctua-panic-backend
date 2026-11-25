const { Pool } = require("pg");
const { runtimeDatabaseOptions } = require("./security/database-tls");

// Strict trust is the default. The explicit temporary Owner exception preserves
// the existing encrypted production profile; it never trusts a fetched peer as CA.
const pool = new Pool(runtimeDatabaseOptions(process.env));

async function testDb() {
  try {
    await pool.query("SELECT NOW()");
    console.log("Postgres connection verified");
  } catch {
    console.error("DATABASE_CONNECTION_FAILED");
  }
}
testDb();
module.exports = pool;
