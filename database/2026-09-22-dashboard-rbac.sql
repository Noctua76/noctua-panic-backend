ALTER TABLE users
  ADD COLUMN IF NOT EXISTS authorization_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE admin_sessions
  DROP CONSTRAINT IF EXISTS admin_sessions_session_end_reason_check;
ALTER TABLE admin_sessions
  ADD CONSTRAINT admin_sessions_session_end_reason_check CHECK (
    session_end_reason IS NULL OR session_end_reason IN (
      'logout', 'temporary_access_expired', 'temporary_access_revoked', 'authorization_changed'
    )
  );

CREATE TABLE IF NOT EXISTS dashboard_roles (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(96) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope VARCHAR(24) NOT NULL DEFAULT 'company',
  is_system_role BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  authorization_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dashboard_roles_scope_chk CHECK (scope IN ('platform', 'company'))
);

CREATE TABLE IF NOT EXISTS dashboard_permissions (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(120) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_role_permissions (
  role_id BIGINT NOT NULL REFERENCES dashboard_roles(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES dashboard_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_dashboard_roles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role_id BIGINT NOT NULL REFERENCES dashboard_roles(id),
  assigned_by INTEGER REFERENCES users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dashboard_rbac_audit_events (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  target_user_id INTEGER REFERENCES users(id),
  role_id BIGINT REFERENCES dashboard_roles(id),
  company_id INTEGER REFERENCES companies(id),
  before_state JSONB,
  after_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dashboard_rbac_audit_event_chk CHECK (event_type IN (
    'ROLE_CREATED', 'ROLE_UPDATED', 'ROLE_DEACTIVATED',
    'ROLE_PERMISSION_CHANGED', 'USER_ROLE_ASSIGNED', 'USER_ROLE_CHANGED'
  ))
);

CREATE INDEX IF NOT EXISTS dashboard_role_permissions_permission_idx
  ON dashboard_role_permissions(permission_id);
CREATE INDEX IF NOT EXISTS user_dashboard_roles_role_idx
  ON user_dashboard_roles(role_id);
CREATE INDEX IF NOT EXISTS dashboard_rbac_audit_created_idx
  ON dashboard_rbac_audit_events(created_at DESC);

CREATE OR REPLACE FUNCTION prevent_dashboard_rbac_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Dashboard RBAC audit events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS dashboard_rbac_audit_immutable_trigger
  ON dashboard_rbac_audit_events;
CREATE TRIGGER dashboard_rbac_audit_immutable_trigger
  BEFORE UPDATE OR DELETE ON dashboard_rbac_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_dashboard_rbac_audit_mutation();

INSERT INTO dashboard_permissions (code, name, category) VALUES
  ('dashboard.view', 'View dashboard', 'Dashboard'),
  ('incidents.view', 'View incidents', 'Incidents'),
  ('incidents.manage', 'Manage incidents', 'Incidents'),
  ('shift_reports.view', 'View shift reports', 'Shift Reports'),
  ('shift_reports.read', 'Mark shift reports read', 'Shift Reports'),
  ('shift_reports.acknowledge', 'Acknowledge shift reports', 'Shift Reports'),
  ('guards.view', 'View guards', 'Guards'),
  ('guards.manage', 'Manage guards', 'Guards'),
  ('guards.reset_password', 'Reset guard passwords', 'Guards'),
  ('sites.view', 'View sites', 'Sites'),
  ('sites.manage', 'Manage sites', 'Sites'),
  ('patrols.view', 'View patrols', 'Patrols'),
  ('patrols.manage', 'Manage patrols', 'Patrols'),
  ('patrols.correct', 'Correct patrol history', 'Patrols'),
  ('alerts.view', 'View alerts', 'Alerts'),
  ('alerts.manage', 'Manage alerts', 'Alerts'),
  ('analytics.view', 'View analytics', 'Analytics'),
  ('audit_logs.view', 'View audit logs', 'Audit'),
  ('users.view', 'View dashboard users', 'Users'),
  ('users.manage', 'Manage dashboard users', 'Users'),
  ('users.reset_password', 'Reset dashboard user passwords', 'Users'),
  ('roles.view', 'View dashboard roles', 'Roles'),
  ('roles.manage', 'Manage dashboard roles', 'Roles'),
  ('system_status.tenant', 'View tenant system status', 'System Status'),
  ('system_status.global', 'View global system status', 'System Status'),
  ('temporary_access.manage', 'Manage temporary preview access', 'Temporary Access'),
  ('exports.view', 'Generate and download exports', 'Exports')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category;

INSERT INTO dashboard_roles (code, name, description, scope, is_system_role) VALUES
  ('system_owner', 'System Owner', 'Protected platform owner role.', 'platform', TRUE),
  ('company_administrator', 'Company Administrator', 'Tenant-scoped administration.', 'company', TRUE),
  ('operations_manager', 'Operations Manager', 'Operational management without user administration.', 'company', TRUE),
  ('supervisor', 'Supervisor', 'Operational supervisory access.', 'company', TRUE),
  ('viewer', 'Viewer / Auditor', 'Read-only operational and audit visibility.', 'company', TRUE)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  scope = EXCLUDED.scope,
  is_system_role = TRUE;

WITH role_matrix(role_code, permission_code) AS (VALUES
  ('company_administrator','dashboard.view'),('company_administrator','incidents.view'),('company_administrator','incidents.manage'),
  ('company_administrator','shift_reports.view'),('company_administrator','shift_reports.read'),('company_administrator','shift_reports.acknowledge'),
  ('company_administrator','guards.view'),('company_administrator','guards.manage'),('company_administrator','guards.reset_password'),
  ('company_administrator','sites.view'),('company_administrator','sites.manage'),('company_administrator','patrols.view'),
  ('company_administrator','patrols.manage'),('company_administrator','alerts.view'),('company_administrator','alerts.manage'),
  ('company_administrator','analytics.view'),('company_administrator','audit_logs.view'),('company_administrator','users.view'),
  ('company_administrator','users.manage'),('company_administrator','users.reset_password'),('company_administrator','system_status.tenant'),
  ('company_administrator','exports.view'),
  ('operations_manager','dashboard.view'),('operations_manager','incidents.view'),('operations_manager','incidents.manage'),
  ('operations_manager','shift_reports.view'),('operations_manager','shift_reports.read'),('operations_manager','shift_reports.acknowledge'),
  ('operations_manager','guards.view'),('operations_manager','sites.view'),('operations_manager','patrols.view'),
  ('operations_manager','patrols.manage'),('operations_manager','alerts.view'),('operations_manager','alerts.manage'),
  ('operations_manager','analytics.view'),('operations_manager','audit_logs.view'),('operations_manager','system_status.tenant'),
  ('operations_manager','exports.view'),
  ('supervisor','dashboard.view'),('supervisor','incidents.view'),('supervisor','incidents.manage'),
  ('supervisor','shift_reports.view'),('supervisor','shift_reports.read'),('supervisor','shift_reports.acknowledge'),
  ('supervisor','guards.view'),('supervisor','sites.view'),('supervisor','patrols.view'),('supervisor','analytics.view'),
  ('supervisor','audit_logs.view'),('supervisor','system_status.tenant'),('supervisor','exports.view'),
  ('viewer','dashboard.view'),('viewer','incidents.view'),('viewer','shift_reports.view'),('viewer','guards.view'),
  ('viewer','sites.view'),('viewer','patrols.view'),('viewer','analytics.view'),('viewer','audit_logs.view'),
  ('viewer','system_status.tenant'),('viewer','exports.view')
)
INSERT INTO dashboard_role_permissions(role_id, permission_id)
SELECT r.id, p.id FROM role_matrix m
JOIN dashboard_roles r ON r.code = m.role_code
JOIN dashboard_permissions p ON p.code = m.permission_code
ON CONFLICT DO NOTHING;

INSERT INTO dashboard_role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM dashboard_roles r CROSS JOIN dashboard_permissions p
WHERE r.code = 'system_owner'
ON CONFLICT DO NOTHING;

INSERT INTO user_dashboard_roles(user_id, role_id)
SELECT u.id, r.id FROM users u
JOIN dashboard_roles r ON r.code = u.role
WHERE u.role IN ('system_owner', 'supervisor', 'company_administrator', 'operations_manager', 'viewer')
ON CONFLICT (user_id) DO NOTHING;
