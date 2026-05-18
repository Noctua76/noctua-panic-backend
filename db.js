const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function testDb() {
  try {
    const result = await pool.query("SELECT NOW()");
    console.log("Postgres connected:", result.rows[0]);
  } catch (err) {
    console.error("DB ERROR:", err);
  }
}

testDb();

module.exports = pool;