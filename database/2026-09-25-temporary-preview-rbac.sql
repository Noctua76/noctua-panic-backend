-- Explicitly map legacy temporary Dashboard preview users to the active
-- Supervisor RBAC role. The predicates intentionally exclude standard users.
WITH supervisor_role AS (
  SELECT id
  FROM dashboard_roles
  WHERE code = 'supervisor'
    AND is_active = TRUE
  LIMIT 1
), inserted_mappings AS (
  INSERT INTO user_dashboard_roles (user_id, role_id, assigned_by)
  SELECT u.id, sr.id, NULL
  FROM users u
  CROSS JOIN supervisor_role sr
  WHERE u.access_mode = 'read_only'
    AND u.temporary_access_group_id IS NOT NULL
    AND u.role = 'supervisor'
    AND NOT EXISTS (
      SELECT 1
      FROM user_dashboard_roles existing
      WHERE existing.user_id = u.id
    )
  ON CONFLICT (user_id) DO NOTHING
  RETURNING user_id, role_id
)
INSERT INTO dashboard_rbac_audit_events (
  event_type,
  actor_user_id,
  target_user_id,
  role_id,
  company_id,
  before_state,
  after_state
)
SELECT
  'USER_ROLE_ASSIGNED',
  NULL,
  mapping.user_id,
  mapping.role_id,
  u.company_id,
  NULL,
  jsonb_build_object(
    'role_code', 'supervisor',
    'source', 'temporary_preview_backfill',
    'access_mode', 'read_only'
  )
FROM inserted_mappings mapping
JOIN users u ON u.id = mapping.user_id;
