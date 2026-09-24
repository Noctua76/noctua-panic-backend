const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const {
  resolveTenantContext, canMutateTenantRequest, createTenantContextRouter,
} = require("../auth/tenant-context");

const actor = { role: "system_owner", is_system_owner: true, session_id: 12, user_id: 3,
  username: "owner", company_id: 1, actor_company_id: 1, company_name: "Home" };

test("canonical context retains actor company and resolves effective tenant from session", () => {
  const home = resolveTenantContext(actor);
  assert.equal(home.effective_company_id, 1);
  const target = resolveTenantContext({ ...actor, tenant_context_company_id: 8,
    tenant_context_company_name: "Tenant", tenant_context_company_status: "pilot",
    tenant_context_mode: "read_only" });
  assert.equal(target.actor_company_id, 1);
  assert.equal(target.effective_company_id, 8);
  assert.equal(target.tenant_context_can_mutate, false);
  const elevated = resolveTenantContext({ ...actor, tenant_context_company_id: 8,
    tenant_context_company_name: "Tenant", tenant_context_company_status: "active",
    tenant_context_mode: "administrative",
    tenant_context_elevated_until: new Date(Date.now() + 60000) });
  assert.equal(elevated.tenant_context_can_mutate, true);
  const expired = resolveTenantContext({ ...actor, tenant_context_company_id: 8,
    tenant_context_company_name: "Tenant", tenant_context_company_status: "active",
    tenant_context_mode: "administrative",
    tenant_context_elevated_until: new Date(Date.now() - 1000) });
  assert.equal(expired.tenant_context_mode, "read_only");
  assert.equal(expired.tenant_context_can_mutate, false);
  assert.equal(resolveTenantContext({ ...actor, role: "company_administrator", tenant_context_company_id: 8 }).effective_company_id, 1);
  assert.throws(() => resolveTenantContext({ ...actor, tenant_context_company_id: 9 }), /unavailable/);
});

test("read-only mode denies direct mutations and keeps session/context exits available", () => {
  const auth = { tenant_context_active: true, tenant_context_can_mutate: false };
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(canMutateTenantRequest(auth, method, "/settings/sites/2"), false);
    assert.equal(canMutateTenantRequest(auth, method, "/admin/users/99"), false);
  }
  assert.equal(canMutateTenantRequest(auth, "GET", "/sites"), true);
  assert.equal(canMutateTenantRequest(auth, "POST", "/admin/tenant-context/exit"), true);
  assert.equal(canMutateTenantRequest(auth, "POST", "/admin/tenant-context/elevate"), true);
  assert.equal(canMutateTenantRequest({ ...auth, tenant_context_can_mutate: true }, "DELETE", "/settings/sites/2"), true);
});

test("context API changes only the session, always enters read-only, audits lifecycle without secrets", async () => {
  const queries = [];
  const state = { ...actor, tenant_context_active: false };
  const client = { query: async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.startsWith("SELECT id FROM companies")) return { rows: values[0] === 8 ? [{ id: 8 }] : [] };
    if (sql.includes("RETURNING ads.tenant_context_company_id")) {
      return { rows: state.tenant_context_company_status === "inactive" ? [] : [{ tenant_context_company_id: 8 }] };
    }
    return { rows: [{ id: 12 }] };
  }, release() {} };
  const app = express();
  app.use(express.json());
  app.use(createTenantContextRouter({ pool: { connect: async () => client },
    requireAuth: (req, _res, next) => { req.auth = state; next(); } }));
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const post = async (endpoint, body = {}) => {
      const response = await fetch(`${url}/admin/tenant-context/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return { code: response.status, data: await response.json() };
    };
    assert.equal((await post("enter", { company_id: 0 })).code, 400);
    assert.equal((await post("enter", { company_id: 99 })).code, 404);
    assert.equal((await post("enter", { company_id: 8 })).code, 200);
    assert.match(queries.find(q => q.sql.includes("tenant_context_mode='read_only'")).sql, /tenant_context_elevated_until=NULL/);
    assert.equal(queries.some(q => /UPDATE users|SET company_id=/.test(q.sql)), false);
    state.tenant_context_active = true;
    state.tenant_context_company_id = 8;
    assert.equal((await post("elevate", { reason: "   " })).code, 400);
    state.tenant_context_company_status = "inactive";
    assert.equal((await post("elevate", { reason: "Investigate" })).data.code, "COMPANY_INACTIVE");
    state.tenant_context_company_status = "pilot";
    assert.equal((await post("elevate", { reason: "Investigate" })).code, 200);
    assert.ok(queries.some(q => q.sql.includes("INTERVAL '30 minutes'")));
    assert.equal((await post("exit")).code, 200);
    const audit = queries.filter(q => q.sql.includes("INSERT INTO system_owner_tenant_access_audit"));
    assert.deepEqual(audit.map(q => q.values[5]), ["TENANT_CONTEXT_ENTERED", "TENANT_ADMIN_ACCESS_ENABLED", "TENANT_CONTEXT_EXITED"]);
    assert.equal(audit.every(q => !JSON.stringify(q).includes("authorization")), true);
    state.is_system_owner = false;
    assert.equal((await post("enter", { company_id: 8 })).code, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("tenant audit storage rejects updates and deletes", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../database/2026-09-29-system-owner-tenant-context.sql"), "utf8");
  assert.match(sql, /BEFORE UPDATE OR DELETE ON system_owner_tenant_access_audit/);
  assert.match(sql, /tenant_context_company_id INTEGER REFERENCES companies\(id\) ON DELETE SET NULL/);
});
