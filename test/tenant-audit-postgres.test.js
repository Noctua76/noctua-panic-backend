const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { recordTenantAudit } = require("../auth/tenant-context");

test("mutation audit migration accepts correlated append-only events and preserves immutability", {
  skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL is not configured",
}, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  const schema = `tenant_audit_${crypto.randomBytes(8).toString("hex")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(`CREATE TABLE system_owner_tenant_access_audit (
      id BIGSERIAL PRIMARY KEY, session_id INTEGER, actor_user_id INTEGER,
      actor_username TEXT, actor_home_company_id INTEGER, target_company_id INTEGER,
      event_type VARCHAR(60) CHECK (event_type IN ('TENANT_MUTATION')),
      mode TEXT, reason TEXT, request_method TEXT, request_path TEXT,
      response_status INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE FUNCTION prevent_system_owner_tenant_audit_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'audit is immutable';
      END $$`);
    await client.query(`CREATE TRIGGER system_owner_tenant_access_audit_immutable
      BEFORE UPDATE OR DELETE ON system_owner_tenant_access_audit
      FOR EACH ROW EXECUTE FUNCTION prevent_system_owner_tenant_audit_mutation()`);

    const migration = fs.readFileSync(path.join(__dirname,
      "../database/2026-09-30-system-owner-mutation-audit.sql"), "utf8");
    await client.query(migration);
    const auth = { session_id: 12, user_id: 3, username: "owner", actor_company_id: 1,
      tenant_context_mode: "administrative", tenant_context_reason: "Review" };
    const requestId = crypto.randomUUID();
    await recordTenantAudit(client, auth, "TENANT_MUTATION_ATTEMPT", 8, "POST", "/settings/sites/8", null,
      "administrative", "Review", requestId);
    await recordTenantAudit(client, auth, "TENANT_MUTATION_RESULT", 8, "POST", "/settings/sites/8", 200,
      "administrative", "Review", requestId);
    await recordTenantAudit(client, auth, "TENANT_MUTATION", 8, "POST", "/settings/sites/8", 200,
      "administrative", "Review", null);
    const rows = await client.query(`SELECT event_type, request_id, response_status
      FROM system_owner_tenant_access_audit ORDER BY id`);
    assert.deepEqual(rows.rows.map(row => row.event_type),
      ["TENANT_MUTATION_ATTEMPT", "TENANT_MUTATION_RESULT", "TENANT_MUTATION"]);
    assert.equal(rows.rows[0].request_id, requestId);
    assert.equal(rows.rows[1].request_id, requestId);
    assert.equal(rows.rows[1].response_status, 200);

    await client.query("SAVEPOINT invalid_type");
    await assert.rejects(client.query(`INSERT INTO system_owner_tenant_access_audit (event_type)
      VALUES ('UNKNOWN')`), { code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT invalid_type");
    for (const statement of [
      "UPDATE system_owner_tenant_access_audit SET response_status=500 WHERE id=1",
      "DELETE FROM system_owner_tenant_access_audit WHERE id=1",
    ]) {
      await client.query("SAVEPOINT immutable_row");
      await assert.rejects(client.query(statement), /audit is immutable/);
      await client.query("ROLLBACK TO SAVEPOINT immutable_row");
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
});
