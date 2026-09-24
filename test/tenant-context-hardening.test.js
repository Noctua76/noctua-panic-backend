const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { enforceTenantContextBoundary } = require("../auth/tenant-context");
const { createDashboardRbac, routePermission } = require("../auth/dashboard-rbac");

const owner = {
  session_id: 12, user_id: 3, username: "owner", actor_company_id: 1,
  effective_company_id: 8, tenant_context_active: true, tenant_context_can_mutate: false,
  tenant_context_mode: "read_only", tenant_context_reason: "Investigate tenant",
  is_system_owner: true, permissions: ["*"],
};

async function withApp(auth, options, run) {
  const queries = [];
  let executed = 0;
  let attemptSeenByHandler = false;
  const pool = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (options?.failAttempt && values[5] === "TENANT_MUTATION_ATTEMPT") throw new Error("audit unavailable");
    return { rows: [] };
  } };
  const rbac = createDashboardRbac({ pool });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { ...auth }; next(); });
  app.use(async (req, res, next) => {
    const requestPath = (req.originalUrl || "").split("?")[0];
    if (await enforceTenantContextBoundary(req, res, pool, requestPath)) return;
    rbac.enforceRequestPermission(req, res, next);
  });
  app.get("/admin/roles", (_req, res) => res.json({ status: "ok" }));
  app.get("/admin/roles/permissions", (_req, res) => res.json({ status: "ok" }));
  app.get("/patrol-points/:id/qr", (_req, res) => res.json({ status: "ok" }));
  app.get("/patrols/sites/:siteId/details", (_req, res) => res.json({ status: "ok" }));
  app.get("/settings/sites/:siteId/patrol-points", (_req, res) => res.json({ status: "ok" }));
  app.post("/settings/sites/:siteId", (_req, res) => {
    executed += 1;
    attemptSeenByHandler = queries.some(q => q.values[5] === "TENANT_MUTATION_ATTEMPT");
    res.status(options?.routeStatus || 200).json({ status: "ok" });
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, method = "GET", body) => {
    const response = await fetch(base + route, {
      method, headers: { "Content-Type": "application/json", Authorization: "Bearer secret-header" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ request, queries, getExecuted: () => executed, getAttemptSeen: () => attemptSeenByHandler }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("all platform role reads are blocked in either tenant mode, while home and company access retain RBAC", async () => {
  for (const canMutate of [false, true]) {
    await withApp({ ...owner, tenant_context_can_mutate: canMutate }, {}, async ({ request, queries }) => {
      for (const route of ["/admin/roles", "/admin/roles/permissions"]) {
        const response = await request(route);
        assert.equal(response.status, 403);
        assert.equal(response.body.code, "PLATFORM_CONTROL_UNAVAILABLE_IN_TENANT");
      }
      assert.equal(queries.length, 0);
    });
  }
  await withApp({ ...owner, tenant_context_active: false }, {}, async ({ request }) => {
    assert.equal((await request("/admin/roles")).status, 200);
  });
  await withApp({ ...owner, is_system_owner: false, tenant_context_active: false,
    permissions: ["roles.view"] }, {}, async ({ request }) => {
    assert.equal((await request("/admin/roles")).status, 200);
  });
});

test("read-only tenant inspection excludes raw QR but allows informational patrol endpoints", async () => {
  await withApp(owner, {}, async ({ request }) => {
    const qr = await request("/patrol-points/42/qr");
    assert.equal(qr.status, 403);
    assert.equal(qr.body.code, "TENANT_CONTEXT_READ_ONLY");
    assert.equal((await request("/patrols/sites/7/details")).status, 200);
    assert.equal((await request("/settings/sites/7/patrol-points")).status, 200);
  });
  await withApp({ ...owner, tenant_context_can_mutate: true }, {}, async ({ request }) => {
    assert.equal((await request("/patrol-points/42/qr")).status, 200);
  });
  assert.equal(routePermission("GET", "/patrol-points/42/qr"), "patrols.manage");
  const rbac = createDashboardRbac({ pool: { query: async () => ({ rows: [] }) } });
  for (const permissions of [["patrols.view"], ["patrols.manage"]]) {
    let allowed = false;
    rbac.enforceRequestPermission(
      { method: "GET", originalUrl: "/patrol-points/42/qr", auth: { permissions } },
      { status(code) { assert.equal(code, 403); return this; }, json() {} },
      () => { allowed = true; }
    );
    assert.equal(allowed, permissions.includes("patrols.manage"));
  }
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const qrRoute = source.slice(source.indexOf('app.get("/patrol-points/:id/qr"'), source.indexOf("async function reverseGeocode"));
  assert.match(qrRoute, /AND s\.company_id = \$3/);
  assert.match(qrRoute, /req\.auth\.effective_company_id/);
});

test("mutation attempt is durable before the handler; success and failure results share the request ID", async () => {
  for (const routeStatus of [200, 422]) {
    await withApp({ ...owner, tenant_context_can_mutate: true }, { routeStatus }, async (state) => {
      const result = await state.request("/settings/sites/8?token=secret-query", "POST", { password: "secret-body" });
      assert.equal(result.status, routeStatus);
      assert.equal(state.getExecuted(), 1);
      assert.equal(state.getAttemptSeen(), true);
      const audits = state.queries.filter(q => q.sql.includes("INSERT INTO system_owner_tenant_access_audit"));
      assert.deepEqual(audits.map(q => q.values[5]), ["TENANT_MUTATION_ATTEMPT", "TENANT_MUTATION_RESULT"]);
      assert.match(audits[0].values[11], /^[0-9a-f-]{36}$/);
      assert.equal(audits[0].values[11], audits[1].values[11]);
      assert.equal(audits[0].values[10], null);
      assert.equal(audits[1].values[10], routeStatus);
      assert.deepEqual(audits[0].values.slice(1, 10),
        [3, "owner", 1, 8, "TENANT_MUTATION_ATTEMPT", "administrative", "Investigate tenant", "POST", "/settings/sites/8"]);
      assert.doesNotMatch(JSON.stringify(audits), /secret-body|secret-query|secret-header|Authorization|qr_token/);
    });
  }
});

test("failed pre-action audit returns 503 without executing the operational handler", async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args); };
  try {
    await withApp({ ...owner, tenant_context_can_mutate: true }, { failAttempt: true }, async (state) => {
      const response = await state.request("/settings/sites/8", "POST", { password: "secret-body" });
      assert.equal(response.status, 503);
      assert.equal(response.body.code, "TENANT_AUDIT_UNAVAILABLE");
      assert.equal(state.getExecuted(), 0);
      assert.deepEqual(state.queries.map(q => q.values[5]), ["TENANT_MUTATION_ATTEMPT"]);
    });
    assert.ok(logs.some(args => String(args[0]).includes("CRITICAL")));
  } finally { console.error = originalError; }
});

test("append-only migration preserves legacy events and immutable audit trigger", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../database/2026-09-30-system-owner-mutation-audit.sql"), "utf8");
  const original = fs.readFileSync(path.join(__dirname, "../database/2026-09-29-system-owner-tenant-context.sql"), "utf8");
  const module = fs.readFileSync(path.join(__dirname, "../auth/tenant-context.js"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS request_id VARCHAR\(64\)/);
  for (const event of ["TENANT_MUTATION", "TENANT_MUTATION_ATTEMPT", "TENANT_MUTATION_RESULT"]) {
    assert.match(sql, new RegExp(`'${event}'`));
  }
  assert.match(original, /BEFORE UPDATE OR DELETE ON system_owner_tenant_access_audit/);
  assert.doesNotMatch(module, /recordTenantAudit\([^\n]*"TENANT_MUTATION"[,)]/);
  assert.match(sourceOfRequireAuth(), /await enforceTenantContextBoundary\(req, res, pool, requestPath\)/);
});

function sourceOfRequireAuth() {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  return source.slice(source.indexOf("async function requireAuth"), source.indexOf("async function requireGuardAuth"));
}
