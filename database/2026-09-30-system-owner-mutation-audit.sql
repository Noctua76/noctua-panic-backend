ALTER TABLE system_owner_tenant_access_audit
  ADD COLUMN IF NOT EXISTS request_id VARCHAR(64);

ALTER TABLE system_owner_tenant_access_audit
  DROP CONSTRAINT IF EXISTS system_owner_tenant_access_audit_event_type_check;

ALTER TABLE system_owner_tenant_access_audit
  ADD CONSTRAINT system_owner_tenant_access_audit_event_type_check
  CHECK (event_type IN (
    'TENANT_CONTEXT_ENTERED', 'TENANT_ADMIN_ACCESS_ENABLED',
    'TENANT_ADMIN_ACCESS_EXPIRED', 'TENANT_CONTEXT_EXITED',
    'TENANT_MUTATION', 'TENANT_MUTATION_ATTEMPT', 'TENANT_MUTATION_RESULT'
  ));

CREATE INDEX IF NOT EXISTS system_owner_tenant_access_audit_request_idx
  ON system_owner_tenant_access_audit(request_id)
  WHERE request_id IS NOT NULL;
