ALTER TABLE admin_sessions
  ADD COLUMN IF NOT EXISTS tenant_context_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tenant_context_mode VARCHAR(24),
  ADD COLUMN IF NOT EXISTS tenant_context_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tenant_context_elevated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tenant_context_elevated_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tenant_context_reason TEXT;

ALTER TABLE admin_sessions
  ADD CONSTRAINT tenant_context_mode_check
  CHECK (tenant_context_mode IS NULL OR tenant_context_mode IN ('read_only', 'administrative'));

CREATE TABLE system_owner_tenant_access_audit (
  id BIGSERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  actor_username VARCHAR(180) NOT NULL,
  actor_home_company_id INTEGER NOT NULL,
  target_company_id INTEGER NOT NULL,
  event_type VARCHAR(60) NOT NULL CHECK (event_type IN (
    'TENANT_CONTEXT_ENTERED', 'TENANT_ADMIN_ACCESS_ENABLED',
    'TENANT_ADMIN_ACCESS_EXPIRED', 'TENANT_CONTEXT_EXITED', 'TENANT_MUTATION'
  )),
  mode VARCHAR(24),
  reason TEXT,
  request_method VARCHAR(12),
  request_path TEXT,
  response_status INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX system_owner_tenant_access_audit_target_idx
  ON system_owner_tenant_access_audit(target_company_id, created_at DESC);
CREATE OR REPLACE FUNCTION prevent_system_owner_tenant_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'System Owner tenant access audit is immutable';
END;
$$;
CREATE TRIGGER system_owner_tenant_access_audit_immutable
  BEFORE UPDATE OR DELETE ON system_owner_tenant_access_audit
  FOR EACH ROW EXECUTE FUNCTION prevent_system_owner_tenant_audit_mutation();
