ALTER TABLE guards
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS temporary_password_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS temporary_password_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_setup_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS password_setup_token_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS guard_password_audit_events (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  guard_id INTEGER NOT NULL REFERENCES guards(id),
  actor_user_id INTEGER REFERENCES users(id),
  event_type VARCHAR(48) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT guard_password_audit_event_type_chk CHECK (
    event_type IN (
      'GUARD_TEMP_PASSWORD_ISSUED',
      'GUARD_PASSWORD_CHANGED',
      'GUARD_PASSWORD_RESET'
    )
  )
);

CREATE INDEX IF NOT EXISTS guard_password_audit_guard_idx
  ON guard_password_audit_events (guard_id, created_at DESC);

CREATE INDEX IF NOT EXISTS guard_password_audit_company_idx
  ON guard_password_audit_events (company_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_guard_password_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Guard password audit events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS guard_password_audit_immutable_trigger
  ON guard_password_audit_events;
CREATE TRIGGER guard_password_audit_immutable_trigger
  BEFORE UPDATE OR DELETE ON guard_password_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_guard_password_audit_mutation();
