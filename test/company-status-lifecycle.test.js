const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { changeCompanyStatus } = require("../admin/companies");

function createStatusPool({ currentStatus = "active", failAt = null } = {}) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (failAt && normalized.includes(failAt)) throw new Error("forced status failure");
      if (normalized.startsWith("SELECT id, name, status, timezone FROM companies")) {
        return { rows: [{ id: 42, name: "Acme", status: currentStatus, timezone: "Europe/Athens" }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE companies")) {
        return { rows: [{ id: 42, name: "Acme", status: params[0], timezone: "Europe/Athens" }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE admin_sessions")) return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
      if (normalized.startsWith("UPDATE guard_sessions")) return { rows: [{ id: 3 }], rowCount: 1 };
      if (normalized.startsWith("UPDATE push_subscriptions")) return { rows: [{ id: 4 }, { id: 5 }, { id: 6 }], rowCount: 3 };
      return { rows: [], rowCount: 0 };
    },
    release() { queries.push({ sql: "RELEASE", params: [] }); },
  };
  return { pool: { connect: async () => client }, queries };
}

test("inactive transition atomically closes tenant sessions, disables push and audits", async () => {
  const mock = createStatusPool();
  const result = await changeCompanyStatus({
    pool: mock.pool,
    companyId: 42,
    newStatus: "inactive",
    actorUserId: 7,
  });

  assert.equal(result.previous_status, "active");
  assert.equal(result.company.status, "inactive");
  assert.deepEqual(result.shutdown, {
    dashboard_sessions: 2,
    guard_sessions: 1,
    push_subscriptions: 3,
  });
  const sql = mock.queries.map((query) => query.sql);
  assert.equal(sql[0], "BEGIN");
  assert.ok(sql.some((query) => query.includes("session_end_reason = COALESCE(ads.session_end_reason, 'company_inactive')")));
  assert.ok(sql.some((query) => query.includes("u.role <> 'system_owner'")));
  assert.ok(sql.some((query) => query.includes("status = 'company_inactive'")));
  assert.ok(sql.some((query) => query.startsWith("UPDATE push_subscriptions")));
  assert.ok(sql.some((query) => query.startsWith("INSERT INTO company_status_audit_events")));
  assert.ok(sql.includes("COMMIT"));
});

test("pilot and active transitions preserve accounts, data and old sessions without restoring them", async () => {
  for (const newStatus of ["pilot", "active"]) {
    const mock = createStatusPool({ currentStatus: "inactive" });
    const result = await changeCompanyStatus({ pool: mock.pool, companyId: 42, newStatus, actorUserId: 7 });
    assert.equal(result.company.status, newStatus);
    assert.deepEqual(result.shutdown, { dashboard_sessions: 0, guard_sessions: 0, push_subscriptions: 0 });
    const sql = mock.queries.map((query) => query.sql).join("\n");
    assert.doesNotMatch(sql, /UPDATE users|UPDATE guards|UPDATE admin_sessions|UPDATE guard_sessions|UPDATE push_subscriptions/);
    assert.match(sql, /INSERT INTO company_status_audit_events/);
  }
});

test("status transition rolls back every lifecycle action on failure", async () => {
  const mock = createStatusPool({ failAt: "UPDATE push_subscriptions" });
  await assert.rejects(
    changeCompanyStatus({ pool: mock.pool, companyId: 42, newStatus: "inactive", actorUserId: 7 }),
    /forced status failure/
  );
  const sql = mock.queries.map((query) => query.sql);
  assert.ok(sql.includes("ROLLBACK"));
  assert.equal(sql.includes("COMMIT"), false);
  assert.equal(sql.some((query) => query.startsWith("INSERT INTO company_status_audit_events")), false);
});

test("only active, pilot and inactive are accepted", async () => {
  const mock = createStatusPool();
  await assert.rejects(
    changeCompanyStatus({ pool: mock.pool, companyId: 42, newStatus: "suspended", actorUserId: 7 }),
    (error) => error.code === "COMPANY_STATUS_INVALID"
  );
  assert.equal(mock.queries.length, 0);
});

test("auth and background paths enforce the complete company lifecycle", () => {
  const root = path.join(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const randomPatrols = fs.readFileSync(path.join(root, "patrol/random-patrols.js"), "utf8");
  const migration = fs.readFileSync(path.join(root, "database/2026-09-26-company-status-lifecycle.sql"), "utf8");

  const dashboardLogin = server.slice(server.indexOf('app.post("/auth/login"'), server.indexOf("async function requireAuth"));
  assert.match(dashboardLogin, /\["pilot", "active"\]\.includes\(user\.company_status\)/);
  assert.match(dashboardLogin, /WITH company_gate[\s\S]*FOR SHARE[\s\S]*INSERT INTO admin_sessions[\s\S]*company_gate\.status IN \('active', 'pilot'\)/);
  const dashboardAuth = server.slice(server.indexOf("async function requireAuth"), server.indexOf("async function requireGuardAuth"));
  assert.match(dashboardAuth, /\["pilot", "active"\]\.includes\(auth\.company_status\)/);

  const guardAuth = server.slice(server.indexOf("async function requireGuardAuth"), server.indexOf("AUTH CONTEXT TEST"));
  assert.match(guardAuth, /JOIN companies c/);
  assert.match(guardAuth, /COMPANY_INACTIVE/);
  const guardLogin = server.slice(server.indexOf('app.post("/guard/login"'), server.indexOf('app.post("/guard/logout"'));
  assert.match(guardLogin, /c\.status AS company_status/);
  assert.match(guardLogin, /COMPANY_INACTIVE/);
  assert.match(guardLogin, /WITH company_gate[\s\S]*FOR SHARE OF login_company[\s\S]*INSERT INTO guard_sessions[\s\S]*company_gate\.status IN \('active', 'pilot'\)/);

  assert.match(randomPatrols, /c\.status IN \('active', 'pilot'\)/);
  assert.match(server, /generateScheduledShiftsForAllSites[\s\S]*c\.status IN \('active', 'pilot'\)/);
  assert.match(server, /delay_company\.status IN \('active', 'pilot'\)/);
  assert.match(server, /processPendingShiftDelayEmails[\s\S]*c\.status IN \('active', 'pilot'\)/);
  assert.match(server, /runPatrolPushScheduler[\s\S]*c\.status IN \('active', 'pilot'\)/);
  assert.match(server, /operational_resumed_at[\s\S]*scheduledStart[\s\S]*site\.operational_resumed_at/);
  assert.match(randomPatrols, /partial_reactivation/);

  assert.match(migration, /company_status_audit_events/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /'company_inactive'/);
  assert.match(migration, /'partial_reactivation'/);
});
