const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createDashboardRbac, routePermission } = require("../auth/dashboard-rbac");

const serverSource = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const migrationSource = fs.readFileSync(
  path.join(__dirname, "../database/2026-09-25-temporary-preview-rbac.sql"),
  "utf8"
);

function routeSection(start, end) {
  const from = serverSource.indexOf(start);
  const to = serverSource.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return serverSource.slice(from, to);
}

test("Event Logs history accepts guards.view OR audit_logs.view", () => {
  assert.deepEqual(routePermission("GET", "/guards/shifts/history"), ["guards.view", "audit_logs.view"]);
  const rbac = createDashboardRbac({ pool: { query: async () => ({ rows: [] }) } });
  for (const permission of ["guards.view", "audit_logs.view"]) {
    let allowed = false;
    rbac.enforceRequestPermission(
      { method: "GET", originalUrl: "/guards/shifts/history", auth: { permissions: [permission] } },
      { status() { return this; }, json() { return this; } },
      () => { allowed = true; }
    );
    assert.equal(allowed, true);
  }
  assert.equal(routePermission("GET", "/settings/guards"), "guards.view");
  assert.equal(routePermission("POST", "/settings/guards"), "guards.manage");
});

test("raw QR credential endpoint requires patrols.manage", () => {
  assert.equal(routePermission("GET", "/patrol-points/42/qr"), "patrols.manage");
  assert.equal(routePermission("GET", "/patrols/sites/7/details"), "patrols.view");
  assert.equal(routePermission("GET", "/settings/sites/7/patrol-points"), "patrols.view");
});

test("patrol read endpoints expose only qr_generated metadata", () => {
  const settingsPoints = routeSection(
    '"/settings/sites/:siteId/patrol-points"',
    '"/guard/patrols/board"'
  );
  const siteDetails = routeSection(
    '"/patrols/sites/:siteId/details"',
    'app.get("/patrol-points/:id/qr"'
  );
  assert.match(settingsPoints, /\(qr_token IS NOT NULL\) AS qr_generated/);
  assert.doesNotMatch(settingsPoints, /\n\s*qr_token\s*,/);
  assert.match(siteDetails, /\(qr_token IS NOT NULL\) AS qr_generated/);
  assert.doesNotMatch(siteDetails, /\n\s*qr_token\s*,/);

  const qrEndpoint = routeSection(
    'app.get("/patrol-points/:id/qr"',
    'app.get("/patrols/missed-history"'
  );
  assert.match(qrEndpoint, /pp\.qr_token/);
  assert.match(qrEndpoint, /OR s\.company_id = \$3/);
});

test("revoked Dashboard bearer sessions have a stable invalid-session response", () => {
  assert.match(serverSource, /code: "AUTH_SESSION_INVALID"/);
  assert.match(serverSource, /message: "The Dashboard session is no longer active\."/);
  assert.match(serverSource, /WHERE ads\.session_token = \$1[\s\S]*AND ads\.is_active = true/);
});

test("temporary preview creation maps Supervisor in the same transaction and audits it", () => {
  const creation = routeSection(
    'app.post(\n  "/admin/temporary-access"',
    'app.post(\n  "/admin/temporary-access/:groupId/revoke"'
  );
  const begin = creation.indexOf('client.query("BEGIN")');
  const mapping = creation.indexOf("INSERT INTO user_dashboard_roles");
  const audit = creation.indexOf("temporary_preview_creation");
  const commit = creation.indexOf('client.query("COMMIT")');
  assert.ok(begin >= 0 && mapping > begin && audit > mapping && commit > audit);
  assert.match(creation, /code = 'supervisor'[\s\S]*is_active = TRUE/);
  assert.match(creation, /SUPERVISOR_ROLE_UNAVAILABLE/);
  const guardInsert = creation.indexOf("const guardResult", audit);
  assert.doesNotMatch(creation.slice(audit, guardInsert), /password_hash|dashboardPassword|guardPassword/);
});

test("mapped preview auth context resolves Supervisor permissions but remains read-only", async () => {
  const rbac = createDashboardRbac({
    pool: {
      query: async () => ({
        rows: [{
          role_id: 4,
          role_code: "supervisor",
          role_name: "Supervisor",
          scope: "company",
          is_system_role: true,
          role_version: 1,
          permissions: ["dashboard.view", "patrols.view"],
        }],
      }),
    },
  });
  const auth = { user_id: 21, role: "supervisor", authorization_version: 1, access_mode: "read_only" };
  Object.assign(auth, await rbac.resolveAuthorization(auth));
  assert.equal(auth.role_code, "supervisor");
  assert.deepEqual(auth.permissions, ["dashboard.view", "patrols.view"]);
  assert.equal(auth.access_mode, "read_only");

  const passwordGate = serverSource.indexOf("enforceDashboardPasswordChange(req, res)");
  const authorization = serverSource.indexOf("await dashboardRbac.resolveAuthorization(req.auth)", passwordGate);
  const readOnlyGate = serverSource.indexOf("blockReadOnlyMutation(", authorization);
  const permissionGate = serverSource.indexOf("dashboardRbac.enforceRequestPermission(req, res, next)", readOnlyGate);
  assert.ok(passwordGate >= 0 && authorization > passwordGate && readOnlyGate > authorization && permissionGate > readOnlyGate);
});

test("temporary preview backfill is scoped and idempotent", () => {
  assert.match(migrationSource, /u\.access_mode = 'read_only'/);
  assert.match(migrationSource, /u\.temporary_access_group_id IS NOT NULL/);
  assert.match(migrationSource, /u\.role = 'supervisor'/);
  assert.match(migrationSource, /NOT EXISTS[\s\S]*user_dashboard_roles/);
  assert.match(migrationSource, /ON CONFLICT \(user_id\) DO NOTHING/);
  assert.match(migrationSource, /temporary_preview_backfill/);
});

test("Guard QR scan lifecycle still validates the stored credential", () => {
  const scan = routeSection('app.post("/patrol/scan"', '"/settings/sites/:siteId/patrol-points"');
  assert.match(scan, /requireGuardAuth/);
  assert.match(scan, /String\(patrol\.qr_token\) !== normalizedQrToken/);
});

test("role reassignment and role permission changes revoke active sessions", async () => {
  const queries = [];
  const rbac = createDashboardRbac({ pool: { query: async () => ({ rows: [] }) } });
  await rbac.revokeAuthorizationSessions(
    { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } },
    [31, 32]
  );
  assert.ok(queries.some(({ sql }) => /UPDATE users SET authorization_version/.test(sql)));
  assert.ok(queries.some(({ sql }) => /UPDATE admin_sessions SET is_active = FALSE/.test(sql)));
  assert.ok(queries.some(({ sql }) => /authorization_changed/.test(sql)));

  assert.match(serverSource, /USER_ROLE_CHANGED[\s\S]*revokeAuthorizationSessions\(client, \[userId\]\)/);
  assert.match(serverSource, /SELECT user_id FROM user_dashboard_roles WHERE role_id=\$1[\s\S]*revokeAuthorizationSessions\(client, affected\.rows/);
});
