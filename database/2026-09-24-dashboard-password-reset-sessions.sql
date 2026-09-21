ALTER TABLE admin_sessions
  DROP CONSTRAINT IF EXISTS admin_sessions_session_end_reason_check;

ALTER TABLE admin_sessions
  ADD CONSTRAINT admin_sessions_session_end_reason_check CHECK (
    session_end_reason IS NULL OR session_end_reason IN (
      'logout',
      'temporary_access_expired',
      'temporary_access_revoked',
      'authorization_changed',
      'password_reset'
    )
  );

COMMENT ON COLUMN admin_sessions.session_end_reason IS
  'Reason the admin session ended: logout, temporary_access_expired, temporary_access_revoked, authorization_changed, or password_reset';

ALTER TABLE dashboard_rbac_audit_events
  DROP CONSTRAINT IF EXISTS dashboard_rbac_audit_event_chk;

ALTER TABLE dashboard_rbac_audit_events
  ADD CONSTRAINT dashboard_rbac_audit_event_chk CHECK (event_type IN (
    'ROLE_CREATED',
    'ROLE_UPDATED',
    'ROLE_DEACTIVATED',
    'ROLE_PERMISSION_CHANGED',
    'USER_ROLE_ASSIGNED',
    'USER_ROLE_CHANGED',
    'USER_PASSWORD_RESET'
  ));
