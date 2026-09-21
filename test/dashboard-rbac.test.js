const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createDashboardRbac, routePermission } = require("../auth/dashboard-rbac");

test("critical Dashboard routes map to canonical permissions", () => {
  assert.equal(routePermission("POST", "/settings/guards/4/reset-password"), "guards.reset_password");
  assert.equal(routePermission("PUT", "/admin/users/4/reset-password"), "users.reset_password");
  assert.equal(routePermission("POST", "/admin/users"), "users.manage");
  assert.equal(routePermission("GET", "/admin/users"), "users.view");
  assert.equal(routePermission("POST", "/admin/patrol-corrections"), "patrols.correct");
  assert.equal(routePermission("PATCH", "/shift-reports/2/acknowledge"), "shift_reports.acknowledge");
  assert.equal(routePermission("GET", "/system/status/global"), "system_status.global");
  assert.deepEqual(routePermission("GET", "/admin/roles"), ["users.view", "roles.view"]);
  assert.equal(routePermission("POST", "/admin/roles"), "roles.manage");
  assert.equal(routePermission("GET", "/settings/alert-configuration"), "alerts.view");
  assert.equal(routePermission("POST", "/settings/alert-recipients"), "alerts.manage");
  assert.equal(routePermission("POST", "/alerts/test"), "alerts.manage");
  assert.equal(routePermission("GET", "/auth/context"), null);
});

test("auth context is available to every valid Dashboard session", () => {
  const rbac = createDashboardRbac({ pool: { query: async () => ({ rows: [] }) } });
  let nextCalled = false;
  rbac.enforceRequestPermission(
    { method: "GET", originalUrl: "/auth/context", auth: { permissions: ["shift_reports.view"] } },
    { status() { return this; }, json() { return this; } },
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
});

test("direct alert mutation returns 403 without alerts.manage", () => {
  const rbac = createDashboardRbac({ pool: { query: async () => ({ rows: [] }) } });
  const response = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  let nextCalled = false;
  rbac.enforceRequestPermission(
    { method: "POST", originalUrl: "/settings/alert-recipients", auth: { permissions: ["alerts.view"] } },
    response,
    () => { nextCalled = true; }
  );
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, "PERMISSION_DENIED");
  assert.equal(nextCalled, false);
});

test("roles list accepts either users.view or roles.view", () => {
  const rbac = createDashboardRbac({ pool: { query: async () => ({ rows: [] }) } });
  for (const permission of ["users.view", "roles.view"]) {
    const req = { method: "GET", originalUrl: "/admin/roles", auth: { permissions: [permission] } };
    let nextCalled = false;
    rbac.enforceRequestPermission(req, { status() { return this; }, json() { return this; } }, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  }
});

test("Role Management mutations require System Owner in addition to permission", () => {
  const rbac = createDashboardRbac({ pool: { query: async () => ({ rows: [] }) } });
  const response = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  let nextCalled = false;
  rbac.requireSystemOwner(
    { auth: { is_system_owner: false, permissions: ["roles.manage"] } },
    response,
    () => { nextCalled = true; }
  );
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, "SYSTEM_OWNER_REQUIRED");
  assert.equal(nextCalled, false);
});

test("direct HTTP-style enforcement returns 403 without permission", () => {
  const rbac = createDashboardRbac({ pool: { query: async () => ({ rows: [] }) } });
  const req = { method: "POST", originalUrl: "/settings/guards/8/reset-password", auth: { permissions: [] } };
  const response = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  let nextCalled = false;
  rbac.enforceRequestPermission(req, response, () => { nextCalled = true; });
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, "PERMISSION_DENIED");
  assert.equal(nextCalled, false);
});

test("legacy Dashboard guard remains detected without silent reassignment", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const rbac = createDashboardRbac({ pool });
  const auth = await rbac.resolveAuthorization({ user_id: 9, role: "guard", authorization_version: 1 });
  assert.equal(auth.role_name, "Legacy Dashboard Role");
  assert.equal(auth.legacy_role, "guard");
  assert.ok(auth.permissions.includes("guards.manage"));
  assert.equal(auth.permissions.includes("roles.manage"), false);
});

test("RBAC migration is additive, maps known roles and leaves legacy guard untouched", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../database/2026-09-22-dashboard-rbac.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dashboard_roles/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dashboard_permissions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dashboard_role_permissions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS user_dashboard_roles/);
  assert.match(sql, /u\.role IN \('system_owner', 'supervisor', 'company_administrator', 'operations_manager', 'viewer'\)/);
  assert.doesNotMatch(sql, /DELETE FROM users[\s\S]*role\s*=\s*'guard'/i);
  assert.doesNotMatch(sql, /UPDATE users[\s\S]*WHERE role\s*=\s*'guard'/i);
});

test("server defaults new Dashboard users to Viewer and never allows Guard", () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(source, /role = "viewer"/);
  assert.match(source, /targetRole\.code === "guard"/);
  assert.doesNotMatch(source, /allowedRoles\s*=\s*\[[^\]]*"guard"/);
});

test("RBAC correction widens compatibility role code and wires exact Random Patrol permissions", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../database/2026-09-23-dashboard-rbac-corrections.sql"), "utf8");
  const randomPatrols = fs.readFileSync(path.join(__dirname, "../patrol/random-patrols.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(migration, /ALTER COLUMN role TYPE VARCHAR\(96\)/);
  assert.doesNotMatch(randomPatrols, /requirePatrolAdministrator/);
  assert.match(randomPatrols, /requirePermission\("patrols\.view"\)/);
  assert.match(randomPatrols, /requirePermission\("patrols\.manage"\)/);
  assert.match(randomPatrols, /requireAllPermissions\(\["patrols\.view", "exports\.view"\]\)/);
  assert.match(server, /app\.post\("\/admin\/roles", requireAuth, dashboardRbac\.requireSystemOwner/);
});
