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
        username TEXT, email TEXT, phone TEXT, password_hash TEXT,
        must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
        role TEXT NOT NULL DEFAULT 'viewer', status TEXT NOT NULL DEFAULT 'active', updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE admin_sessions (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), is_active BOOLEAN DEFAULT TRUE,
        session_token TEXT, login_time TIMESTAMPTZ DEFAULT NOW(), logout_time TIMESTAMPTZ,
        session_duration_seconds INTEGER, session_end_reason TEXT);
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
    const passwordResetSessionMigration = fs.readFileSync(
      path.join(__dirname, "../database/2026-09-24-dashboard-password-reset-sessions.sql"),
      "utf8"
    );
    await client.query(passwordResetSessionMigration);
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

    await client.query(`
      INSERT INTO users (id, company_id, full_name, username, password_hash)
      VALUES (2, 1, 'Target Admin', 'target_admin', 'old-hash');
      INSERT INTO admin_sessions (user_id, session_token, login_time, is_active)
      VALUES (2, 'old-token-1', NOW() - INTERVAL '10 minutes', TRUE),
             (2, 'old-token-2', NOW() - INTERVAL '5 minutes', TRUE);
    `);
    const { resetDashboardUserPassword } = require("../auth/dashboard-user-password-reset");
    const resetResult = await resetDashboardUserPassword({
      pool: { connect: async () => ({ query: client.query.bind(client), release() {} }) },
      userId: 2,
      companyId: 1,
      actorUserId: 1,
      actorIsSystemOwner: true,
      passwordHash: 'new-hash',
    });
    assert.equal(resetResult.revokedSessionCount, 2);
    const revoked = await client.query(
      `SELECT is_active, session_end_reason, logout_time IS NOT NULL AS has_logout,
              session_duration_seconds >= 0 AS valid_duration
       FROM admin_sessions WHERE user_id = 2 ORDER BY id`
    );
    assert.deepEqual(revoked.rows, [
      { is_active: false, session_end_reason: "password_reset", has_logout: true, valid_duration: true },
      { is_active: false, session_end_reason: "password_reset", has_logout: true, valid_duration: true },
    ]);
    const oldToken = await client.query(
      `SELECT id FROM admin_sessions WHERE session_token = $1 AND is_active = TRUE`,
      ['old-token-1']
    );
    assert.equal(oldToken.rowCount, 0);
    const resetAudit = await client.query(
      `SELECT actor_user_id, target_user_id, after_state, created_at IS NOT NULL AS has_timestamp
       FROM dashboard_rbac_audit_events WHERE event_type = 'USER_PASSWORD_RESET'`
    );
    assert.deepEqual(resetAudit.rows[0], {
      actor_user_id: 1,
      target_user_id: 2,
      after_state: { revoked_session_count: 2 },
      has_timestamp: true,
    });
  } finally {
    await client.end();
  }
});
