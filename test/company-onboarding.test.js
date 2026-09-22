const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createCompanyWithAdministrator,
  isValidIanaTimezone,
  listCompanies,
  validateCompanyOnboardingInput,
} = require("../admin/companies");
const { createDashboardRbac, routePermission } = require("../auth/dashboard-rbac");

const companyColumns = ["id", "name", "status", "timezone", "created_at"].map((column_name) => ({
  column_name,
  data_type: column_name === "created_at" ? "timestamp with time zone" : "text",
  udt_name: column_name === "created_at" ? "timestamptz" : "text",
}));

function makePool({ failAt = null } = {}) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (failAt && normalized.includes(failAt)) throw new Error("forced failure");
      if (normalized.startsWith("SELECT column_name")) return { rows: companyColumns };
      if (normalized.startsWith("INSERT INTO companies")) {
        return { rows: [{ id: 42, name: params[0], status: params[1], timezone: params[2], created_at: "2026-09-22T10:00:00Z" }] };
      }
      if (normalized.startsWith("SELECT id, code, name FROM dashboard_roles")) {
        return { rows: [{ id: 7, code: "company_administrator", name: "Company Administrator" }] };
      }
      if (normalized.startsWith("INSERT INTO users")) {
        return { rows: [{ id: 84, full_name: params[0], username: params[1], email: params[2], phone: params[3], role: params[4], status: "active", company_id: params[5], must_change_password: true, access_mode: "standard", created_at: "2026-09-22T10:00:01Z" }] };
      }
      return { rows: [] };
    },
    release() { queries.push({ sql: "RELEASE", params: [] }); },
  };
  return { pool: { connect: async () => client }, queries };
}

const validBody = {
  company: { name: "Acme Security", timezone: "Europe/Athens", status: "active" },
  administrator: { full_name: "Alex Admin", username: "alex.admin", email: "alex@example.com", phone: "+301234" },
};

test("company onboarding accepts IANA timezones and rejects fixed offsets", () => {
  assert.equal(isValidIanaTimezone("Europe/Athens"), true);
  assert.equal(isValidIanaTimezone("UTC+03:00"), false);
  assert.equal(isValidIanaTimezone("Not/AZone"), false);
  assert.equal(validateCompanyOnboardingInput(validBody).company.status, "active");
});

test("System Owner company creation is atomic and provisions only the first administrator", async () => {
  const mock = makePool();
  const password = "Temp-A9!secure";
  const hashes = [];
  const result = await createCompanyWithAdministrator({
    pool: mock.pool,
    actorUserId: 1,
    body: validBody,
    generateTemporaryPassword: () => password,
    hashPassword: async (...args) => { hashes.push(args); return "secure-hash"; },
  });

  assert.equal(result.company.id, 42);
  assert.equal(result.company.timezone, "Europe/Athens");
  assert.equal(result.company.status, "active");
  assert.equal(result.administrator.company_id, 42);
  assert.equal(result.administrator.role_code, "company_administrator");
  assert.equal(result.administrator.must_change_password, true);
  assert.equal(result.administrator.access_mode, "standard");
  assert.deepEqual(result.credentials, { username: "alex.admin", temporary_password: password });
  assert.deepEqual(hashes, [[password, 10]]);

  const sql = mock.queries.map((query) => query.sql);
  assert.equal(sql[0], "BEGIN");
  assert.ok(sql.includes("COMMIT"));
  assert.equal(sql.includes("ROLLBACK"), false);
  assert.ok(sql.some((query) => query.startsWith("INSERT INTO user_dashboard_roles")));
  assert.ok(sql.some((query) => query.startsWith("INSERT INTO dashboard_rbac_audit_events")));
  assert.equal(sql.some((query) => /INSERT INTO (sites|guards|patrol)/i.test(query)), false);
});

test("company onboarding rolls back the company when administrator creation fails", async () => {
  const mock = makePool({ failAt: "INSERT INTO users" });
  await assert.rejects(
    createCompanyWithAdministrator({
      pool: mock.pool,
      actorUserId: 1,
      body: validBody,
      generateTemporaryPassword: () => "Temp-A9!secure",
      hashPassword: async () => "secure-hash",
    }),
    /forced failure/
  );
  const sql = mock.queries.map((query) => query.sql);
  assert.ok(sql.includes("ROLLBACK"));
  assert.equal(sql.includes("COMMIT"), false);
  assert.equal(sql.some((query) => query.startsWith("INSERT INTO user_dashboard_roles")), false);
});

test("company listing uses isolated correlated counts without multiplicative joins", async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push(normalized);
      if (normalized.startsWith("SELECT column_name")) return { rows: companyColumns };
      return { rows: [{ id: 42, sites_count: 0, guards_count: 0, dashboard_users_count: 1 }] };
    },
  };
  const rows = await listCompanies(pool);
  assert.equal(rows[0].sites_count, 0);
  assert.match(queries[1], /SELECT COUNT\(\*\)::int FROM sites/);
  assert.match(queries[1], /SELECT COUNT\(\*\)::int FROM guards/);
  assert.match(queries[1], /SELECT COUNT\(\*\)::int FROM users/);
  assert.doesNotMatch(queries[1], /FROM companies c LEFT JOIN/);
});

test("Companies API bypasses generic permission classification and requires System Owner explicitly", () => {
  assert.equal(routePermission("GET", "/admin/companies"), null);
  assert.equal(routePermission("POST", "/admin/companies"), null);

  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(source, /"\/admin\/companies",\s*requireAuth,\s*dashboardRbac\.requireSystemOwner/);

  const rbac = createDashboardRbac({ pool: { query: async () => ({ rows: [] }) } });
  let statusCode = null;
  let payload = null;
  rbac.requireSystemOwner(
    { auth: { is_system_owner: false } },
    { status(code) { statusCode = code; return this; }, json(value) { payload = value; return value; } },
    () => assert.fail("non-owner must not proceed")
  );
  assert.equal(statusCode, 403);
  assert.equal(payload.code, "SYSTEM_OWNER_REQUIRED");
});

