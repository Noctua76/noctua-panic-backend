const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const databaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL enforces immutable Shift Report content and lifecycle", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await client.query(`
      CREATE TABLE companies (id SERIAL PRIMARY KEY, name TEXT NOT NULL, timezone TEXT);
      CREATE TABLE sites (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL);
      CREATE TABLE guards (id SERIAL PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id), full_name TEXT NOT NULL);
      CREATE TABLE guard_sessions (id SERIAL PRIMARY KEY, guard_id INTEGER NOT NULL REFERENCES guards(id), site_id INTEGER NOT NULL REFERENCES sites(id));
      CREATE TABLE users (id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id), full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer', status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE admin_sessions (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), is_active BOOLEAN DEFAULT TRUE,
        logout_time TIMESTAMPTZ, session_end_reason TEXT);
    `);
    const migration = fs.readFileSync(
      path.join(__dirname, "../database/2026-09-20-shift-reports.sql"),
      "utf8"
    );
    await client.query(migration);
    const guardPasswordMigration = fs.readFileSync(
      path.join(__dirname, "../database/2026-09-21-guard-password-lifecycle.sql"),
      "utf8"
    );
    await client.query(guardPasswordMigration);
    const rbacMigration = fs.readFileSync(
      path.join(__dirname, "../database/2026-09-22-dashboard-rbac.sql"),
      "utf8"
    );
    await client.query(rbacMigration);
    await client.query(`
      INSERT INTO companies (id, name, timezone) VALUES (1, 'Noctua', 'Europe/Athens');
      INSERT INTO sites (id, company_id, name) VALUES (1, 1, 'Ekali');
      INSERT INTO guards (id, site_id, full_name) VALUES (1, 1, 'Guard');
      INSERT INTO guard_sessions (id, guard_id, site_id) VALUES (1, 1, 1);
      INSERT INTO users (id, company_id, full_name) VALUES (1, 1, 'Admin');
      INSERT INTO guard_shift_reports
        (id, report_number, company_id, site_id, guard_id, session_id, category, priority, message)
      VALUES
        (1, 'SR-20260920-000001', 1, 1, 1, 1, 'OBSERVATION', 'NORMAL', 'Original note');
    `);

    await assert.rejects(
      client.query("UPDATE guard_shift_reports SET message='Changed' WHERE id=1"),
      /operational content is immutable/
    );
    await client.query("UPDATE guard_shift_reports SET status='READ', read_at=NOW(), read_by_admin_id=1 WHERE id=1");
    await client.query("UPDATE guard_shift_reports SET status='ACKNOWLEDGED', acknowledged_at=NOW(), acknowledged_by_admin_id=1 WHERE id=1");
    await assert.rejects(
      client.query("UPDATE guard_shift_reports SET status='NEW' WHERE id=1"),
      /Invalid Shift Report status transition/
    );
    await assert.rejects(
      client.query("DELETE FROM guard_shift_reports WHERE id=1"),
      /immutable and cannot be deleted/
    );

    await client.query(`
      INSERT INTO guard_shift_report_attachments
        (report_id, company_id, storage_path, original_filename, mime_type, file_size)
      VALUES (1, 1, 'company-1/site-1/report-1/photo.jpg', 'photo.jpg', 'image/jpeg', 4)
    `);
    await assert.rejects(
      client.query("DELETE FROM guard_shift_report_attachments WHERE report_id=1"),
      /attachments and audit events are immutable/
    );

    const state = await client.query(
      "SELECT status, read_by_admin_id, acknowledged_by_admin_id FROM guard_shift_reports WHERE id=1"
    );
    assert.deepEqual(state.rows[0], {
      status: "ACKNOWLEDGED",
      read_by_admin_id: 1,
      acknowledged_by_admin_id: 1,
    });

    const passwordState = await client.query(
      "SELECT must_change_password FROM guards WHERE id=1"
    );
    assert.equal(passwordState.rows[0].must_change_password, false);

    await client.query(`
      INSERT INTO guard_password_audit_events
        (company_id, site_id, guard_id, actor_user_id, event_type)
      VALUES (1, 1, 1, 1, 'GUARD_PASSWORD_RESET')
    `);
    await assert.rejects(
      client.query("DELETE FROM guard_password_audit_events WHERE guard_id=1"),
      /Guard password audit events are immutable/
    );

    const roleState = await client.query(
      `SELECT r.code, array_agg(p.code ORDER BY p.code) AS permissions
       FROM dashboard_roles r JOIN dashboard_role_permissions rp ON rp.role_id=r.id
       JOIN dashboard_permissions p ON p.id=rp.permission_id
       WHERE r.code='viewer' GROUP BY r.code`
    );
    assert.equal(roleState.rows[0].code, "viewer");
    assert.ok(roleState.rows[0].permissions.includes("dashboard.view"));
    assert.equal(roleState.rows[0].permissions.includes("users.manage"), false);

    await client.query(
      `INSERT INTO dashboard_rbac_audit_events(event_type, actor_user_id, company_id)
       VALUES('ROLE_CREATED', 1, 1)`
    );
    await assert.rejects(
      client.query("DELETE FROM dashboard_rbac_audit_events"),
      /Dashboard RBAC audit events are immutable/
    );
  } finally {
    await client.end();
  }
});
