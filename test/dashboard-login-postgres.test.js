const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const databaseUrl = process.env.TEST_DATABASE_URL;
const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const loginRoute = serverSource.slice(
  serverSource.indexOf('app.post("/auth/login"'),
  serverSource.indexOf("async function requireAuth")
);
const sessionQueryMatch = loginRoute.match(
  /const sessionResult = await pool\.query\(\s*`([\s\S]*?INSERT INTO admin_sessions[\s\S]*?)`,\s*\[/
);

assert.ok(sessionQueryMatch, "Dashboard login session query must be discoverable");
const dashboardLoginSessionQuery = sessionQueryMatch[1];

test("Dashboard login session role parameter uses one explicit PostgreSQL type", () => {
  assert.match(dashboardLoginSessionQuery, /\$3::text,/);
  assert.match(dashboardLoginSessionQuery, /WHERE \$3::text = 'system_owner'/);
  assert.doesNotMatch(dashboardLoginSessionQuery, /WHERE \$3 = 'system_owner'/);
});

test("PostgreSQL login-session query preserves System Owner and company lifecycle access", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const schema = `dashboard_login_${process.pid}_${Date.now()}`;

  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE companies (
        id integer PRIMARY KEY,
        status text NOT NULL
      )
    `);
    await client.query(`
      CREATE TABLE admin_sessions (
        id bigserial PRIMARY KEY,
        user_id integer NOT NULL,
        username varchar(120) NOT NULL,
        role varchar(80) NOT NULL,
        company_id integer NOT NULL REFERENCES companies(id),
        session_token varchar(128) NOT NULL,
        login_time timestamptz NOT NULL,
        last_seen timestamptz NOT NULL,
        is_active boolean NOT NULL
      )
    `);
    await client.query(`
      INSERT INTO companies(id, status)
      VALUES (1, 'inactive'), (2, 'active'), (3, 'pilot'), (4, 'inactive')
    `);

    const cases = [
      { role: "system_owner", companyId: 1, shouldCreate: true },
      { role: "company_administrator", companyId: 2, shouldCreate: true },
      { role: "company_administrator", companyId: 3, shouldCreate: true },
      { role: "company_administrator", companyId: 4, shouldCreate: false },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const scenario = cases[index];
      const result = await client.query(dashboardLoginSessionQuery, [
        index + 1,
        `login-user-${index + 1}`,
        scenario.role,
        scenario.companyId,
        `session-token-${index + 1}`,
      ]);
      assert.equal(
        result.rows.length,
        scenario.shouldCreate ? 1 : 0,
        `${scenario.role} for company ${scenario.companyId}`
      );
    }

    assert.match(
      loginRoute,
      /sessionResult\.rows\.length === 0[\s\S]*status\(403\)[\s\S]*COMPANY_INACTIVE/
    );
  } finally {
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  }
});
