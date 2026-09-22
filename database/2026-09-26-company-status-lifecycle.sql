ALTER TABLE admin_sessions
  DROP CONSTRAINT IF EXISTS admin_sessions_session_end_reason_check;

ALTER TABLE admin_sessions
  ADD CONSTRAINT admin_sessions_session_end_reason_check CHECK (
    session_end_reason IS NULL OR session_end_reason IN (
      'logout',
      'temporary_access_expired',
      'temporary_access_revoked',
      'authorization_changed',
      'password_reset',
      'company_inactive'
    )
  );

CREATE TABLE IF NOT EXISTS company_status_audit_events (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  previous_status VARCHAR(24) NOT NULL,
  new_status VARCHAR(24) NOT NULL,
  changed_by INTEGER NOT NULL REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT company_status_audit_value_chk CHECK (
    previous_status IN ('active', 'pilot', 'inactive')
    AND new_status IN ('active', 'pilot', 'inactive')
    AND previous_status <> new_status
  )
);

CREATE INDEX IF NOT EXISTS company_status_audit_company_idx
  ON company_status_audit_events(company_id, changed_at DESC);

CREATE OR REPLACE FUNCTION prevent_company_status_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Company status audit events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS company_status_audit_immutable_trigger
  ON company_status_audit_events;
CREATE TRIGGER company_status_audit_immutable_trigger
  BEFORE UPDATE OR DELETE ON company_status_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_company_status_audit_mutation();

ALTER TABLE random_patrol_days
  DROP CONSTRAINT IF EXISTS random_patrol_day_generation_type_chk;
ALTER TABLE random_patrol_days
  ADD CONSTRAINT random_patrol_day_generation_type_chk CHECK (
    generation_type IN ('full_day', 'partial_first_day', 'partial_reactivation')
  );
