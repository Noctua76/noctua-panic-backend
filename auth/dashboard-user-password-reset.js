async function resetDashboardUserPassword({
  pool,
  userId,
  companyId,
  actorUserId,
  actorIsSystemOwner,
  passwordHash,
  invalidateUser = () => {},
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const targetResult = await client.query(
      `SELECT u.id, COALESCE(r.code, u.role) AS role_code
       FROM users u
       LEFT JOIN user_dashboard_roles ur ON ur.user_id = u.id
       LEFT JOIN dashboard_roles r ON r.id = ur.role_id
       WHERE u.id = $1 AND u.company_id = $2
       FOR UPDATE OF u`,
      [userId, companyId]
    );

    if (!targetResult.rows.length) {
      const error = new Error("User not found");
      error.statusCode = 404;
      throw error;
    }

    if (!actorIsSystemOwner && targetResult.rows[0].role_code === "system_owner") {
      const error = new Error("Company Administrator cannot reset a System Owner password");
      error.statusCode = 403;
      throw error;
    }

    const result = await client.query(
      `UPDATE users
       SET password_hash = $1,
           must_change_password = TRUE,
           authorization_version = authorization_version + 1,
           updated_at = NOW()
       WHERE id = $2 AND company_id = $3
       RETURNING id, full_name, username, email, phone, role, status,
                 must_change_password, company_id`,
      [passwordHash, userId, companyId]
    );

    const revokedSessions = await client.query(
      `UPDATE admin_sessions
       SET is_active = FALSE,
           logout_time = NOW(),
           session_duration_seconds = EXTRACT(EPOCH FROM (NOW() - login_time))::int,
           session_end_reason = 'password_reset'
       WHERE user_id = $1 AND is_active = TRUE
       RETURNING id`,
      [userId]
    );

    await client.query(
      `INSERT INTO dashboard_rbac_audit_events
         (event_type, actor_user_id, target_user_id, company_id, after_state)
       VALUES ('USER_PASSWORD_RESET', $1, $2, $3, $4::jsonb)`,
      [actorUserId, userId, companyId, JSON.stringify({
        revoked_session_count: revokedSessions.rowCount,
      })]
    );

    await client.query("COMMIT");
    invalidateUser(userId);
    return { user: result.rows[0], revokedSessionCount: revokedSessions.rowCount };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { resetDashboardUserPassword };
